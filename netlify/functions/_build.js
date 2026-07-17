// netlify/functions/_build.js
// 전체 파이프라인: 영덕군청 긁기 -> 시간별 이력 병합/저장 -> 최근 1/3/12시간 창 계산
// -> 강우 단계 판정. rainfall.js와 scheduled-refresh.js가 공유한다.

const { scrape } = require("./_scrape");
const { mergeHistory, readHistory, computeWindows } = require("./_history");
const { classify, tiersForClient, NORMAL } = require("./_tiers");

/**
 * @param {boolean} persist true면 이력을 저장소에 병합 저장(주기 수집/최신화 시).
 *                          false면 저장된 이력을 읽기만 함.
 * @param {object|string|null} event connectLambda용 이벤트("auto"면 자동주입 컨텍스트)
 * @param {number} [timeoutMs] 영덕군청 fetch 타임아웃(백그라운드는 길게)
 */
async function buildData(persist = true, event = null, timeoutMs) {
  const data = await scrape(timeoutMs);

  let hist;
  if (persist) {
    hist = await mergeHistory(data.rows, data.date_label, event);
  } else {
    hist = await readHistory(event);
  }

  const windows = computeWindows(hist, data.rows, data.date_label);

  for (const [name, row] of Object.entries(data.rows)) {
    const w = windows[name] || {};
    const r1 = w.r1 ?? null;
    const r3 = w.r3 ?? null;
    const r12 = w.r12 ?? null;

    const tier = classify(r1, r3, r12);

    row.recent_1h_mm = r1;
    row.recent_3h_mm = r3;
    row.recent_12h_mm = r12;
    // 이력이 부족해 창이 불완전한 경우(도입 초기 등) 화면에 알릴 수 있도록 표시
    row.window_complete_3h = w.complete3 !== false;
    row.window_complete_12h = w.complete12 !== false;

    row.risk_key = tier.key;
    row.risk_label = tier.label;
    row.risk_color = tier.color;
    row.risk_actions = tier.actions;
  }

  data.tiers = tiersForClient();
  data.normal = NORMAL;

  return data;
}

module.exports = { buildData };
