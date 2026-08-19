// netlify/functions/rainfall.js
// 사용자 화면에는 Blobs에 저장된 최신 스냅샷을 빠르게 반환한다.
// 영덕군청 직접 수집은 느릴 수 있으므로 Background Function에만 맡긴다.

const SNAPSHOT_STALE_MS = 10 * 60 * 1000;
const REFRESH_AFTER_MS = 5 * 60 * 1000;

// 특보는 강우 스냅샷(5분 주기)보다 자주 바뀔 수 있으므로 응답 시점에 한 번 더 확인한다.
const { getWarning } = require("./_warning");
const WARNING_TIMEOUT_MS = 3500;

function safeStore(name, event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && typeof blobs.connectLambda === "function") {
      blobs.connectLambda(event);
    }
    return blobs.getStore(name);
  } catch (_) {
    return null;
  }
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

  const store = safeStore("rainfall", event);
  let snap = null;

  if (store) {
    try {
      snap = await store.get("latest", { type: "json" });
    } catch (_) {}
  }

  const ageMs =
    snap && snap.stored_at
      ? Math.max(0, Date.now() - new Date(snap.stored_at).getTime())
      : Number.POSITIVE_INFINITY;

  const shouldRefresh = forceFresh || !snap || ageMs >= REFRESH_AFTER_MS;
  let dispatch = null;
  if (shouldRefresh) {
    dispatch = await requestBackgroundRefresh(event);
  }

  // 저장된 자료가 있으면 즉시 반환하고, 새 수집은 뒤에서 진행한다.
  if (snap) {
    // 특보만 응답 시점 기준으로 갱신한다. 실패하면 스냅샷에 저장된 값을 그대로 쓴다.
    let warn = null;
    try {
      warn = await getWarning(false, WARNING_TIMEOUT_MS, event);
    } catch (_) {}

    return {
      statusCode: 200,
      headers: responseHeaders(forceFresh),
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
