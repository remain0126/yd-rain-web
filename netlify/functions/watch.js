// netlify/functions/watch.js
// 1분마다 외부 스케줄러(cron-job.org)가 호출한다. 두 가지 일을 한다.
//
//   1) 강우 자료가 오래됐으면 새로 수집한다 (무료 플랜에서 예약 함수가 안 도는 문제 보완)
//   2) 상황을 판정해 조건에 맞으면 구독자에게 푸시를 보낸다
//
// 발송 규칙 (확정)
//   - 관심단계 이상이거나 기상특보가 바뀌면 발송
//   - 1분 간격으로 15회까지 몰아친 뒤, 그래도 미확인이면 10분 간격으로 계속
//   - 알림의 "확인"을 누른 사람은 그 상황에 대해 중단
//   - 단계가 오르면 확인이 무효가 되고 1분 몰아치기를 다시 시작
//   - 상황이 끝나면 해제 알림을 1회 보낸다

const { buildData } = require("./_build");
const { getWarning } = require("./_warning");
const { readSubs, writeSubs, sendMany, configured } = require("./_push");

const STORE_NAME = "rainfall-history";
const WATCH_KEY = "watch-state";

const BURST_COUNT = 15; // 1분 간격으로 몰아치는 횟수
const BURST_MS = 60 * 1000; // 몰아치는 동안의 간격
const SLOW_MS = 10 * 60 * 1000; // 그 이후 간격
const REFRESH_AFTER_MS = 4.5 * 60 * 1000; // 자료가 이만큼 묵으면 새로 수집

const RANK = { extreme: 0, critical: 1, high: 2, low: 3, normal: 4 };
const ALERT_FROM = RANK.low; // 관심단계부터 발송

function blobStore(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && typeof blobs.connectLambda === "function") blobs.connectLambda(event);
    return blobs.getStore(STORE_NAME);
  } catch (_) {
    return null;
  }
}

function rainStore(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && typeof blobs.connectLambda === "function") blobs.connectLambda(event);
    return blobs.getStore("rainfall");
  } catch (_) {
    return null;
  }
}

// ---------- 상황 판정 ----------

/**
 * 스냅샷과 특보를 합쳐 지금 상황을 요약한다.
 */
function assess(snap, warn) {
  const rows = (snap && snap.rows) || {};

  let level = "normal";
  let worstName = null;
  let worst = null;

  for (const [name, r] of Object.entries(rows)) {
    if (!r || !r.risk_key) continue;
    const rk = RANK[r.risk_key];
    if (rk == null) continue;
    if (RANK[level] == null || rk < RANK[level]) {
      level = r.risk_key;
      worstName = name;
      worst = r;
    }
  }

  // 기상청 특보가 자체 계산보다 높으면 특보를 따른다
  let kmaLabel = null;
  if (warn && warn.ok && warn.level_key && RANK[warn.level_key] < RANK[level]) {
    level = warn.level_key;
    kmaLabel = warn.level_label;
  }

  const warnings = warn && warn.ok && Array.isArray(warn.all) ? warn.all.slice().sort() : [];

  return {
    level,
    rank: RANK[level],
    label: kmaLabel || (worst && worst.risk_label) || "양호",
    worstName,
    mm1: worst ? worst.recent_1h_mm : 0,
    mm3: worst ? worst.recent_3h_mm : 0,
    mm12: worst ? worst.recent_12h_mm : 0,
    warnings,
    // 상태키: 단계나 특보가 바뀌면 새 상황으로 보고 확인이 무효가 된다
    key: `${level}|${warnings.join(",")}`,
  };
}

function buildPayload(now, prev) {
  const parts = [];
  if (now.worstName && now.rank <= ALERT_FROM) {
    parts.push(`${now.worstName} 1시간 ${now.mm1}mm · 3시간 ${now.mm3}mm`);
  }
  if (now.warnings.length) parts.push("기상특보 " + now.warnings.join(" · "));

  const rising = !prev || now.rank < prev.rank;

  return {
    title: `영덕군 ${now.label}${rising && prev && prev.rank < 4 ? " (단계 상향)" : ""}`,
    body: parts.join("\n") || "상황을 확인해 주세요.",
    tag: "yd-rain-alert",
    url: "/",
    sticky: now.rank <= RANK.critical, // 경보급 이상은 손으로 닫을 때까지 남는다
    key: now.key,
    level: now.level,
  };
}

