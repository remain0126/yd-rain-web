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
    visits: { total: 0, byHour: new Array(24).fill(0), uniq: [] },
    // 푸시 집계.
    // events는 알림 건별 기록이다. 하루 단위 파일이므로 자정에 저절로 0에서 시작한다.
    //   { "<건 번호>": { kind, title, at, sent, acked } }
    push: { sent: 0, acked: 0, subscribers: 0, byType: {}, events: {} },
    // 단계·특보 변화 기록
    events: [],
    updated_at: new Date().toISOString(),
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
  day.updated_at = new Date().toISOString();
  try {
    await store.setJSON(DAY_KEY, day);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- 기록 ----------

/**
 * 감시 1회분을 기록한다. watch.js가 매분 호출한다.
 */
async function recordWatch({ snap, warn, level, dispatch, subscribers, acked }, event) {
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
  if (typeof acked === "number") day.push.acked = acked;

  // 단계·특보 변화만 사건으로 남긴다 (매분 기록하면 파일이 커진다)
  const last = day.events[day.events.length - 1];
  const nowSig = `${level}|${(warn && warn.all ? warn.all : []).join(",")}`;
  if (!last || last.sig !== nowSig) {
    day.events.push({
      at: new Date().toISOString(),
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
 * @param {string} visitorId 브라우저별 임의 식별자 (개인정보 아님)
 */
async function recordVisit(visitorId, event) {
  const day = await readDay(event);
  const h = kstHour();

  day.visits.total += 1;
  day.visits.byHour[h] += 1;
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
  day.push.events[eid] = {
    kind: (meta && meta.kind) || "",
    title: (meta && meta.title) || "",
    at: new Date().toISOString(),
    sent: Number(sent) || 0,
    acked: 0,
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
    day.push.events[eid] = { kind: "", title: "", at: new Date().toISOString(), sent: 0, acked: 0 };
  }
  day.push.events[eid].acked += 1;
  await writeDay(day, event);
  return day.push.events[eid].acked;
}

module.exports = {
  recordWatch,
  recordVisit,
  recordDispatch,
  recordAck,
  flushToday,
  readDay,
  kstDate,
  configured: () => !!process.env.GITHUB_TOKEN,
};
