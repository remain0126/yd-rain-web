// netlify/functions/rainfall.js
// 사용자 접속 시 호출. 저장소(Blobs) 없이도 동작하도록:
//  1) 함수 인스턴스가 살아있으면 메모리 캐시를 즉시 반환 (같은 인스턴스 재사용 시 빠름)
//  2) CDN 캐시(Cache-Control)로 접속자 대부분이 영덕군청 대기 없이 캐시본을 받음
//  3) 영덕군청이 느리면 8초 타임아웃 후 직전 메모리 캐시라도 반환

const { scrape } = require("./_scrape");

let MEM = { data: null, at: 0 };
const TTL = 5 * 60 * 1000; // 5분

function headers(fromCache) {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    // 브라우저는 짧게(60s)만, Netlify CDN 엣지는 길게(5분) 캐시하고
    // 만료 후 10분간은 옛 데이터를 즉시 주면서 뒤에서 갱신(durable=지역 간 공유 유지)
    "Cache-Control": "public, max-age=60",
    "Netlify-CDN-Cache-Control": "public, durable, s-maxage=300, stale-while-revalidate=600",
    "X-From-Mem": fromCache ? "1" : "0",
  };
}

exports.handler = async function (event) {
  const now = Date.now();
  const forceFresh = event && event.queryStringParameters && event.queryStringParameters.fresh === "1";

  // 1) 강제 새로고침이 아니고 신선한 메모리 캐시가 있으면 즉시
  if (!forceFresh && MEM.data && now - MEM.at < TTL) {
    return { statusCode: 200, headers: headers(true), body: JSON.stringify(MEM.data) };
  }

  // 2) 새로 긁기
  try {
    const data = await scrape();
    MEM = { data, at: Date.now() };
    // 강제 새로고침 응답은 CDN에 캐시하지 않음(항상 최신 반영)
    const h = forceFresh
      ? {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        }
      : headers(false);
    return { statusCode: 200, headers: h, body: JSON.stringify(data) };
  } catch (e) {
    // 실패 시 직전 메모리 캐시라도
    if (MEM.data) {
      return {
        statusCode: 200,
        headers: headers(true),
        body: JSON.stringify({ ...MEM.data, stale: true }),
      };
    }
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: String(e && e.message ? e.message : e) }),
    };
  }
};
