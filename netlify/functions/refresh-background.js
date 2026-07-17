// netlify/functions/refresh-background.js
//
// [백그라운드 함수] 파일명에 "-background"가 붙으면 최대 15분까지 실행 가능하다.
// (일반 함수는 무료 10초/유료 26초 제한 -> 영덕군청이 1분 걸리면 못 기다림)
//
// 5분마다 스케줄 실행되어:
//  - 영덕군청을 느긋하게 긁어(최대 90초 대기) 시간별 이력을 Blobs에 누적
//  - 최신 스냅샷 저장 -> 사용자 접속(rainfall.js)은 이 스냅샷만 즉시 반환하므로 빠름

const { buildData } = require("./_build");
const { FETCH_TIMEOUT_BACKGROUND } = require("./_scrape");

function autoStore(name) {
  try {
    const { getStore } = require("@netlify/blobs");
    return getStore(name);
  } catch (_) {
    return null;
  }
}

exports.handler = async function () {
  try {
    // 백그라운드라 시간 여유가 있으므로 영덕군청을 오래(최대 90초) 기다린다.
    const data = await buildData(true, "auto", FETCH_TIMEOUT_BACKGROUND);
    data.stored_at = new Date().toISOString();

    const store = autoStore("rainfall");
    if (store) {
      await store.setJSON("latest", data);
    }
    // 백그라운드 함수는 반환값이 클라이언트로 안 감(이미 202 응답). 로깅용.
    return { statusCode: 200, body: "refreshed: " + (data.date_label || "") };
  } catch (e) {
    return { statusCode: 500, body: "refresh failed: " + (e && e.message ? e.message : e) };
  }
};
