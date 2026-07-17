// netlify/functions/rainfall.js
// 사용자 접속 시 호출.
//
// [중요] Lambda 호환 모드(exports.handler)에서는 Blobs 환경이 자동 주입되지 않는다.
// 반드시 handler 안에서 connectLambda(event)를 호출한 뒤 getStore를 써야 한다.
// (공식 문서에 잘 안 나와 있는 함정)

const { buildData } = require("./_build");

const SNAPSHOT_TTL_MS = 6 * 60 * 1000;

// event로 Blobs 환경을 연결한 store를 얻는다. 실패하면 null(앱은 계속 동작).
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

function headers(noStore) {
  if (noStore) {
    return {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
  }
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=60",
    "Netlify-CDN-Cache-Control": "public, durable, s-maxage=300, stale-while-revalidate=600",
  };
}

exports.handler = async function (event) {
  const forceFresh =
    event && event.queryStringParameters && event.queryStringParameters.fresh === "1";

  const store = safeStore("rainfall", event); // null일 수 있음

  // 1) 신선한 스냅샷이 있으면 즉시 반환
  if (!forceFresh && store) {
    try {
      const snap = await store.get("latest", { type: "json" });
      if (snap && snap.stored_at) {
        const age = Date.now() - new Date(snap.stored_at).getTime();
        if (age < SNAPSHOT_TTL_MS) {
          return { statusCode: 200, headers: headers(false), body: JSON.stringify(snap) };
        }
      }
    } catch (_) {}
  }

  // 2) 스냅샷이 없거나 오래됨 -> 직접 긁는다.
  //    사용자 함수는 10초 제한이라 이력 "저장"은 백그라운드에 맡기고 여기선 읽기만(persist=false).
  //    event를 넘겨 Blobs 이력을 읽어 12시간 창까지 계산한다.
  try {
    const data = await buildData(false, event);
    data.stored_at = new Date().toISOString();
    data.blobs_ok = !!store;

    // 스냅샷은 저장해둔다(다음 접속자 빠르게)
    if (store) {
      try {
        await store.setJSON("latest", data);
      } catch (_) {}
    }
    return { statusCode: 200, headers: headers(forceFresh), body: JSON.stringify(data) };
  } catch (e) {
    // 3) 실패 시 옛 스냅샷이라도
    if (store) {
      try {
        const snap = await store.get("latest", { type: "json" });
        if (snap) {
          return {
            statusCode: 200,
            headers: headers(false),
            body: JSON.stringify({ ...snap, stale: true }),
          };
        }
      } catch (_) {}
    }
    return {
      statusCode: 502,
      headers: headers(true),
      body: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
    };
  }
};
