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
//
// [기준점은 시계다 — 2026-09 변경]
// 예전에는 창의 기준을 "표에서 값이 들어있는 마지막 칸"으로 잡았다.
// 그래서 (1) 군청 표가 갱신을 멈추면 몇 시간 전 비를 현재로 계속 판정했고,
//        (2) 비가 그쳐 빈칸이 생기면 기준이 과거에 고정돼 단계가 내려가지 않았다.
// 지금은 기준을 한국시각으로 잡는다. 표가 멈추면 창이 저절로 비어가고,
// 비가 그치면 옛 값이 창 밖으로 밀려나며 단계가 내려간다.
// 표가 시계보다 얼마나 뒤처졌는지는 lagHours로 따로 알린다.

// Blobs는 반드시 "핸들러 실행 시점"에 초기화해야 한다.
// - Lambda 호환 모드(exports.handler): event 객체를 connectLambda로 넘겨야 함
// - Functions 2.0 (export default): 자동 주입되므로 그냥 getStore ("auto" 신호)
// 실패 시 null을 반환하고 앱은 계속 동작한다.
function blobStore(name, event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && event !== "auto" && typeof blobs.connectLambda === "function") {
      blobs.connectLambda(event);
    }
    return blobs.getStore(name);
  } catch (_) {
    return null;
  }
}

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

