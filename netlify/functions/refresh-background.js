// netlify/functions/refresh-background.js
// 느린 영덕군청 수집과 Blobs 저장을 담당하는 Background Function.
//
// 여러 건이 동시에 돌 수 있다.
//   watch.js가 1분마다 수집을 거는데 군청 응답이 1~2분씩 걸리므로,
//   앞 건이 끝나기 전에 다음 건이 출발한다. 그래야 응답이 오는 즉시 화면에 뜬다.
//
// 그래서 도착 순서를 믿으면 안 된다.
//   늦게 출발한 것이 먼저 도착할 수 있고, 그 뒤에 먼저 출발한(=더 오래된) 것이
//   도착해 새 자료를 덮어쓸 수 있다. 저장 직전에 지금 저장된 것보다
//   새 자료인지 확인하고, 오래된 것이면 버린다.

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

    // 수집을 시작한 시각. 저장 단계에서 순서를 가리는 기준이 된다.
    const fetchStartedAt = new Date(started).toISOString();

    const data = await buildData(true, event, FETCH_TIMEOUT_BACKGROUND);

    // 내가 받아오는 동안 더 늦게 출발한 수집이 이미 저장을 끝냈는지 확인한다.
    let stale = false;
    try {
      const cur = await store.get("latest", { type: "json" });
      if (cur && cur.fetch_started_at && cur.fetch_started_at > fetchStartedAt) {
        stale = true;
      }
    } catch (_) {}

    if (stale) {
      console.log(
        JSON.stringify({
          ok: true,
          function: "refresh-background",
          skipped: "더 새로운 자료가 이미 저장됨",
          elapsed_ms: Date.now() - started,
        })
      );
      return { statusCode: 200, body: "skipped (stale)" };
    }

    data.fetch_started_at = fetchStartedAt;
    data.stored_at = new Date().toISOString();
    data.fetch_elapsed_ms = Date.now() - started;
    data.blobs_ok = true;
    await store.setJSON("latest", data);

    // 수집이 끝났음을 알린다. watch.js가 이 값을 보고 다음 수집을 건다.
    try {
      await store.setJSON("refresh-lock", { at: null, done_at: data.stored_at, by: "background" });
    } catch (_) {}

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
