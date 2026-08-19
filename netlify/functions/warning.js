// netlify/functions/warning.js
// 기상청 특보 판정 결과를 그대로 보여주는 점검용 엔드포인트.
// 화면(rainfall)과는 분리되어 있어 여기서 무슨 일이 나도 기존 기능에 영향이 없다.
//   /api/warning        캐시 허용
//   /api/warning?fresh=1 캐시 무시하고 새로 조회

const { getWarning } = require("./_warning");

exports.handler = async function (event) {
  const force =
    !!(event && event.queryStringParameters && event.queryStringParameters.fresh === "1");

  const started = Date.now();
  const result = await getWarning(force, undefined, event);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ ...result, elapsed_ms: Date.now() - started }, null, 2),
  };
};
