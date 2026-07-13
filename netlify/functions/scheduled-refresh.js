// netlify/functions/scheduled-refresh.js
// 5분마다 자동 실행. 자신의 사이트 /api/rainfall 을 일반 요청처럼 호출해서
// (1) 함수를 깨워두고(콜드 스타트 완화) (2) CDN 엣지 캐시를 최신으로 채운다.
// 그러면 실제 사용자 접속 시 CDN 캐시본이 즉시 나가 영덕군청 대기가 없다.

exports.config = { schedule: "*/5 * * * *" };

exports.handler = async function () {
  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) return { statusCode: 200, body: "no base url; skipped" };

  try {
    // 일반 요청처럼 호출 (no-cache 안 붙임) -> 응답이 CDN 캐시에 앉음
    const res = await fetch(base + "/api/rainfall");
    // 본문을 실제로 소비해야 함수 실행이 완료로 집계됨
    await res.text();
    return { statusCode: 200, body: "warmed: " + res.status };
  } catch (e) {
    return { statusCode: 500, body: "warm failed: " + (e && e.message ? e.message : e) };
  }
};
