// netlify/functions/_logbook.js
// 일자별 운영 기록을 GitHub 저장소에 파일로 쌓는다.
//
// 왜 GitHub인가
//   Netlify 저장소(Blobs)는 계정에 묶여 있어, 요금제나 계정이 바뀌면 자료가 사라진다.
//   로그는 훗날 분석에 쓰일 자산이므로 소스와 함께 저장소에 남긴다.
//
// 쌓는 방식
//   하루 단위로 메모리(Blobs)에 모았다가, 날짜가 바뀔 때 GitHub에 파일 하나로 커밋한다.
//   매분 커밋하면 저장소 이력이 지저분해지고 API 한도에 걸린다.
//
// 파일 구조
//   logs/2026/2026-08-21.json
//
// 보관
//   1년(365일)치를 유지하고, 그보다 오래된 파일은 자동 삭제한다.
//
// 커밋 메시지의 [skip ci]
//   로그 커밋도 같은 저장소에 들어가므로, 그대로 두면 Netlify가 매번 다시 빌드한다.
//   빌드 크레딧이 헛되이 소모되므로 로그 커밋은 빌드를 건너뛰게 한다.

const OWNER = process.env.GITHUB_OWNER || "remain0126";
const REPO = process.env.GITHUB_REPO || "yd-rain-web";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const API = "https://api.github.com";

const STORE_NAME = "rainfall-history";
const DAY_KEY = "logbook-today"; // 오늘치 누적 (아직 커밋 전)

const KEEP_DAYS = 365;

function blobStore(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && event !== "auto" && typeof blobs.connectLambda === "function") {
      blobs.connectLambda(event);
    }
    return blobs.getStore(STORE_NAME);
  } catch (_) {
    return null;
  }
}

// 한국 시각 기준 날짜 (YYYY-MM-DD)
function kstDate(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  return k.toISOString().slice(0, 10);
}

// 한국 시각 기준 시(0~23)
function kstHour(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600 * 1000).getUTCHours();
}

// 기록에 남기는 시각. 한국 시각으로 적어 그대로 읽을 수 있게 한다.
// (예전 기록은 세계표준시로 적혀 있어 9시간을 더해 읽어야 했다)
function kstStamp(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ` +
    `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}`
  );
}

// ---------- GitHub ----------

function ghHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN 미설정");
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "yd-rain-logbook",
  };
}

async function ghGet(path) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: ghHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub 조회 실패 ${res.status}`);
  return res.json();
}

async function ghPut(path, contentObj, message) {
  const existing = await ghGet(path).catch(() => null);
  const body = {
    message,
    branch: BRANCH,
    content: Buffer.from(JSON.stringify(contentObj, null, 1), "utf-8").toString("base64"),
  };
  if (existing && existing.sha) body.sha = existing.sha;

  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub 저장 실패 ${res.status}`);
  return res.json();
}

async function ghDelete(path, sha, message) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "DELETE",
    headers: ghHeaders(),
    body: JSON.stringify({ message, branch: BRANCH, sha }),
  });
  return res.ok;
}

// 1년이 지난 로그를 정리한다 (연 단위 폴더를 훑는다)
async function pruneOld() {
  const limit = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000);
  const limitStr = kstDate(limit);
  const year = limitStr.slice(0, 4);

  let list = null;
  try {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/logs/${year}?ref=${BRANCH}`, {
      headers: ghHeaders(),
    });
    if (!res.ok) return 0;
    list = await res.json();
  } catch (_) {
    return 0;
  }
  if (!Array.isArray(list)) return 0;

  let removed = 0;
  for (const f of list) {
    const day = String(f.name || "").replace(".json", "");
    if (day && day < limitStr) {
      if (await ghDelete(f.path, f.sha, `chore: 보관기간 경과 로그 삭제 ${day} [skip ci]`)) removed++;
    }
  }
  return removed;
}

// ---------- 하루치 누적 ----------

function emptyDay(date) {
  return {
    date,
    // 시간대별 강우 (지점별 배열, 인덱스 = 0~23시)
    rain: {},
    // 접속 집계
    //   total  — 호출 전체 (1분 자동 갱신 포함)
    //   entries— 사람이 실제로 들어온 횟수 (첫 진입·새로고침·화면 복귀)
    visits: {
      total: 0,
      entries: 0,
      byHour: new Array(24).fill(0),
      byHourEntry: new Array(24).fill(0),
      uniq: [],
    },
    // 푸시 집계.
    // events는 알림 건별 기록이다. 하루 단위 파일이므로 자정에 저절로 0에서 시작한다.
    //   { "<건 번호>": { kind, title, at, sent, acked } }
    //   byType    — 알림 종류별 집계 ("특보 변동", "강우 단계" …)
    //   byWarning — 기상현상별 집계 ("강풍", "호우", "태풍" …)
    //               알림 하나에 특보가 여럿이면 각각에 중복으로 센다.
    //               따라서 byWarning 의 합계는 sent 와 일치하지 않는다.
    push: { sent: 0, acked: 0, subscribers: 0, byType: {}, byWarning: {}, events: {} },
    // 단계·특보 변화 기록
    events: [],
    updated_at: kstStamp(),
  };
}

