// netlify/functions/_build.js
// 전체 파이프라인: 영덕군청 긁기 -> 시간별 이력 병합/저장 -> 최근 1/3/12시간 창 계산
// -> 강우 단계 판정. rainfall.js와 scheduled-refresh.js가 공유한다.

const { scrape } = require("./_scrape");
const { mergeHistory, readHistory, computeWindows } = require("./_history");
const { classify, tiersForClient, NORMAL } = require("./_tiers");
const { getWarning } = require("./_warning");

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
    row.missing_3h = w.missing3 ?? 0;
    row.missing_12h = w.missing12 ?? 0;
    // 군청 표가 시계보다 얼마나 뒤처졌나. 0이면 정상.
    // 분 단위는 정시 직후의 짧은 지연을 재려는 것이고, GRACE_MIN을
    // 실측에 맞출 근거가 된다.
    row.data_lag_h = w.lagHours ?? null;
    row.data_lag_min = w.lagMin ?? null;

    row.risk_key = tier.key;
    row.risk_label = tier.label;
    row.risk_color = tier.color;
    row.risk_actions = tier.actions;
  }

  data.tiers = tiersForClient();
  data.normal = NORMAL;

  // 표 정체 요약. 지점 중 가장 심한 값을 대표로 삼는다.
  // 화면이 "자료 정체 N시간"을 띄우는 근거이고, 감시 로그에도 남는다.
  {
    const lags = Object.values(data.rows)
      .map((r) => r.data_lag_h)
      .filter((v) => Number.isFinite(v));
    data.table_lag_h = lags.length ? Math.max(...lags) : null;
    const lagsMin = Object.values(data.rows)
      .map((r) => r.data_lag_min)
      .filter((v) => Number.isFinite(v));
    data.table_lag_min = lagsMin.length ? Math.max(...lagsMin) : null;
    // 군청 표의 날짜가 한국시각 오늘과 다르면 표 자체가 하루 묵은 것이다.
    const k = new Date(Date.now() + 9 * 3600 * 1000);
    const p2 = (n) => String(n).padStart(2, "0");
    const kstToday = `${k.getUTCFullYear()}-${p2(k.getUTCMonth() + 1)}-${p2(k.getUTCDate())}`;
    const m = String(data.date_label || "").match(/(\d{4}-\d{2}-\d{2})/);
    data.date_mismatch = !!(m && m[1] !== kstToday);
  }

  // 기상청 특보(영덕군)는 강우 판정과 독립적으로 덧붙인다.
  // 여기서 실패하더라도 강우 자료 자체에는 영향이 없어야 한다.
  try {
    data.kma_warning = await getWarning(false, undefined, event);
  } catch (_) {
    data.kma_warning = null;
  }

  return data;
}

module.exports = { buildData };