// ---------- 발송 ----------

async function dispatch(now, prev, event) {
  if (!configured()) return { skipped: "VAPID 미설정" };

  const subs = await readSubs(event);
  if (!subs.length) return { skipped: "구독자 없음" };

  const t = Date.now();
  const targets = [];

  for (const s of subs) {
    const ack = (s.ack && s.ack[now.key]) || null;
    if (ack) continue; // 이미 확인함

    const rec = (s.sent && s.sent[now.key]) || { count: 0, at: 0 };
    const gap = rec.count < BURST_COUNT ? BURST_MS : SLOW_MS;
    // 첫 발송은 즉시, 이후에는 간격이 지나야 발송
    if (rec.count > 0 && t - rec.at < gap - 5000) continue;

    targets.push({ sub: s, rec });
  }

  if (!targets.length) return { skipped: "발송 대상 없음", subs: subs.length };

  const payload = buildPayload(now, prev);
  const res = await sendMany(targets.map((x) => x.sub), payload, event);

  // 발송 기록 갱신 (오래된 상태키는 정리해 용량이 늘지 않게 한다)
  const fresh = await readSubs(event);
  for (const s of fresh) {
    const hit = targets.find((x) => x.sub.endpoint === s.endpoint);
    if (!hit) continue;
    s.sent = { [now.key]: { count: (hit.rec.count || 0) + 1, at: t } };
    if (s.ack) s.ack = Object.fromEntries(Object.entries(s.ack).filter(([k]) => k === now.key));
  }
  await writeSubs(fresh, event);

  return { ...res, targets: targets.length, subs: subs.length };
}

async function dispatchClear(prev, event) {
  if (!configured()) return { skipped: "VAPID 미설정" };
  const subs = await readSubs(event);
  if (!subs.length) return { skipped: "구독자 없음" };

  const res = await sendMany(
    subs,
    {
      title: "영덕군 상황 해제",
      body: `${prev.label} 상황이 종료되었습니다.`,
      tag: "yd-rain-alert",
      url: "/",
      key: "clear",
    },
    event
  );

  // 새 상황을 위해 기록을 비운다
  const fresh = await readSubs(event);
  for (const s of fresh) {
    s.sent = {};
    s.ack = {};
  }
  await writeSubs(fresh, event);
  return res;
}

// ---------- 진입점 ----------

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};

  // 외부에서 아무나 부르지 못하게 토큰으로 막는다
  const need = process.env.WATCH_TOKEN;
  if (need && q.token !== need) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: "인증 실패" }) };
  }

  const log = { at: new Date().toISOString() };

  try {
    // 1) 강우 자료가 묵었으면 새로 수집
    const rs = rainStore(event);
    let snap = null;
    try {
      snap = rs ? await rs.get("latest", { type: "json" }) : null;
    } catch (_) {}

    const age = snap && snap.stored_at ? Date.now() - new Date(snap.stored_at).getTime() : Infinity;
    if (age >= REFRESH_AFTER_MS) {
      try {
        snap = await buildData(true, event);
        log.refreshed = true;
      } catch (e) {
        log.refresh_error = String(e && e.message);
      }
    }

    // 2) 특보 확인
    const warn = await getWarning(true, 5000, event).catch(() => null);

    // 3) 상황 판정
    const now = assess(snap, warn);
    log.level = now.level;
    log.warnings = now.warnings;

    const store = blobStore(event);
    let prev = null;
    try {
      prev = store ? await store.get(WATCH_KEY, { type: "json" }) : null;
    } catch (_) {}

    // 4) 발송 판단
    const active = now.rank <= ALERT_FROM || now.warnings.length > 0;
    const wasActive = prev && (prev.rank <= ALERT_FROM || (prev.warnings || []).length > 0);

    if (active) {
      log.dispatch = await dispatch(now, prev, event);
    } else if (wasActive) {
      log.dispatch = await dispatchClear(prev, event);
      log.cleared = true;
    } else {
      log.dispatch = { skipped: "평상시" };
    }

    if (store) {
      try {
        await store.setJSON(WATCH_KEY, { ...now, saved_at: new Date().toISOString() });
      } catch (_) {}
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      body: JSON.stringify({ ok: true, ...log }, null, 2),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e), ...log }),
    };
  }
};
