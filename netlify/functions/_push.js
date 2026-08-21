// netlify/functions/_push.js
// 웹 푸시 공용 모듈: VAPID 설정, 구독 명단 보관, 발송.
//
// 구독 명단은 Netlify Blobs에 저장한다. 만료되거나 해지된 구독은 발송 시
// 404/410 응답이 오므로 그때 자동으로 명단에서 제거한다.

const webpush = require("web-push");

const STORE_NAME = "rainfall-history";
const SUBS_KEY = "push-subscriptions";

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

async function readSubs(event) {
  const store = blobStore(event);
  if (!store) return [];
  try {
    const v = await store.get(SUBS_KEY, { type: "json" });
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

async function writeSubs(list, event) {
  const store = blobStore(event);
  if (!store) return false;
  try {
    await store.setJSON(SUBS_KEY, list);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 구독 등록(있으면 갱신).
 * @param {object} sub 브라우저가 만든 PushSubscription
 * @param {string} label 사용자가 적은 이름(선택)
 */
async function addSub(sub, label, event) {
  if (!sub || !sub.endpoint) throw new Error("구독 정보 없음");
  const list = await readSubs(event);
  const idx = list.findIndex((s) => s.endpoint === sub.endpoint);

  // 기존 기록을 통째로 이어받는다.
  // 여기서 항목을 새로 만들면 확인 상태(ackRank)나 발송 횟수가 사라져,
  // 앱을 다시 열 때마다 반복 알림이 처음부터 되살아난다.
  const prev = idx >= 0 ? list[idx] : {};

  const entry = {
    ...prev,
    endpoint: sub.endpoint,
    keys: sub.keys,
    label: label || prev.label || "",
    created_at: prev.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (idx >= 0) list[idx] = entry;
  else list.push(entry);

  await writeSubs(list, event);
  return { count: list.length, isNew: idx < 0 };
}

async function removeSub(endpoint, event) {
  const list = await readSubs(event);
  const next = list.filter((s) => s.endpoint !== endpoint);
  if (next.length !== list.length) await writeSubs(next, event);
  return { removed: list.length - next.length, count: next.length };
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
async function sendMany(targets, payload, event) {
  setupVapid();
  const results = await Promise.all(targets.map((s) => sendOne(s, payload)));

  const gone = targets.filter((_, i) => results[i].gone).map((s) => s.endpoint);
  if (gone.length) {
    const list = await readSubs(event);
    await writeSubs(list.filter((s) => !gone.includes(s.endpoint)), event);
  }

  return {
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.gone).length,
    cleaned: gone.length,
    errors: results.filter((r) => !r.ok && !r.gone).map((r) => `${r.status} ${r.message}`),
  };
}

module.exports = {
  configured,
  readSubs,
  writeSubs,
  addSub,
  removeSub,
  sendMany,
  SUBS_KEY,
};
