// netlify/functions/logs.js
// 축적된 운영 기록을 확인하는 통로.
//
//   /api/logs?token=...            → 오늘치 누적 현황
//   /api/logs?token=...&flush=1    → 오늘치를 즉시 GitHub에 저장
//
// 과거 기록은 GitHub 저장소의 logs/<연도>/<날짜>.json 에서 직접 확인한다.

const logbook = require("./_logbook");

exports.handler = async function (event) {
  const q = (event && event.queryStringParameters) || {};

  const need = process.env.WATCH_TOKEN;
  if (need && q.token !== need) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: "인증 실패" }) };
  }

  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };

  try {
    if (q.flush === "1") {
      const date = await logbook.flushToday(event);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, saved: date, path: `logs/${date.slice(0, 4)}/${date}.json` }, null, 2),
      };
    }

    const day = await logbook.readDay(event);

    // 요약만 보여준다 (원본은 GitHub 파일에 그대로 있다)
    const summary = {
      ok: true,
      github_configured: logbook.configured(),
      date: day.date,
      visits: {
        total: day.visits.total,
        unique: day.visits.uniq.length,
        byHour: day.visits.byHour,
      },
      push: day.push,
      events: day.events,
      rain_points: Object.keys(day.rain).length,
      updated_at: day.updated_at,
    };

    return { statusCode: 200, headers, body: JSON.stringify(summary, null, 2) };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }),
    };
  }
};
