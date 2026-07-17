// netlify/functions/refresh-background.js
// 느린 영덕군청 수집과 Blobs 저장을 담당하는 Background Function.

const { buildData } = require("./_build");
const { FETCH_TIMEOUT_BACKGROUND } = require("./_scrape");

function connectStore(name, event) {
  const blobs = require("@netlify/blobs");
  // CommonJS/Lambda 호환 함수에서는 반드시 event로 Blobs 환경을 연결해야 한다.
  if (event && typeof blobs.connectLambda === "function") {
    blobs.connectLambda(event);
  }
  return blobs.getStore(name);
}

exports.handler = async function (event) {
  const started = Date.now();

  try {
    // 먼저 Blobs 환경을 연결한다. buildData 내부 이력 저장에도 같은 event를 넘긴다.
    const store = connectStore("rainfall", event);
    const data = await buildData(true, event, FETCH_TIMEOUT_BACKGROUND);

    data.stored_at = new Date().toISOString();
    data.blobs_ok = true;
    await store.setJSON("latest", data);

    console.log(
      JSON.stringify({
        ok: true,
        function: "refresh-background",
        date_label: data.date_label || null,
        rows: data.rows ? Object.keys(data.rows).length : 0,
        elapsed_ms: Date.now() - started,
        stored_at: data.stored_at,
      })
    );

    return { statusCode: 200, body: "refreshed" };
  } catch (e) {
    const message = String(e && e.message ? e.message : e);
    console.error(
      JSON.stringify({
        ok: false,
        function: "refresh-background",
        error: message,
        elapsed_ms: Date.now() - started,
      })
    );
    return { statusCode: 500, body: "refresh failed: " + message };
  }
};