async function readDay(event) {
  const store = blobStore(event);
  const today = kstDate();
  if (!store) return emptyDay(today);
  try {
    const v = await store.get(DAY_KEY, { type: "json" });
    if (v && v.date === today) return v;
    // 날짜가 바뀌었으면 지난 것을 GitHub에 넘기고 새로 시작한다
    if (v && v.date && v.date !== today) {
      try {
        await ghPut(
          `logs/${v.date.slice(0, 4)}/${v.date}.json`,
          v,
          `log: ${v.date} 운영기록 [skip ci]`
        );
        await pruneOld();
      } catch (_) {}
    }
    return emptyDay(today);
  } catch (_) {
    return emptyDay(today);
  }
}

async function writeDay(day, event) {
  const store = blobStore(event);
  if (!store) return false;
  day.updated_at = kstStamp();
  try {
    await store.setJSON(DAY_KEY, day);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- 기록 ----------

// "강풍주의보" -> "강풍", "태풍경보" -> "태풍"
// 등급을 떼어 기상현상만 남긴다. watch.js 의 parseGrade 와 같은 규칙이다.
function warnFamily(label) {
  return String(label || "").replace(/(주의보|경보)$/, "") || String(label || "");
}

// byType / byWarning 의 한 칸을 꺼낸다. 없으면 만든다.
function bucket(map, key) {
  if (!map[key]) map[key] = { sent: 0, acked: 0 };
  return map[key];
}

/**
 * 감시 1회분을 기록한다. watch.js가 매분 호출한다.
 */
async function recordWatch({ snap, warn, level, dispatch, subscribers, dispatches }, event) {
  const day = await readDay(event);
  const h = kstHour();

  // 시간대별 강우 — 지점별로 그 시각 값을 갱신
  const rows = (snap && snap.rows) || {};
  for (const [name, r] of Object.entries(rows)) {
    if (!r) continue;
    if (!day.rain[name]) day.rain[name] = new Array(24).fill(null);
    const v = r["오늘누계"];
    if (v != null) day.rain[name][h] = Number(v);
  }

  // 푸시 집계
  if (dispatch && dispatch.sent) day.push.sent += dispatch.sent;
  if (typeof subscribers === "number") day.push.subscribers = subscribers;
  // acked 는 여기서 건드리지 않는다. recordAck 가 하루 내내 누적한다.
  // 예전에는 매분 덮어썼는데, 상황이 끝나 ackRank 가 지워지면 그날 확인
  // 기록이 통째로 0 으로 밀렸다.

  // 이번에 나간 알림들을 건별로 남긴다. 저장이 한 번뿐이라 덮어쓰기가 없다.
  if (!day.push.byType) day.push.byType = {};
  if (!day.push.byWarning) day.push.byWarning = {};
  if (!day.push.events) day.push.events = {};
  for (const d of dispatches || []) {
    if (!d || !d.eid) continue;
    const prev = day.push.events[d.eid] || {};
    day.push.events[d.eid] = {
      kind: d.kind || prev.kind || "",
      title: d.title || prev.title || "",
      at: prev.at || kstStamp(),
      sent: Number(d.sent) || prev.sent || 0,
      acked: prev.acked || 0,
      // 확인이 들어왔을 때 어느 칸을 올릴지 알아야 한다.
      warnings: Array.isArray(d.warnings) ? d.warnings : prev.warnings || [],
    };
    if (prev.eid_counted) continue;
    bucket(day.push.byType, d.kind || "기타").sent += Number(d.sent) || 0;
    for (const fam of new Set((d.warnings || []).map(warnFamily))) {
      if (fam) bucket(day.push.byWarning, fam).sent += Number(d.sent) || 0;
    }
    day.push.events[d.eid].eid_counted = true;
  }

  // 단계·특보 변화만 사건으로 남긴다 (매분 기록하면 파일이 커진다)
  const last = day.events[day.events.length - 1];
  const nowSig = `${level}|${(warn && warn.all ? warn.all : []).join(",")}`;
  if (!last || last.sig !== nowSig) {
    day.events.push({
      at: kstStamp(),
      sig: nowSig,
      level,
      warnings: (warn && warn.all) || [],
    });
  }

  await writeDay(day, event);
  return day;
}

/**
 * 접속 1건을 기록한다. rainfall.js가 호출한다.
 *
 * total 은 호출 전체(자동 갱신 포함)이고, entries 는 사람이 실제로
 * 들어온 횟수다. 앱을 켜두면 1분마다 자동 갱신이 돌기 때문에 둘을
 * 합쳐 놓으면 기기 한 대가 하루 1,440건을 만들어 이용량을 알 수 없다.
 * byHourEntry 는 entries 의 시간대별 분포다.
 *
 * @param {string} visitorId 브라우저별 임의 식별자 (개인정보 아님)
 * @param {boolean} isEntry  첫 진입·새로고침·화면 복귀면 true
 */
async function recordVisit(visitorId, event, isEntry) {
  const day = await readDay(event);
  const h = kstHour();

  day.visits.total += 1;
  day.visits.byHour[h] += 1;

  // 예전 파일에는 이 칸이 없다. 읽을 때 만들어 준다.
  if (typeof day.visits.entries !== "number") day.visits.entries = 0;
  if (!Array.isArray(day.visits.byHourEntry)) {
    day.visits.byHourEntry = new Array(24).fill(0);
  }
  if (isEntry) {
    day.visits.entries += 1;
    day.visits.byHourEntry[h] += 1;
  }

  if (visitorId && !day.visits.uniq.includes(visitorId)) {
    // 목록이 무한정 커지지 않도록 상한을 둔다
    if (day.visits.uniq.length < 500) day.visits.uniq.push(visitorId);
  }

  await writeDay(day, event);
  return day.visits.total;
}

/**
 * 오늘치를 즉시 GitHub에 저장한다 (점검용 또는 수동 저장).
 */
async function flushToday(event) {
  const day = await readDay(event);
  await ghPut(`logs/${day.date.slice(0, 4)}/${day.date}.json`, day, `log: ${day.date} 운영기록 [skip ci]`);
  return day.date;
}

/**
 * 알림 한 건을 발송했을 때 기록한다.
 */
async function recordDispatch(eid, meta, sent, event) {
  const day = await readDay(event);
  if (!day.push.events) day.push.events = {};

  // 확인 신호가 발송 기록보다 먼저 도착하는 일이 있다.
  // 그때 만들어진 칸을 지우지 않고, 이미 센 확인 수를 지키며 채운다.
  const prev = day.push.events[eid] || {};
  day.push.events[eid] = {
    kind: (meta && meta.kind) || prev.kind || "",
    title: (meta && meta.title) || prev.title || "",
    at: prev.at || kstStamp(),
    sent: Number(sent) || prev.sent || 0,
    acked: prev.acked || 0,
  };
  await writeDay(day, event);
  return day.push.events[eid];
}

/**
 * 그 건을 확인한 사람이 한 명 늘었을 때 기록한다.
 * 같은 기기가 두 번 세지 않도록 거르는 일은 부르는 쪽에서 한다.
 */
async function recordAck(eid, event) {
  const day = await readDay(event);
  if (!day.push.events) day.push.events = {};
  if (!day.push.events[eid]) {
    // 발송 기록보다 확인이 먼저 왔다. 빈 칸을 만들어 두면
    // 뒤이어 오는 발송 기록이 이름과 건수를 채운다.
    day.push.events[eid] = { kind: "", title: "", at: kstStamp(), sent: 0, acked: 0, warnings: [] };
  }
  const rec = day.push.events[eid];
  rec.acked += 1;

  // 하루 누적. 상황이 끝나도 밀리지 않는다.
  day.push.acked = (day.push.acked || 0) + 1;

  // 종류별·현상별 확인 수
  if (!day.push.byType) day.push.byType = {};
  if (!day.push.byWarning) day.push.byWarning = {};
  if (rec.kind) bucket(day.push.byType, rec.kind).acked += 1;
  for (const fam of new Set((rec.warnings || []).map(warnFamily))) {
    if (fam) bucket(day.push.byWarning, fam).acked += 1;
  }

  await writeDay(day, event);
  return rec.acked;
}

/**
 * 오늘 보낸 알림들의 번호 목록.
 * 앱을 열었을 때 아직 확인하지 않은 건을 모두 확인 처리하는 데 쓴다.
 */
async function listTodayEventIds(event) {
  const day = await readDay(event);
  return Object.keys((day.push && day.push.events) || {});
}

module.exports = {
  listTodayEventIds,
  recordWatch,
  recordVisit,
  recordDispatch,
  recordAck,
  flushToday,
  readDay,
  kstDate,
  configured: () => !!process.env.GITHUB_TOKEN,
};
