// netlify/functions/watch.js
// 1분마다 외부 스케줄러(cron-job.org)가 호출한다. 두 가지 일을 한다.
//
//   1) 강우 자료가 오래됐으면 백그라운드 수집을 걸어둔다
//      (직접 수집하지 않는다. 영덕군청 페이지는 응답에 1~2분이 걸릴 때가 있는데
//       이 함수는 10초 안에 끝나야 하므로 스스로 받으면 거의 끊긴다.
//       기다릴 수 있는 refresh-background에 넘기고, 저장된 최신값으로 판정한다)
//   2) 상황을 판정해 조건에 맞으면 구독자에게 푸시를 보낸다
//
// 발송 규칙 (확정)
//   - 관심단계 이상이거나 기상특보가 바뀌면 발송
//   - 1분 간격으로 15회까지 몰아친 뒤, 그래도 미확인이면 10분 간격으로 계속
//   - 알림의 "확인"을 누른 사람은 그 상황에 대해 중단
//   - 단계가 오르면 확인이 무효가 되고 1분 몰아치기를 다시 시작
//   - 상황이 끝나면 해제 알림을 1회 보낸다

const { getWarning } = require("./_warning");
const { readSubs, writeSubs, sendMany, configured } = require("./_push");
const logbook = require("./_logbook");

const STORE_NAME = "rainfall-history";
const WATCH_KEY = "watch-state";

const BURST_COUNT = 15; // 1분 간격으로 몰아치는 횟수
const BURST_MS = 60 * 1000; // 몰아치는 동안의 간격
const SLOW_MS = 10 * 60 * 1000; // 그 이후 간격
// 매분 수집을 건다. 앞 건이 끝나기를 기다리지 않는다.
// 군청 응답이 1분이면 1분 만에, 2분이면 2분 만에 화면에 뜬다.
// 자료가 이만큼 묵으면 수집을 건다.
//
// 감시는 1분에 한 번만 돈다. 이 값이 55초였을 때, 마침 자료가 50초쯤 됐으면
// 그 분을 건너뛰고 다음 분에야 걸었다. 한 번 거를 때마다 1분이 통째로 밀려
// 자료 나이가 최대 2분까지 벌어졌다.
//
// 20초로 낮추면 매분 빠짐없이 건다. 군청이 빠른 날(20~30초)에는
// 자료 나이가 절반으로 줄고, 느린 날에는 어차피 수집이 돌고 있어 변화가 없다.
const REFRESH_AFTER_MS = 20 * 1000;
const MAX_INFLIGHT = 3; // 동시에 돌릴 수 있는 수집 건수
const INFLIGHT_KEY = "refresh-inflight";
const INFLIGHT_TTL_MS = 5 * 60 * 1000; // 이 시간이 지난 건은 실패로 보고 셈에서 뺀다

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

// ---------- 백그라운드 수집 요청 ----------

