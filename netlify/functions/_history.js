// netlify/functions/_history.js
// 시간별 강우 이력을 Netlify Blobs에 누적 저장한다.
//
// [왜 필요한가]
// 영덕군청 페이지는 "당일 01~24시"만 제공하고 어제의 시간별 값은 주지 않는다.
// (전날누적 = 어제 하루 총합 하나뿐)
// 따라서 새벽 시간대에 12시간/3시간 누적을 구하려면 어제 늦은 시각의 값이 필요한데
// 그 정보가 없다 -> 우리가 매번 긁을 때 시간별 값을 저장해두면, 자정을 넘겨도
// 어제 값을 그대로 참조할 수 있어 정확한 창을 만들 수 있다.
//
// [시각 체계]
// 표의 "HH시"는 (HH-1)시 ~ HH시 사이의 강수량을 뜻한다.
// 이를 "그 날짜 + 시각 HH(1~24)"의 슬롯으로 본다.
// 절대 시각 인덱스로 환산: slot = 날짜(일수) * 24 + HH  (HH는 1~24)
// 이렇게 하면 어제 24시 다음이 오늘 1시로 자연스럽게 이어진다.

const { getStore } = require("@netlify/blobs");

const KEEP_HOURS = 48;

// "YYYY-MM-DD" + 시각(1~24) -> 저장 키
function slotKey(dateStr, hh) {
  return `${dateStr}#${String(hh).padStart(2, "0")}`;
}

// 날짜 문자열을 UTC epoch(일 단위)로
function dateToDayNum(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function dayNumToDate(dayNum) {
  const dt = new Date(dayNum * 86400000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
}

// 절대 슬롯 번호 (연속된 시간축)
function absSlot(dateStr, hh) {
  return dateToDayNum(dateStr) * 24 + hh;
}
// 절대 슬롯 -> 저장 키
function absSlotToKey(abs) {
  let dayNum = Math.floor((abs - 1) / 24);
  let hh = abs - dayNum * 24; // 1~24
  return slotKey(dayNumToDate(dayNum), hh);
}

// dateLabel("당일(2026-07-13) 시간별 강우량")에서 날짜 추출
function extractDate(dateLabel) {
  const m = dateLabel && dateLabel.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // 없으면 KST 오늘
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${p2(kst.getUTCMonth() + 1)}-${p2(kst.getUTCDate())}`;
}

/** 오늘 시간별 값을 이력에 병합 저장 */
async function mergeHistory(rows, dateLabel) {
  const store = getStore("rainfall-history");
  let hist = {};
  try {
    const existing = await store.get("hourly", { type: "json" });
    if (existing) hist = existing;
  } catch (_) {}

  const today = extractDate(dateLabel);

  for (const [name, row] of Object.entries(rows)) {
    if (!hist[name]) hist[name] = {};
    for (let hh = 1; hh <= 24; hh++) {
      const col = String(hh).padStart(2, "0") + "시";
      const v = row[col];
      if (v === null || v === undefined) continue;
      hist[name][slotKey(today, hh)] = v;
    }
  }

  // 오래된 값 정리
  const cutoffAbs = absSlot(today, 1) - KEEP_HOURS;
  for (const name of Object.keys(hist)) {
    for (const k of Object.keys(hist[name])) {
      const [dstr, hstr] = k.split("#");
      const abs = absSlot(dstr, Number(hstr));
      if (abs < cutoffAbs) delete hist[name][k];
    }
  }

  try {
    await store.setJSON("hourly", hist);
  } catch (_) {}

  return hist;
}

async function readHistory() {
  try {
    const store = getStore("rainfall-history");
    const hist = await store.get("hourly", { type: "json" });
    return hist || {};
  } catch (_) {
    return {};
  }
}

/**
 * 최근 1/3/12시간 창을 계산한다.
 * 오늘 값은 rows에서 우선 사용하고, 창이 어제로 넘어가면 이력(hist)에서 가져온다.
 */
function computeWindows(hist, rows, dateLabel) {
  const today = extractDate(dateLabel);
  const result = {};

  for (const [name, row] of Object.entries(rows)) {
    const h = hist[name] || {};

    // 오늘 데이터가 있는 마지막 시각(1~24)
    let lastHH = 0;
    for (let hh = 1; hh <= 24; hh++) {
      const col = String(hh).padStart(2, "0") + "시";
      if (row[col] !== null && row[col] !== undefined) lastHH = hh;
    }

    // 기준 절대 슬롯: 오늘 lastHH시.
    // 오늘 데이터가 아직 하나도 없으면(자정 직후) 어제 24시를 기준으로.
    const baseAbs =
      lastHH > 0 ? absSlot(today, lastHH) : absSlot(today, 1) - 1; // 어제 24시

    // 슬롯 값 조회: 오늘 범위면 rows에서, 아니면 이력에서
    const valueAt = (abs) => {
      const todayStart = absSlot(today, 1);
      const todayEnd = absSlot(today, 24);
      if (abs >= todayStart && abs <= todayEnd) {
        const hh = abs - todayStart + 1;
        const col = String(hh).padStart(2, "0") + "시";
        const v = row[col];
        return v === undefined ? null : v;
      }
      const k = absSlotToKey(abs);
      const v = h[k];
      return v === undefined ? null : v;
    };

    const window = (count) => {
      let sum = 0;
      let missing = 0;
      for (let back = 0; back < count; back++) {
        const v = valueAt(baseAbs - back);
        if (v === null) missing++;
        else sum += v;
      }
      return { sum: Math.round(sum * 10) / 10, missing };
    };

    const w1 = valueAt(baseAbs);
    const w3 = window(3);
    const w12 = window(12);

    result[name] = {
      r1: w1,
      r3: w3.sum,
      r12: w12.sum,
      complete3: w3.missing === 0,
      complete12: w12.missing === 0,
    };
  }

  return result;
}

module.exports = { mergeHistory, readHistory, computeWindows };
