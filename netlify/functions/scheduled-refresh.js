// netlify/functions/scheduled-refresh.js
// Netlify Scheduled Function은 최대 실행 시간이 짧으므로,
// 5분마다 장시간 실행 가능한 Background Function을 호출만 하고 즉시 종료한다.

exports.config = { schedule: "*/5 * * * *" };

exports.handler = async function () {
  const baseUrl = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/$/, "");

  if (!baseUrl) {
    return { statusCode: 500, body: "site URL environment variable is missing" };
  }

  const endpoint = `${baseUrl}/.netlify/functions/refresh-background`;

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "scheduled-refresh", requested_at: new Date().toISOString() }),
    });

    // Background Function은 정상 접수 시 202를 반환한다.
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`background dispatch failed: ${resp.status} ${body}`);
    }

    return { statusCode: 200, body: `background refresh accepted: ${resp.status}` };
  } catch (e) {
    return {
      statusCode: 500,
      body: "scheduled refresh failed: " + String(e && e.message ? e.message : e),
    };
  }
};