function siteBaseUrl(event) {
  const headers = (event && event.headers) || {};
  const host = headers.host || headers.Host;
  const proto = headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

// 수집을 걸어두고 곧바로 돌아온다. 결과를 기다리지 않는다.
//
// 앞 건이 끝나지 않았어도 새로 건다. 군청 응답이 들쭉날쭉하기 때문에,
// 매분 던져두면 먼저 도착한 것부터 화면에 반영된다.
// 다만 무한정 쌓이면 군청에 부담이 되므로 동시 3건까지만 허용한다.
// (오래된 것이 나중에 도착해 새 자료를 덮어쓰는 문제는 refresh-background에서 막는다)
async function requestRefresh(rs, event, snapStoredAt) {
  let inflight = [];

  if (rs) {
    try {
      const cur = await rs.get(INFLIGHT_KEY, { type: "json" });
      if (cur && Array.isArray(cur.list)) inflight = cur.list;
    } catch (_) {}

    const now = Date.now();
    // 시간이 지난 건과 이미 결과가 도착한 건은 셈에서 뺀다
    const snapMs = snapStoredAt ? new Date(snapStoredAt).getTime() : 0;
    inflight = inflight.filter((t) => {
      const ms = new Date(t).getTime();
      if (!Number.isFinite(ms)) return false;
      if (now - ms > INFLIGHT_TTL_MS) return false;
      return ms > snapMs;
    });

    if (inflight.length >= MAX_INFLIGHT) {
      try {
        await rs.setJSON(INFLIGHT_KEY, { list: inflight });
      } catch (_) {}
      return `대기 ${inflight.length}건, 건너뜀`;
    }

    inflight.push(new Date().toISOString());
    try {
      await rs.setJSON(INFLIGHT_KEY, { list: inflight });
    } catch (_) {}
  }

  const baseUrl = siteBaseUrl(event);
  if (!baseUrl) return "주소 확인 불가";

  try {
    const resp = await fetch(`${baseUrl}/.netlify/functions/refresh-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "watch", requested_at: new Date().toISOString() }),
      // 백그라운드 함수는 접수만 하고 끝나므로 오래 기다릴 일이 없다
      signal: AbortSignal.timeout(4000),
    });
    return resp.ok ? `요청함 (대기 ${inflight.length}건)` : `요청 실패 ${resp.status}`;
  } catch (e) {
    return `요청 오류 ${String(e && e.message)}`;
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

  // 기상청 특보가 자체 계산보다 높으면 특보를 따른다.
  // 발표된 즉시 반영한다. 발효를 기다리지 않는다 — 미리 대비하는 편이 낫다.
  let kmaLabel = null;
  if (warn && warn.ok && warn.level_key && RANK[warn.level_key] < RANK[level]) {
    level = warn.level_key;
    kmaLabel = warn.level_label;
  }

  const split = splitWarnings(warn);
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
    // 예고분은 단계와 무관하게 따로 들고 다닌다 (1회 알림 판단용)
    pending: split.pending,
    pendingSig: pendingSig(split.pending),
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

  // 반복을 멈추는 방법을 알림에 명시한다.
  // 알림의 확인 버튼은 기기 상태에 따라 동작하지 않을 수 있으므로 앱을 안내한다.
  lines.push("반복 중지: 이 알림을 눌러 앱에서 [확인]");

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
  let targets = [];

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

  // 보내기 직전에 확인 상태를 한 번 더 읽는다.
  // 판단 시점과 발송 시점 사이(수백 ms~수 초)에 확인을 누른 사람에게
  // 알림이 한 통 더 가는 것을 막기 위함이다.
  let justAcked = 0;
  try {
    const latest = await readSubs(event);
    const ackedNow = new Set(
      latest.filter((s) => s.ackRank != null && now.rank >= s.ackRank).map((s) => s.endpoint)
    );
    const before = targets.length;
    targets = targets.filter((x) => !ackedNow.has(x.sub.endpoint));
    justAcked = before - targets.length;
  } catch (_) {}

  if (!targets.length) {
    return { skipped: "발송 직전 확인됨", just_acked: justAcked, subs: subs.length };
  }

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

  return { ...res, targets: targets.length, just_acked: justAcked, subs: subs.length };
}

// ---------- 특보의 예고와 실행을 나눈다 ----------
//
// 기상청은 미리 발표한다. 10시에 발표하고 12시에 발효하는 식이다.
// 해제도 마찬가지로 며칠 앞서 예고되기도 한다.
//
// 대응은 발표 시점부터 시작한다.
//   발표를 알아챈 즉시 단계를 올리고 반복 알림을 시작한다. 미리 대비하는 편이 낫다.
//
// 다만 발표와 실제 시각이 다르므로 두 번 알린다.
//   발효 — 발표 때 "12:00 발효예정", 12시가 되면 "발효됨"
//   해제 — 예고를 알았을 때 "26일 11:00 해제예정", 11시가 되면 "해제됨"
//   예고를 받고 잊고 있다가 실제 시점을 놓치는 것을 막는다.

// 기상청 시각 문자열(YYYYMMDDHHmm, 한국시각)을 밀리초로 바꾼다
function kmaTmToMs(v) {
  const t = String(v || "");
  if (t.length < 12) return null;
  const ms = Date.UTC(
    Number(t.slice(0, 4)),
    Number(t.slice(4, 6)) - 1,
    Number(t.slice(6, 8)),
    Number(t.slice(8, 10)),
    Number(t.slice(10, 12))
  );
  return Number.isFinite(ms) ? ms - 9 * 3600 * 1000 : null;
}

function fmtWhen(ms) {
  if (!ms) return "";
  const k = new Date(ms + 9 * 3600 * 1000);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][k.getUTCDay()];
  const hh = String(k.getUTCHours()).padStart(2, "0");
  const mi = String(k.getUTCMinutes()).padStart(2, "0");
  return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일(${wd}) ${hh}:${mi}`;
}

/**
 * 특보 목록을 실행분과 예고분으로 나눈다.
 *   effective — 지금 실제로 효력이 있는 특보
 *   pending   — 아직 오지 않은 발효·해제 예정
 */
function splitWarnings(warn) {
  const all = warn && warn.ok && Array.isArray(warn.all) ? warn.all : [];
  const held = (warn && Array.isArray(warn.held) ? warn.held : []).filter((h) => h && h.label);
  const times = (warn && warn.times) || {};
  const now = Date.now();

  const heldMap = new Map(held.map((h) => [h.label, new Date(h.until).getTime()]));
  const effective = [];
  const pending = [];

  for (const label of all) {
    // 해제 예정: 지금은 효력이 있고, 예정 시각에 풀린다
    if (heldMap.has(label)) {
      effective.push(label);
      pending.push({ kind: "해제", label, at: heldMap.get(label) });
      continue;
    }
    // 발효 예정: 발표는 됐지만 발효시각이 아직 오지 않았다
    const ef = kmaTmToMs(times[label] && times[label].tm_ef);
    if (ef && ef > now) {
      pending.push({ kind: "발효", label, at: ef });
      continue;
    }
    effective.push(label);
  }

  pending.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { effective: effective.slice().sort(), pending };
}

// 예고 목록이 바뀌었는지 가리는 지문
function pendingSig(pending) {
  return (pending || []).map((p) => `${p.kind}|${p.label}|${p.at || 0}`).sort().join(";");
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

  // 아직 발효 전인 특보에는 언제 발효되는지 덧붙인다.
  // 그 시각이 되면 발효 알림이 한 번 더 나간다.
  const pendMap = new Map(
    (now.pending || []).filter((p) => p.kind === "발효").map((p) => [p.label, p.at])
  );
  const withWhen = (label) =>
    pendMap.has(label) ? `${label} (${fmtWhen(pendMap.get(label))} 발효예정)` : label;

  const before = gradeMap(prev && prev.warnings);
  const after = gradeMap(now.warnings);

  const up = [], down = [], added = [], removed = [];

  for (const [family, a] of after) {
    const b = before.get(family);
    if (!b) added.push(withWhen(a.label));
    else if (a.grade < b.grade) up.push(`${b.label} → ${withWhen(a.label)}`);
    else if (a.grade > b.grade) down.push(`${b.label} → ${withWhen(a.label)}`);
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

/**
 * 발효시각이 실제로 지났을 때 1회만 알린다.
 *
 * 발표 시점에는 이미 단계가 오르고 반복 알림이 나가고 있다.
 * 이 알림은 "예고했던 그 시각이 됐다"를 알리는 것이라 반복하지 않는다.
 */
async function dispatchEffective(labels, event) {
  if (!configured()) return { skipped: "VAPID 미설정" };
  const subs = await readSubs(event);
  if (!subs.length) return { skipped: "구독자 없음" };

  return sendMany(
    subs,
    {
      title: "영덕군 기상특보 발효",
      body: `${labels.join(" · ")} 발효되었습니다.`,
      tag: `yd-rain-effective-${Date.now()}`,
      group: "yd-rain-warning",
      url: "/",
    },
    event
  );
}

/**
 * 해제 예정이 새로 잡혔을 때 1회만 알린다.
 *
 * 해제는 며칠 앞서 예고되기도 한다. 예고만 알리고 끝내면 실제로 풀리는
 * 순간을 놓치므로, 그 시각이 되면 기존 해제 알림이 한 번 더 나간다.
 */
async function dispatchReleasePending(items, event) {
  if (!configured()) return { skipped: "VAPID 미설정" };
  const subs = await readSubs(event);
  if (!subs.length) return { skipped: "구독자 없음" };

  return sendMany(
    subs,
    {
      title: "영덕군 기상특보 해제예정",
      body: items.map((p) => `${p.label} ${fmtWhen(p.at)} 해제 예정`).join("\n"),
      tag: `yd-rain-release-${Date.now()}`,
      group: "yd-rain-warning",
      url: "/",
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
    log.snap_age_sec = Number.isFinite(age) ? Math.round(age / 1000) : null;
    // 군청이 실제로 몇 초 걸렸는지. 자료가 늦는 원인이 군청인지 우리 주기인지 가른다.
    log.fetch_sec = snap && snap.fetch_elapsed_ms ? Math.round(snap.fetch_elapsed_ms / 1000) : null;
    log.fetched_at = (snap && snap.fetched_at) || null;

    if (age >= REFRESH_AFTER_MS) {
      // 수집은 백그라운드에 맡기고 여기서는 기다리지 않는다.
      // 이번 판정은 저장된 값으로 하고, 새 값은 다음 분에 반영된다.
      log.refresh = await requestRefresh(rs, event, snap && snap.stored_at);
    } else {
      log.refresh = "생략";
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

    // 예고했던 발효시각이 지났는지 본다.
    // 반복 알림과 별개로 1회 보낸다 (반복이 돌고 있어도 이건 따로 나간다).
    const wasPending = ((prev && prev.pending) || []).filter((p) => p.kind === "발효");
    const stillPending = new Set((now.pending || []).map((p) => `${p.kind}|${p.label}`));
    const becameEffective = wasPending
      .filter((p) => !stillPending.has(`발효|${p.label}`))
      .filter((p) => now.warnings.includes(p.label))
      .map((p) => p.label);

    if (becameEffective.length) {
      log.effective_now = becameEffective;
      log.dispatch_effective = await dispatchEffective(becameEffective, event);
    }

    // 해제 예정이 새로 잡혔으면 1회 알린다.
    // 실제로 풀리는 시각에는 목록에서 빠지므로 기존 해제 알림이 따로 나간다.
    const beforePending = new Set(
      ((prev && prev.pending) || []).map((p) => `${p.kind}|${p.label}|${p.at || 0}`)
    );
    const newReleases = (now.pending || []).filter(
      (p) => p.kind === "해제" && !beforePending.has(`해제|${p.label}|${p.at || 0}`)
    );

    if (prev && newReleases.length) {
      log.release_pending = newReleases.map((p) => `${p.label} ${fmtWhen(p.at)}`);
      log.dispatch_release_pending = await dispatchReleasePending(newReleases, event);
    }

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

    log.pending = (now.pending || []).map((p) => `${p.label} ${p.kind} ${fmtWhen(p.at)}`);

    // 알림을 켠 기기 수와 확인 상태 (점검용)
    try {
      const list = await readSubs(event);
      log.subscribers = list.length;
      log.acked = list.filter((s) => s.ackRank != null).length;
      log.ack_ranks = list.map((s) => (s.ackRank == null ? "-" : s.ackRank)).join(",");
      log.ack_tries = list.reduce((n, s) => n + (s.ackCount || 0), 0);
      log.sent_state = list
        .map((s) => (s.sent && s.sent.count != null ? `${s.sent.count}@${s.sent.rank}` : "-"))
        .join(",");
    } catch (_) {}

    if (store) {
      try {
        await store.setJSON(WATCH_KEY, { ...now, saved_at: new Date().toISOString() });
      } catch (_) {}
    }

    // 운영 기록 축적 (실패해도 감시·발송에는 영향 없음)
    try {
      await logbook.recordWatch(
        {
          snap,
          warn,
          level: now.level,
          dispatch: log.dispatch,
          subscribers: log.subscribers,
          acked: log.acked,
        },
        event
      );
      log.logged = true;
    } catch (e) {
      log.log_error = String(e && e.message);
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
