// netlify/functions/rainfall.js
// 사용자 화면에는 Blobs에 저장된 최신 스냅샷을 빠르게 반환한다.
// 영덕군청 직접 수집은 느릴 수 있으므로 Background Function에만 맡긴다.

const SNAPSHOT_STALE_MS = 10 * 60 * 1000;
const REFRESH_AFTER_MS = 5 * 60 * 1000;

// 특보는 강우 스냅샷(5분 주기)보다 자주 바뀔 수 있으므로 응답 시점에 한 번 더 확인한다.
const { getWarning } = require("./_warning");
const logbook = require("./_logbook");
const WARNING_TIMEOUT_MS = 3500;
// 저장된 특보가 이보다 새것이면 다시 받지 않고 그대로 쓴다
const WARNING_REUSE_MS = 60 * 1000;


// 저장된 강우 자료를 읽는다.
//
// Netlify Blobs는 기본이 느슨한 읽기다. 각 지역 캐시에 값이 퍼지는 데 최대
// 60초가 걸려, 방금 수집한 자료를 읽어도 한 세대 전 값이 나올 수 있다.
// 앱을 오랜만에 열었을 때 자료가 유난히 묵어 보이는 원인이 이것이다.
//
// 강한 읽기(consistency: "strong")는 캐시를 건너뛰고 원본을 직접 본다.
// 다만 실행 환경에 따라 그 경로에 필요한 인증이 없어 통째로 실패한다.
// (2026-08-25, 강한 읽기만 쓰도록 바꿨다가 자료를 아예 못 읽어 되돌림)
//
// 그래서 먼저 강한 읽기를 시도하고, 안 되면 기본 읽기로 넘어간다.
// 되는 환경에서는 60초를 벌고, 안 되는 환경에서도 종전과 똑같이 동작한다.
async function readLatest(event) {
  let blobs;
  try {
    blobs = require("@netlify/blobs");
    if (event && typeof blobs.connectLambda === "function") blobs.connectLambda(event);
  } catch (_) {
    return { snap: null, mode: "블롭 없음" };
  }

  try {
    const s = blobs.getStore({ name: "rainfall", consistency: "strong" });
    const v = await s.get("latest", { type: "json" });
    if (v) return { snap: v, mode: "강한읽기" };
  } catch (_) {}

  try {
    const s = blobs.getStore("rainfall");
    const v = await s.get("latest", { type: "json" });
    if (v) return { snap: v, mode: "기본읽기" };
  } catch (_) {}

  return { snap: null, mode: "읽기실패" };
}

function responseHeaders(noStore = true) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": noStore ? "no-store" : "public, max-age=30",
  };
}

function siteBaseUrl(event) {
  const envUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/$/, "");
  if (envUrl) return envUrl;

  const headers = (event && event.headers) || {};
  const host = headers.host || headers.Host;
  const proto = headers["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

async function requestBackgroundRefresh(event) {
  const baseUrl = siteBaseUrl(event);
  if (!baseUrl) return { ok: false, error: "site URL unavailable" };

  try {
    const resp = await fetch(`${baseUrl}/.netlify/functions/refresh-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "rainfall",
        requested_at: new Date().toISOString(),
      }),
    });
    return { ok: resp.ok, status: resp.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

exports.handler = async function (event) {
  const forceFresh =
    event && event.queryStringParameters && event.queryStringParameters.fresh === "1";

  const read = await readLatest(event);
  const snap = read.snap;

  const ageMs =
    snap && snap.stored_at
      ? Math.max(0, Date.now() - new Date(snap.stored_at).getTime())
      : Number.POSITIVE_INFINITY;

  const shouldRefresh = forceFresh || !snap || ageMs >= REFRESH_AFTER_MS;

  // 저장된 특보가 아직 새것이면 다시 받지 않는다.
  // 특보 조회는 최대 3.5초가 걸려 화면이 뜨는 속도를 좌우한다.
  const warnAge =
    snap && snap.kma_warning && snap.kma_warning.checked_at
      ? Date.now() - new Date(snap.kma_warning.checked_at).getTime()
      : Number.POSITIVE_INFINITY;
  const needWarning = forceFresh || warnAge >= WARNING_REUSE_MS;

  // 세 가지 일을 나란히 처리한다. 차례로 기다리면 그만큼 화면이 늦게 뜬다.
  const [dispatch, warn] = await Promise.all([
    shouldRefresh ? requestBackgroundRefresh(event) : Promise.resolve(null),
    needWarning
      ? getWarning(false, WARNING_TIMEOUT_MS, event).catch(() => null)
      : Promise.resolve(null),
    // 접속 기록 (브라우저가 보낸 임의 식별자만 사용, 개인정보 아님)
    (async () => {
      try {
        const vid = (event.queryStringParameters && event.queryStringParameters.v) || null;
        if (vid) await logbook.recordVisit(vid, event);
      } catch (_) {}
    })(),
  ]);

  // 저장된 자료가 있으면 즉시 반환하고, 새 수집은 뒤에서 진행한다.
  if (snap) {

    return {
      statusCode: 200,
      // 강우 자료는 매번 새로 받아야 한다. 캐시를 두면 지난 값이 그대로 나온다.
      headers: responseHeaders(true),
      body: JSON.stringify({
        ...snap,
        kma_warning: warn && warn.ok ? warn : snap.kma_warning || null,
        stale: ageMs >= SNAPSHOT_STALE_MS,
        refresh_requested: !!(dispatch && dispatch.ok),
        refresh_status: dispatch && dispatch.status ? dispatch.status : undefined,
      }),
    };
  }

  // 최초 배포 등 스냅샷이 아직 없으면 백그라운드 수집 완료 후 재시도하게 한다.
  return {
    statusCode: 202,
    headers: responseHeaders(true),
    body: JSON.stringify({
      pending: true,
      message: "강우자료를 수집 중입니다. 잠시 후 다시 확인해 주세요.",
      refresh_requested: !!(dispatch && dispatch.ok),
      refresh_status: dispatch && dispatch.status ? dispatch.status : undefined,
      dispatch_error: dispatch && dispatch.error ? dispatch.error : undefined,
    }),
  };
};
