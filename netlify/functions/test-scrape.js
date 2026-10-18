// netlify/functions/test-scrape.js
// [임시 테스트 전용] 영덕군청 WAF 우회가 헤더 위장으로 가능한지 확인한다.
// 기존 기능과 무관하며, 테스트가 끝나면 이 파일만 삭제하면 된다.
//
// 여러 "위장 수준"을 순서대로 시도해, 어느 것이 20만 bytes짜리 실제 페이지를
// 받아오는지(= 뚫리는지) 본다. 362 bytes 안팎이면 차단 페이지(실패).

const YD_URL = "https://www.yd.go.kr/?p=1020";
const TIMEOUT_MS = 20000;

async function attempt(label, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const resp = await fetch(YD_URL, {
      signal: controller.signal,
      redirect: "follow",
      headers: extraHeaders,
    });
    const text = await resp.text();
    const blocked =
      text.includes("firewall") ||
      text.includes("blocked") ||
      text.includes("보안정책") ||
      text.length < 2000;
    const hasTable = text.includes("시간별 강우량") || text.includes("tbl_10");
    return {
      label,
      ok: resp.ok,
      status: resp.status,
      ms: Date.now() - started,
      bytes: text.length,
      looks_blocked: blocked,
      has_rainfall_table: hasTable,
      verdict: hasTable ? "✅ 성공(표 있음)" : blocked ? "❌ 차단됨" : "⚠️ 표 없음/불명",
    };
  } catch (e) {
    return { label, error: String(e && e.message ? e.message : e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 흔한 UA
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

exports.handler = async function () {
  const results = [];

  // 1) 헤더 거의 없이 (현재 코드와 유사 — 기준선)
  results.push(await attempt("1_minimal", { "User-Agent": CHROME_UA }));

  // 2) 브라우저가 보내는 표준 헤더 풀세트
  results.push(
    await attempt("2_full_browser", {
      "User-Agent": CHROME_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Cache-Control": "max-age=0",
      Connection: "keep-alive",
    })
  );

  // 3) 2번 + Referer(군청 내부에서 넘어온 것처럼)
  results.push(
    await attempt("3_with_referer", {
      "User-Agent": CHROME_UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
      Referer: "https://www.yd.go.kr/",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
      Connection: "keep-alive",
    })
  );

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(
      {
        note: "3가지 위장 수준을 시험. has_rainfall_table=true 가 하나라도 있으면 우회 성공.",
        checked_at: new Date().toISOString(),
        results,
      },
      null,
      2
    ),
  };
};
