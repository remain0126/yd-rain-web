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
  let elevatedCount = 0; // 관심단계 이상인 지점 수 (상황 규모 파악용)

  for (const [name, r] of Object.entries(rows)) {
    if (!r || !r.risk_key) continue;
    const rk = RANK[r.risk_key];
    if (rk == null) continue;
    if (rk <= ALERT_FROM) elevatedCount++;
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
    // 자체 강우 계산만의 단계. 비가 안 오는데 지점 수치를 알림에 붙이지 않기 위해 따로 둔다.
    selfRank: worst ? RANK[worst.risk_key] : RANK.normal,
    elevatedCount,
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

// 지점명을 알림용으로 다듬는다: "옥계_상옥" → "옥계 상옥"
function prettyName(name) {
  return String(name || "").replace(/_/g, " ");
}

// 소수점이 붙지 않게 정리한다: 31.0 → 31, 9.5 → 9.5
function mm(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function buildPayload(now, prev, seq) {
  const lines = [];

  if (now.worstName && now.selfRank <= ALERT_FROM) {
    // 관측 지점 정보. 여러 곳이 동시에 위험하면 규모를 함께 알린다.
    let line = `${prettyName(now.worstName)} 1h ${mm(now.mm1)} · 3h ${mm(now.mm3)}mm`;
    if (now.elevatedCount > 1) line += `  (외 ${now.elevatedCount - 1}개소 관심단계↑)`;
    lines.push(line);
    if (now.warnings.length) lines.push("기상특보 " + now.warnings.join(" · "));
  } else if (now.warnings.length) {
    // 비는 안 오는데 특보로 단계가 올라간 경우 — 왜 알림이 왔는지 한 줄로 밝힌다
    lines.push("관내 강우 없음 · 기상특보 " + now.warnings.join(" · "));
  }

  // 몇 번째 알림인지 표시해 남은 반복을 가늠할 수 있게 한다
  const counter = seq && seq <= BURST_COUNT ? ` (${seq}/${BURST_COUNT})` : "";

  return {
    title: `영덕군 ${now.label}${counter}`,
    body: lines.join("\n") || "상황을 확인해 주세요.",
    tag: `yd-rain-alert-${Date.now()}`,
    group: "yd-rain-alert",
    url: "/",
    sticky: now.rank <= RANK.critical,
    key: now.key,
    level: now.level,
    rank: now.rank,
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
    // 확인은 "이 심각도까지는 봤다"로 기억한다.
    // 특보 목록이 바뀌어도 무효가 되지 않고, 단계가 더 나빠질 때만 다시 울린다.
    if (s.ackRank != null && now.rank >= s.ackRank) continue;

    const prevRec = s.sent && typeof s.sent === "object" && s.sent.count != null ? s.sent : null;
    // 단계가 나빠졌으면 몰아치기를 처음부터 다시 시작한다
    const worse = !prevRec || prevRec.rank == null || now.rank < prevRec.rank;
    const rec = worse ? { count: 0, at: 0, rank: now.rank } : prevRec;

    const gap = rec.count < BURST_COUNT ? BURST_MS : SLOW_MS;
    // 첫 발송은 즉시, 이후에는 간격이 지나야 발송
    if (rec.count > 0 && t - rec.at < gap - 5000) continue;

    targets.push({ sub: s, rec });
  }

  if (!targets.length) return { skipped: "발송 대상 없음", subs: subs.length };

  // 순번(n/15)은 사람마다 다르므로 같은 순번끼리 묶어 보낸다
  const groups = new Map();
  for (const x of targets) {
    const seq = (x.rec.count || 0) + 1;
    if (!groups.has(seq)) groups.set(seq, []);
    groups.get(seq).push(x.sub);
  }

  const res = { sent: 0, failed: 0, cleaned: 0, errors: [] };
  for (const [seq, list] of groups) {
    const r = await sendMany(list, buildPayload(now, prev, seq), event);
    res.sent += r.sent || 0;
    res.failed += r.failed || 0;
    res.cleaned += r.cleaned || 0;
    if (r.errors && r.errors.length) res.errors.push(...r.errors);
  }

  // 발송 기록 갱신 (오래된 상태키는 정리해 용량이 늘지 않게 한다)
  const fresh = await readSubs(event);
  for (const s of fresh) {
    const hit = targets.find((x) => x.sub.endpoint === s.endpoint);
    if (!hit) continue;
    s.sent = { count: (hit.rec.count || 0) + 1, at: t, rank: now.rank };
    // 여기까지 왔다는 건 확인 상태가 아니거나 상황이 더 나빠졌다는 뜻이므로 확인을 푼다
    delete s.ackRank;
    delete s.ack;
  }
  await writeSubs(fresh, event);

  return { ...res, targets: targets.length, subs: subs.length };
}

// 특보 이름을 계열과 등급으로 나눈다.
//   폭염중대경보 → { family: "폭염", grade: 0 }
//   폭염경보     → { family: "폭염", grade: 1 }
//   폭염주의보   → { family: "폭염", grade: 2 }
// grade 숫자가 작을수록 심각하다.
function parseGrade(label) {
  if (/중대경보$/.test(label)) return { family: label.replace(/중대경보$/, ""), grade: 0 };
  if (/경보$/.test(label)) return { family: label.replace(/경보$/, ""), grade: 1 };
  if (/주의보$/.test(label)) return { family: label.replace(/주의보$/, ""), grade: 2 };
  return { family: label, grade: 9 };
}

function gradeMap(list) {
  const m = new Map();
  for (const label of list || []) {
    const g = parseGrade(label);
    // 같은 계열이 여럿이면 더 심각한 쪽을 남긴다
    const cur = m.get(g.family);
    if (!cur || g.grade < cur.grade) m.set(g.family, { ...g, label });
  }
  return m;
}

/**
 * 특보 목록이 바뀌었을 때 1회만 알린다(폭염·한파 등 포함). 반복하지 않는다.
 * 같은 계열 안에서 등급이 오르내린 경우에는 상향·하향으로 구분해 알린다.
 */
async function dispatchWarningChange(now, prev, event) {
  if (!configured()) return { skipped: "VAPID 미설정" };
  const subs = await readSubs(event);
  if (!subs.length) return { skipped: "구독자 없음" };

  const before = gradeMap(prev && prev.warnings);
  const after = gradeMap(now.warnings);

  const up = [], down = [], added = [], removed = [];

  for (const [family, a] of after) {
    const b = before.get(family);
    if (!b) added.push(a.label);
    else if (a.grade < b.grade) up.push(`${b.label} → ${a.label}`);
    else if (a.grade > b.grade) down.push(`${b.label} → ${a.label}`);
  }
  for (const [family, b] of before) {
    if (!after.has(family)) removed.push(b.label);
  }

  const lines = [];
  if (up.length) lines.push("상향 " + up.join(" · "));
  if (added.length) lines.push("발효 " + added.join(" · "));
  if (down.length) lines.push("하향 " + down.join(" · "));
  if (removed.length) lines.push("해제 " + removed.join(" · "));
  if (!lines.length) return { skipped: "변동 없음" };

  const title = up.length
    ? "영덕군 기상특보 상향"
    : added.length
      ? "영덕군 기상특보 발효"
      : down.length
        ? "영덕군 기상특보 하향"
        : removed.length
          ? "영덕군 기상특보 해제"
          : "영덕군 기상특보 변동";

  return sendMany(
    subs,
    {
      title,
      body: lines.join("\n"),
      tag: `yd-rain-warning-${Date.now()}`,
      group: "yd-rain-warning",
      url: "/",
      // key를 넣지 않으면 확인 버튼이 붙지 않는다(반복하지 않으므로 불필요)
    },
    event
  );
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
      tag: `yd-rain-alert-${Date.now()}`,
      group: "yd-rain-alert",
      url: "/",
      key: "clear",
    },
    event
  );

  // 새 상황을 위해 기록을 비운다
  const fresh = await readSubs(event);
  for (const s of fresh) {
    s.sent = {};
    delete s.ackRank;
    delete s.ack;
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
    //    - 관심단계 이상: 반복 알림(1분×15회 → 10분 간격)
    //    - 특보 목록 변동: 1회 알림 (폭염·한파 등 반복 대상이 아닌 특보 포함)
    const active = now.rank <= ALERT_FROM;
    const wasActive = !!(prev && prev.rank <= ALERT_FROM);
    const prevWarnings = (prev && prev.warnings) || [];
    const warningsChanged =
      !!prev && JSON.stringify(prevWarnings.slice().sort()) !== JSON.stringify(now.warnings);

    if (active) {
      log.dispatch = await dispatch(now, prev, event);
    } else if (wasActive) {
      log.dispatch = await dispatchClear(prev, event);
      log.cleared = true;
    } else if (warningsChanged) {
      log.dispatch = await dispatchWarningChange(now, prev, event);
      log.warning_change = true;
    } else {
      log.dispatch = { skipped: "평상시" };
    }

    // 알림을 켠 기기 수는 상황과 무관하게 항상 알려준다
    try {
      log.subscribers = (await readSubs(event)).length;
    } catch (_) {}

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
