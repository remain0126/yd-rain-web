// netlify/functions/rainfall.js
// 사용자 접속 시 호출.
//
// [중요] Netlify Blobs는 반드시 "핸들러 실행 시점"에 초기화해야 한다.
// 모듈 최상단에서 require/getStore 하면 MissingBlobsEnvironmentError가 난다.
// 또한 Blobs가 아예 동작하지 않는 환경일 수도 있으므로, 실패해도 앱이 죽지 않고
// 오늘 데이터는 정상 표시되도록 전 구간을 방어한다(이 경우 12시간 창만 불완전).

const { buildData } = require("./_build");

const SNAPSHOT_TTL_MS = 6 * 60 * 1000;

// Blobs 스토어를 안전하게 얻는다. 실패하면 null (앱은 계속 동작).
function safeStore(name) {
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore(name);
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

  const store = safeStore("rainfall"); // null일 수 있음

  // 1) 저장된 스냅샷이 충분히 신선하면 즉시 반환
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

  // 2) 직접 긁기 (+ 가능하면 이력/스냅샷 저장)
  try {
    const data = await buildData(true);
    data.stored_at = new Date().toISOString();
    data.blobs_ok = !!store;

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
