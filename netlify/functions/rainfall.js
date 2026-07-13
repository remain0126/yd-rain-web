// netlify/functions/rainfall.js
// 사용자 접속 시 호출.
// 1) 저장소(Blobs)에 최신 스냅샷이 있으면 즉시 반환 -> 영덕군청 대기 없이 빠름
// 2) 없거나 오래됐으면(또는 fresh=1) 직접 긁고 이력까지 갱신
// 3) CDN 캐시로 다수 접속자를 커버

const { getStore } = require("@netlify/blobs");
const { buildData } = require("./_build");

const SNAPSHOT_TTL_MS = 6 * 60 * 1000; // 6분 (스케줄 5분 + 여유)

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

  const store = getStore("rainfall");

  // 1) 저장된 스냅샷이 충분히 신선하면 즉시 반환
  if (!forceFresh) {
    try {
      const snap = await store.get("latest", { type: "json" });
      if (snap && snap.stored_at) {
        const age = Date.now() - new Date(snap.stored_at).getTime();
        if (age < SNAPSHOT_TTL_MS) {
          return { statusCode: 200, headers: headers(false), body: JSON.stringify(snap) };
        }
      }
    } catch (_) {
      // 저장소 접근 실패 -> 아래에서 직접 긁기
    }
  }

  // 2) 직접 긁고 이력 갱신 + 스냅샷 저장
  try {
    const data = await buildData(true);
    data.stored_at = new Date().toISOString();
    try {
      await store.setJSON("latest", data);
    } catch (_) {}
    return { statusCode: 200, headers: headers(forceFresh), body: JSON.stringify(data) };
  } catch (e) {
    // 3) 실패 시 오래된 스냅샷이라도 반환 (재난 대응 연속성)
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

    return {
      statusCode: 502,
      headers: headers(true),
      body: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
    };
  }
};
