// netlify/functions/diag.js
// 진단: (1) 영덕군청 접속 가능 여부 (2) Netlify Blobs 동작 여부

const YD_URL = "https://www.yd.go.kr/?p=1020";

async function tryFetch(label, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    return { label, ok: resp.ok, status: resp.status, ms: Date.now() - started, bytes: text.length };
  } catch (e) {
    return { label, error: String(e && e.message ? e.message : e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function testBlobs(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && typeof blobs.connectLambda === "function") {
      blobs.connectLambda(event);
    }
    const store = blobs.getStore("diag-test");
    const stamp = new Date().toISOString();
    await store.setJSON("ping", { stamp });
    const back = await store.get("ping", { type: "json" });
    return {
      blobs_ok: true,
      wrote: stamp,
      read_back: back && back.stamp,
      match: !!(back && back.stamp === stamp),
    };
  } catch (e) {
    return { blobs_ok: false, error: String(e && e.message ? e.message : e) };
  }
}

exports.handler = async function (event) {
  const results = [];
  results.push(
    await tryFetch(
      "영덕군청",
      YD_URL,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        },
      },
      20000
    )
  );

  const blobs = await testBlobs(event);

  // 워치독이 남긴 최근 점검 결과. 감시가 돌고 있는지, 군청 표가 멈췄는지.
  let health = null;
  try {
    const b = require("@netlify/blobs");
    if (event && typeof b.connectLambda === "function") b.connectLambda(event);
    health = await b.getStore("rainfall-history").get("health", { type: "json" });
  } catch (_) {}

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(
      { checked_at: new Date().toISOString(), fetch: results, blobs, health },
      null,
      2
    ),
  };
};