// 한국시각 기준 "지금 진행 중인 슬롯"의 절대 번호.
//   00:30 -> 01시 슬롯(00~01시), 14:30 -> 15시 슬롯, 23:30 -> 24시 슬롯
function nowSlotAbs() {
  const k = new Date(Date.now() + 9 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const date = `${k.getUTCFullYear()}-${p2(k.getUTCMonth() + 1)}-${p2(k.getUTCDate())}`;
  return absSlot(date, k.getUTCHours() + 1);
}

// 한국시각의 분(分). 정시 직후인지 판단하는 데 쓴다.
function kstMinute() {
  return new Date(Date.now() + 9 * 3600 * 1000).getUTCMinutes();
}

// 정시 직후 이만큼은 결측으로 표시하지 않는다.
//
// 군청은 17개 지점을 한꺼번에 채우지 않는다. 3시 정각에 15개가 들어오고
// 2~3분 뒤 나머지가 들어오는 식이다. 그 사이를 결측으로 띄우면 곧 채워질
// 것을 두고 걱정을 만든다.
//
// 표시만 미루고 계산은 그대로 한다. 방금 끝난 시각을 창에서 빼버리면
// 그 시간에 온 폭우가 누적에서 사라진다.
//
// 5분은 실측값이 아니다. 군청이 정시 후 몇 분에 채우는지 기록이 없어
// 우선 잡은 값이다. data_lag_min 로그가 며칠 쌓이면 그에 맞춰 조정한다.
const GRACE_MIN = 5;

// dateLabel("당일(2026-07-13) 시간별 강우량")에서 날짜 추출
function extractDate(dateLabel) {
  const m = dateLabel && dateLabel.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // 없으면 KST 오늘
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${p2(kst.getUTCMonth() + 1)}-${p2(kst.getUTCDate())}`;
}

// 한 지점의 오늘 행에서 값이 들어있는 마지막 시각(1~24). 없으면 0.
function lastFilledHour(row) {
  let last = 0;
  for (let hh = 1; hh <= 24; hh++) {
    const col = String(hh).padStart(2, "0") + "시";
    if (row[col] !== null && row[col] !== undefined) last = hh;
  }
  return last;
}

/** 오늘 시간별 값을 이력에 병합 저장 */
async function mergeHistory(rows, dateLabel, event) {
  const store = blobStore("rainfall-history", event);
  let hist = {};
  if (!store) return hist; // Blobs 불가 -> 이력 없이 오늘 데이터만으로 동작

  try {
    const existing = await store.get("hourly", { type: "json" });
    if (existing) hist = existing;
  } catch (_) {}

  const today = extractDate(dateLabel);

  for (const [name, row] of Object.entries(rows)) {
    if (!hist[name]) hist[name] = {};
    // 값이 채워진 마지막 시각까지는 빈칸도 함께 저장한다.
    //
    // 군청 표는 비가 오지 않은 시각을 0이 아니라 빈칸으로 두는 경우가 있다.
    // 그 칸을 건너뛰고 저장하지 않으면 나중에 "기록이 없는 시각"과
    // 구별되지 않아, 창을 계산할 때마다 영구히 결측으로 남는다.
    // 뒤쪽에 값이 있다는 것은 그 시각까지 표가 채워졌다는 뜻이므로
    // 앞의 빈칸은 미기록이 아니라 무강우로 확정할 수 있다.
    const last = lastFilledHour(row);
    for (let hh = 1; hh <= last; hh++) {
      const col = String(hh).padStart(2, "0") + "시";
      const v = row[col];
      hist[name][slotKey(today, hh)] = v === null || v === undefined ? 0 : v;
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

async function readHistory(event) {
  const store = blobStore("rainfall-history", event);
  if (!store) return {};
  try {
    const hist = await store.get("hourly", { type: "json" });
    return hist || {};
  } catch (_) {
    return {};
  }
}

/**
 * 최근 1/3/12시간 창을 계산한다.
 *
 * 창의 끝은 "직전에 완료된 시각"이다. 시계로 정한다.
 * 진행 중인 시각은 아직 채워지는 중이라 누적 창에는 넣지 않고,
 * 1시간 판정에서만 참고한다.
 *
 * 결측은 0으로 세지 않고 결측으로 센다(missing). 수치는 실측 합계만 담고,
 * 몇 칸이 비었는지를 함께 돌려주어 화면이 그대로 알릴 수 있게 한다.
 */
function computeWindows(hist, rows, dateLabel) {
  const today = extractDate(dateLabel);
  const clockAbs = nowSlotAbs();     // 진행 중 슬롯
  const baseAbs = clockAbs - 1;      // 직전 완료 슬롯 = 창의 끝
  const kstMin = kstMinute();
  const result = {};

  for (const [name, row] of Object.entries(rows)) {
    const h = hist[name] || {};

    const lastHH = lastFilledHour(row);
    const dataAbs = lastHH > 0 ? absSlot(today, lastHH) : null;

    // 표가 시계보다 몇 시간 뒤처졌나. 정상이면 0.
    const lagHours = dataAbs == null ? null : Math.max(0, baseAbs - dataAbs);

    // 기대되는 다음 칸이 몇 분째 안 채워졌나.
    //
    // 표가 최신이면 0이다. 17:10인데 표가 16시까지만 차 있으면,
    // 17시 칸이 17:00에 완결됐어야 하므로 10분이다.
    // 시간 단위(lagHours)로는 이 몇 분이 안 보인다. 군청이 정시 후
    // 몇 분에 채우는지 알아야 GRACE_MIN을 실측에 맞출 수 있다.
    const lagMin =
      dataAbs == null ? null : Math.max(0, (baseAbs - dataAbs - 1) * 60 + kstMin);

    // 슬롯 값 조회: 오늘 범위면 rows에서, 아니면 이력에서
    const valueAt = (abs) => {
      const todayStart = absSlot(today, 1);
      const todayEnd = absSlot(today, 24);
      if (abs >= todayStart && abs <= todayEnd) {
        const hh = abs - todayStart + 1;
        const col = String(hh).padStart(2, "0") + "시";
        const v = row[col];
        if (v !== null && v !== undefined) return v;
        // 표가 이 시각보다 뒤까지 채워져 있으면 빈칸은 무강우다 (위 mergeHistory 주석 참고)
        if (dataAbs != null && abs < dataAbs) return 0;
        return null;
      }
      const k = absSlotToKey(abs);
      const v = h[k];
      return v === undefined ? null : v;
    };

    const window = (count) => {
      let sum = 0;
      let missing = 0;
      let missNewest = false;
      for (let back = 0; back < count; back++) {
        const v = valueAt(baseAbs - back);
        if (v === null) {
          missing++;
          if (back === 0) missNewest = true;
        } else sum += v;
      }
      // 방금 끝난 시각 하나만 비었고 정시 후 GRACE_MIN 안이면,
      // 군청이 아직 채우지 않은 것으로 보고 표시를 미룬다.
      // 앞 시각까지 비었거나 시간이 지났으면 그대로 알린다.
      const graced = missing === 1 && missNewest && kstMin < GRACE_MIN;
      return {
        sum: Math.round(sum * 10) / 10,
        missing,
        incomplete: missing > 0 && !graced,
      };
    };

    // 1시간: 진행 중 시각은 아직 쌓이는 중이라 직전 완료 시각과 큰 쪽을 쓴다.
    // 시간당 72mm 같은 즉시 기준을 진행 중 폭우에서 놓치지 않기 위함이다.
    const vNow = valueAt(clockAbs);
    const vPrev = valueAt(baseAbs);
    const r1 = vNow == null ? vPrev : vPrev == null ? vNow : Math.max(vNow, vPrev);

    const w3 = window(3);
    const w12 = window(12);

    result[name] = {
      r1,
      r3: w3.sum,
      r12: w12.sum,
      complete3: !w3.incomplete,
      complete12: !w12.incomplete,
      missing3: w3.missing,
      missing12: w12.missing,
      lagHours,
      lagMin,
    };
  }

  return result;
}

module.exports = { mergeHistory, readHistory, computeWindows, nowSlotAbs };
