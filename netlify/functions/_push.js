// netlify/functions/_push.js
// 웹 푸시 공용 모듈: VAPID 설정, 구독 명단 보관, 발송.
//
// 구독 명단은 Netlify Blobs에 저장한다. 만료되거나 해지된 구독은 발송 시
// 404/410 응답이 오므로 그때 자동으로 명단에서 제거한다.

const webpush = require("web-push");

const STORE_NAME = "rainfall-history";

// 구독은 사람마다 키를 따로 쓴다 ("subs/<주소해시>").
//
// 예전에는 명단 전체를 배열 하나("push-subscriptions")에 담아두고
// 발송·확인·정리가 모두 그 배열을 통째로 읽고 고쳐 다시 썼다.
// 누가 [확인]을 누른 순간에 발송이 겹치면 확인 기록이 통째로 덮여
// 알림이 다시 울렸다. (그래서 clear_ack 수동 복구가 필요했다)
//
// @netlify/blobs 8.x에는 조건부 쓰기(onlyIfMatch)가 없어 CAS로는 못 막는다.
// 사람마다 키를 나누면 서로 다른 키를 쓰게 되므로 애초에 겹치지 않는다.
const SUBS_PREFIX = "subs/";
// 예전 형식. 첫 읽기 때 쪼개서 옮기고 지운다.
const SUBS_KEY = "push-subscriptions";

// 가장 최근에 보낸 알림 한 건. 알림을 지우지 않고 앱만 연 경우에도
// "그 알림을 봤다"고 셀 수 있도록 서버가 기억해 둔다.
const LAST_EVENT_KEY = "push-last-event";

// 발송자 신원. 브라우저 푸시 서버가 문제 발생 시 연락할 주소.
const CONTACT = "mailto:yd119@korea.kr";

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

// 강한 읽기 저장소. 기본 읽기는 지역 캐시라 최대 60초 묵은 값이 나온다.
// 확인 상태를 그만큼 늦게 보면 이미 확인한 사람에게 알림이 한 번 더 간다.
// 환경에 따라 강한 읽기 경로가 막혀 있으므로 실패하면 기본 읽기로 내려간다.
function strongStore(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && event !== "auto" && typeof blobs.connectLambda === "function") {
      blobs.connectLambda(event);
    }
    return blobs.getStore({ name: STORE_NAME, consistency: "strong" });
  } catch (_) {
    return null;
  }
}

function subKey(endpoint) {
  const crypto = require("crypto");
  return (
    SUBS_PREFIX +
    crypto.createHash("sha1").update(String(endpoint)).digest("hex").slice(0, 24)
  );
}

async function getSubAt(key, event) {
  const st = strongStore(event);
  if (st) {
    try {
      const v = await st.get(key, { type: "json" });
      if (v) return v;
    } catch (_) {}
  }
  const s = blobStore(event);
  if (!s) return null;
  try {
    return await s.get(key, { type: "json" });
  } catch (_) {
    return null;
  }
}

// 한 번의 함수 실행 안에서 명단을 여러 번 읽는다(발송·집계·정리).
// 매번 전 구독자를 다시 읽으면 요청 수가 몇 배로 뛰므로 잠깐 기억해 둔다.
// 쓰기가 일어나면 즉시 버린다. 확인 상태를 반드시 최신으로 봐야 하는 곳은
// readSubs(event, { fresh: true })로 부른다.
let memo = null;
const MEMO_MS = 3000;
function dropMemo() {
  memo = null;
}

let migrated = false;
async function migrateLegacy(event) {
  if (migrated) return;
  migrated = true;
  const s = blobStore(event);
  if (!s) return;
  try {
    const legacy = await s.get(SUBS_KEY, { type: "json" });
    if (!Array.isArray(legacy) || !legacy.length) return;
    for (const item of legacy) {
      if (!item || !item.endpoint) continue;
      const k = subKey(item.endpoint);
      let exists = null;
      try {
        exists = await s.get(k, { type: "json" });
      } catch (_) {}
      if (!exists) await s.setJSON(k, item);
    }
    await s.delete(SUBS_KEY);
  } catch (_) {}
}

