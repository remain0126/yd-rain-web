// netlify/functions/diag.js
// 영덕군청 접속이 왜 안 되는지 진단한다. 여러 방식으로 시도해보고 결과를 모아 보여준다.

const YD_URL = "https://www.yd.go.kr/?p=1020";

async function tryFetch(label, url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    const text = await resp.text();
    return {
      label,
      ok: resp.ok,
      status: resp.status,
      ms: Date.now() - started,
      bytes: text.length,
      sample: text.slice(0, 120),
    };
  } catch (e) {
    return { label, error: String(e && e.message ? e.message : e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function () {
  const results = [];

  // 1) 기본 접속
  results.push(await tryFetch("기본", YD_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36" },
  }, 20000));

  // 2) 외부 대조군(잘 되는 사이트) - 클라우드 아웃바운드 자체가 되는지 확인
  results.push(await tryFetch("대조군(example.com)", "https://example.com", {}, 10000));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ checked_at: new Date().toISOString(), results }, null, 2),
  };
};
