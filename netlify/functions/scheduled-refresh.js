// netlify/functions/scheduled-refresh.js
// 5분마다 자동 실행:
//  - 영덕군청을 긁어 시간별 이력을 저장소에 누적 (자정을 넘겨도 어제 값 보존 -> 12시간 창 정확)
//  - 최신 스냅샷을 저장 -> 사용자 접속 시 영덕군청 대기 없이 즉시 응답

const { getStore } = require("@netlify/blobs");
const { buildData } = require("./_build");

exports.config = { schedule: "*/5 * * * *" };

exports.handler = async function () {
  try {
    const data = await buildData(true); // true = 이력 병합/저장
    data.stored_at = new Date().toISOString();

    const store = getStore("rainfall");
    await store.setJSON("latest", data);

    return { statusCode: 200, body: "refreshed: " + (data.date_label || "") };
  } catch (e) {
    return { statusCode: 500, body: "refresh failed: " + (e && e.message ? e.message : e) };
  }
};