function configured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function setupVapid() {
  if (!configured()) throw new Error("VAPID 키 미설정");
  webpush.setVapidDetails(
    CONTACT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ---------- 구독 명단 ----------

async function readSubs(event, opts) {
  const fresh = !!(opts && opts.fresh);
  if (!fresh && memo && Date.now() - memo.at < MEMO_MS) return memo.list;

  const s = blobStore(event);
  if (!s) return [];
  await migrateLegacy(event);

  let keys = [];
  try {
    const r = await s.list({ prefix: SUBS_PREFIX });
    keys = ((r && r.blobs) || []).map((b) => b.key);
  } catch (_) {
    return memo ? memo.list : [];
  }

  const items = await Promise.all(keys.map((k) => getSubAt(k, event)));
  const list = items.filter((v) => v && v.endpoint);
  memo = { at: Date.now(), list };
  return list;
}

/** 한 사람만 저장한다. 다른 사람의 기록에는 손대지 않는다. */
async function putSub(sub, event) {
  const s = blobStore(event);
  if (!s || !sub || !sub.endpoint) return false;
  try {
    await s.setJSON(subKey(sub.endpoint), sub);
    dropMemo();
    return true;
  } catch (_) {
    return false;
  }
}

/** 한 사람만 지운다. */
async function deleteSub(endpoint, event) {
  const s = blobStore(event);
  if (!s || !endpoint) return false;
  try {
    await s.delete(subKey(endpoint));
    dropMemo();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 한 사람을 읽고-고쳐-쓴다. 이 사람의 키만 건드리므로
 * 같은 시각에 다른 사람에게 일어난 변화를 덮어쓰지 않는다.
 * 없는 구독이면 null.
 */
async function updateSub(endpoint, mutate, event) {
  if (!endpoint) return null;
  const cur = await getSubAt(subKey(endpoint), event);
  if (!cur) return null;
  const next = (await mutate(cur)) || cur;
  const ok = await putSub(next, event);
  return ok ? next : null;
}

/** 전원을 한 사람씩 고친다(해제 처리, 확인표시 일괄 삭제 등). */
async function updateAllSubs(mutate, event) {
  const list = await readSubs(event, { fresh: true });
  let changed = 0;
  for (const s0 of list) {
    const r = await updateSub(s0.endpoint, mutate, event);
    if (r) changed += 1;
  }
  return { changed, total: list.length };
}

/** 명단 전체 삭제 (점검용 reset). */
async function clearAllSubs(event) {
  const list = await readSubs(event, { fresh: true });
  for (const s0 of list) await deleteSub(s0.endpoint, event);
  return list.length;
}

/**
 * 호환용. 목록을 통째로 넘기면 개별 키로 나눠 저장하고,
 * 목록에 없는 사람은 지운다.
 *
 * 통째로 쓰는 방식 자체가 경합의 원인이므로 새 코드에서는 쓰지 말고
 * putSub / updateSub / updateAllSubs를 쓴다.
 */
async function writeSubs(list, event) {
  const cur = await readSubs(event, { fresh: true });
  const keep = new Set((list || []).map((s0) => s0 && s0.endpoint).filter(Boolean));
  for (const c of cur) {
    if (!keep.has(c.endpoint)) await deleteSub(c.endpoint, event);
  }
  for (const s0 of list || []) await putSub(s0, event);
  return true;
}

/**
 * 구독 등록(있으면 갱신).
 * @param {object} sub 브라우저가 만든 PushSubscription
 * @param {string} label 사용자가 적은 이름(선택)
 */
async function addSub(sub, label, event, vid) {
  if (!sub || !sub.endpoint) throw new Error("구독 정보 없음");
  const list = await readSubs(event, { fresh: true });

  // 같은 기기가 남긴 예전 구독을 지운다.
  //
  // 알림을 껐다 켜면 새 구독 주소가 발급되는데, 예전 주소도 살아 있어
  // 같은 휴대전화에 알림이 두 번 간다. 브라우저마다 갖고 있는 식별자로
  // 같은 기기임을 알아내 예전 것을 지운다.
  // (앱을 지웠다 다시 깔면 식별자도 새로 생기므로 이 방법으로는 못 잡는다)
  let dropped = 0;
  if (vid) {
    for (const s0 of list) {
      if (s0.vid === vid && s0.endpoint !== sub.endpoint) {
        await deleteSub(s0.endpoint, event);
        dropped += 1;
      }
    }
  }

  // 기존 기록을 통째로 이어받는다.
  // 여기서 항목을 새로 만들면 확인 상태(ackRank)나 발송 횟수가 사라져,
  // 앱을 다시 열 때마다 반복 알림이 처음부터 되살아난다.
  const prev = list.find((s0) => s0.endpoint === sub.endpoint) || {};
  const isNew = !prev.endpoint;

  const entry = {
    ...prev,
    endpoint: sub.endpoint,
    keys: sub.keys,
    label: label || prev.label || "",
    vid: vid || prev.vid || null,
    created_at: prev.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // 이 기기가 마지막으로 살아 있음을 알린 시각.
    // 앱을 열 때마다 갱신되며, 오래 조용하면 정리 대상이 된다.
    seen_at: new Date().toISOString(),
  };

  await putSub(entry, event);
  return { count: list.length - dropped + (isNew ? 1 : 0), isNew, dropped };
}

async function removeSub(endpoint, event) {
  const before = await readSubs(event, { fresh: true });
  const had = before.some((s0) => s0.endpoint === endpoint);
  if (had) await deleteSub(endpoint, event);
  return { removed: had ? 1 : 0, count: before.length - (had ? 1 : 0) };
}

// ---------- 발송 ----------

/**
 * 한 구독에게 발송. 만료된 구독이면 gone=true를 반환한다.
 */
async function sendOne(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      { TTL: 600, urgency: "high" }
    );
    return { ok: true };
  } catch (e) {
    const code = e && e.statusCode;
    // 404/410 = 구독이 사라짐 → 명단에서 제거해야 한다
    return { ok: false, gone: code === 404 || code === 410, status: code, message: String(e && e.message) };
  }
}

/**
 * 여러 구독에 발송하고, 사라진 구독은 명단에서 정리한다.
 */
// 최근 보낸 알림 기록
async function setLastEvent(info, event) {
  const store = blobStore(event);
  if (!store) return false;
  try {
    await store.setJSON(LAST_EVENT_KEY, { ...info, at: new Date().toISOString() });
    return true;
  } catch (_) {
    return false;
  }
}

async function getLastEvent(event) {
  const store = blobStore(event);
  if (!store) return null;
  try {
    return await store.get(LAST_EVENT_KEY, { type: "json" });
  } catch (_) {
    return null;
  }
}

// 버려진 구독을 정리한다.
//
// 앱을 지웠다 다시 깔거나 알림을 껐다 켜면 새 구독 주소가 발급되고,
// 예전 주소는 그대로 남는다. 서버는 주소가 다르면 다른 기기로 보므로
// 같은 휴대전화에 같은 알림이 두 번 간다.
//
// 버려진 구독은 앱이 열리지 않아 생존 신호가 끊긴다.
// 일정 기간 조용하면 지운다. 발송 실패로 걸러지는 것과 달리,
// 아직 살아 있는 주소라도 쓰지 않으면 정리된다.
//
// 15일로 잡았다. 짧게 잡으면 며칠 앱을 안 연 사람의 알림이 끊기는데,
// 본인은 알림이 안 오는 것을 알아챌 방법이 없어 조용히 누락된다.
// 중복 알림보다 누락이 더 나쁘다. 중복은 설치앱 전용 정책과
// 기기별 정리로 이미 막고 있으므로, 만료는 넉넉히 둔다.
const STALE_DAYS = 15;

function seenTime(s) {
  const t = s.seen_at || s.ackAt || s.updated_at || s.created_at;
  const ms = t ? new Date(t).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

async function pruneStale(event) {
  const list = await readSubs(event);
  if (!list.length) return { removed: 0, count: 0 };

  const cut = Date.now() - STALE_DAYS * 24 * 3600 * 1000;
  const drop = list.filter((s) => seenTime(s) < cut);
  for (const s of drop) await deleteSub(s.endpoint, event);

  return { removed: drop.length, count: list.length - drop.length };
}

async function sendMany(targets, payload, event) {
  setupVapid();

  // 알림이 나갈 때마다 버려진 구독을 함께 정리한다.
  // 하루 한 번만 돌면 그 사이 중복 알림이 계속 나가므로, 발송 시점에 맞춘다.
  try {
    await pruneStale(event);
  } catch (_) {}

  // 알림마다 번호를 붙인다. 확인 신호가 이 번호를 들고 돌아오므로
  // "어느 알림을 몇 명이 봤는지"를 건별로 셀 수 있다.
  const eid = payload.eid || `${payload.kind || "evt"}-${Date.now().toString(36)}`;
  payload = { ...payload, eid };

  const results = await Promise.all(targets.map((s) => sendOne(s, payload)));

  const gone = targets.filter((_, i) => results[i].gone).map((s) => s.endpoint);
  for (const ep of gone) await deleteSub(ep, event);

  const sent = results.filter((r) => r.ok).length;
  const okEndpoints = targets.filter((_, i) => results[i].ok).map((s) => s.endpoint);
  if (sent) {
    await setLastEvent({ eid, kind: payload.kind || "", title: payload.title || "", sent }, event);
  }

  return {
    eid,
    sent,
    okEndpoints,
    failed: results.filter((r) => !r.ok && !r.gone).length,
    cleaned: gone.length,
    errors: results.filter((r) => !r.ok && !r.gone).map((r) => `${r.status} ${r.message}`),
  };
}

module.exports = {
  configured,
  readSubs,
  writeSubs,
  putSub,
  deleteSub,
  updateSub,
  updateAllSubs,
  clearAllSubs,
  addSub,
  removeSub,
  sendMany,
  pruneStale,
  setLastEvent,
  getLastEvent,
  SUBS_KEY,
  SUBS_PREFIX,
};
