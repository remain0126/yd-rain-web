// netlify/functions/scheduled-refresh.js
// 5분마다 자동 실행:
//  - 영덕군청을 긁어 시간별 이력을 저장소에 누적 (자정을 넘겨도 어제 값 보존 -> 12시간 창 정확)
//  - 최신 스냅샷 저장 -> 사용자 접속 시 영덕군청 대기 없이 즉시 응답
//
// Blobs는 핸들러 실행 시점에 초기화해야 하며, 실패해도 함수가 죽지 않게 방어한다.

const { buildData } = require("./_build");

function safeStore(name) {
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore(name);
  } catch (_) {
    return null;
  }
}

exports.config = { schedule: "*/5 * * * *" };

exports.handler = async function () {
  try {
    const data = await buildData(true); // 이력 병합/저장 시도
    data.stored_at = new Date().toISOString();

    const store = safeStore("rainfall");
    if (store) {
      try {
        await store.setJSON("latest", data);
      } catch (e) {
        return { statusCode: 200, body: "scraped but snapshot save failed: " + e.message };
      }
      return { statusCode: 200, body: "refreshed: " + (data.date_label || "") };
    }
    return { statusCode: 200, body: "scraped (blobs unavailable)" };
  } catch (e) {
    return { statusCode: 500, body: "refresh failed: " + (e && e.message ? e.message : e) };
  }
};
