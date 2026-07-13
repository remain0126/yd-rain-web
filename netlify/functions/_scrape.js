// netlify/functions/_scrape.js
// 영덕군청 강우량정보 페이지를 긁어와 파싱하는 공용 로직.
// scheduled-refresh(주기 수집)와 rainfall(접속 응답) 함수가 공유한다.

const cheerio = require("cheerio");

const YD_URL = "https://www.yd.go.kr/?p=1020";
const FETCH_TIMEOUT_MS = 25000;

const EUPMYEON_NAMES = ["영덕", "강구", "남정", "달산", "지품", "축산", "영해", "병곡", "창수"];

const FIRE_TIERS = [
  { key: "critical", label: "호우특보(경보)", trigger: "호우경보", c3: 90, c12: 180, color: "#f43f5e",
    actions: ["주민 즉각 대피 발령", "전 대원 현장 출동", "위험구역 접근 통제"] },
  { key: "high", label: "호우특보(주의보)", trigger: "호우주의보", c3: 60, c12: 110, color: "#fb923c",
    actions: ["순찰반 현장 출동", "주민 대피 준비 통보", "유관기관 상황 공유"] },
  { key: "low", label: "호우특보(예비)", trigger: "특보 전 단계", c3: 30, c12: 60, color: "#fbbf24",
    actions: ["위험구역 순찰 개시", "모니터링 강화", "기상청 예보 실시간 확인"] },
];
const NORMAL = { key: "normal", label: "정상", color: "#34d399", actions: ["평시 모니터링"] };

function toValue(text) {
  const t = (text || "").trim();
  if (t === "" || t === "-") return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

function classifyTier(r3, r12) {
  for (const tier of FIRE_TIERS) {
    if ((r3 !== null && r3 >= tier.c3) || (r12 !== null && r12 >= tier.c12)) return tier;
  }
  return NORMAL;
}

function parse(html) {
  const $ = cheerio.load(html);

  let table = null;
  $("table").each((_, el) => {
    if (table) return;
    const cap = $(el).find("caption").text() || "";
    if (cap.includes("시간별 강우량")) table = el;
  });
  if (!table) table = $("table.tbl_10").get(0);
  if (!table) throw new Error("강우량 표를 찾지 못했습니다");

  const $table = $(table);
  const headerTrs = $table.find("thead tr");
  const row2 = $(headerTrs.get(1));
  const hourLabels = [];
  row2.find("th").each((_, th) => hourLabels.push($(th).text().trim() + "시"));

  const colLabels = ["전날누적", ...hourLabels, "오늘누계", "당월누계"];
  const hourCols = colLabels.filter((c) => /^\d{2}시$/.test(c));

  const rows = {};
  $table.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length === 0) return;
    const name = $(tds.get(0)).text().trim();
    const values = [];
    tds.slice(1).each((__, td) => values.push(toValue($(td).text())));
    const n = Math.min(values.length, colLabels.length);
    const row = {};
    for (let i = 0; i < n; i++) row[colLabels[i]] = values[i];
    rows[name] = row;
  });

  for (const name of Object.keys(rows)) {
    const row = rows[name];
    const hv = hourCols.map((c) => (c in row ? row[c] : null));
    let lastIdx = -1;
    hv.forEach((v, i) => { if (v !== null && v !== undefined) lastIdx = i; });

    if (lastIdx < 0) {
      row.recent_3h_mm = null;
      row.recent_12h_mm = null;
      Object.assign(row, { risk_key: NORMAL.key, risk_label: NORMAL.label, risk_color: NORMAL.color, risk_actions: NORMAL.actions });
    } else {
      const s3 = hv.slice(Math.max(0, lastIdx - 2), lastIdx + 1).reduce((a, v) => a + (v || 0), 0);
      const s12 = hv.slice(Math.max(0, lastIdx - 11), lastIdx + 1).reduce((a, v) => a + (v || 0), 0);
      row.recent_3h_mm = Math.round(s3 * 10) / 10;
      row.recent_12h_mm = Math.round(s12 * 10) / 10;
      const tier = classifyTier(s3, s12);
      Object.assign(row, { risk_key: tier.key, risk_label: tier.label, risk_color: tier.color, risk_actions: tier.actions });
    }
  }

  let dateLabel = null;
  $("h5").each((_, el) => {
    const t = $(el).text().trim();
    if (t.includes("시간별 강우량")) dateLabel = t;
  });

  return { columns: colLabels, rows, date_label: dateLabel };
}

async function scrape() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(YD_URL, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
      },
    });
    if (!resp.ok) throw new Error("영덕군청 응답 오류: " + resp.status);
    const buf = await resp.arrayBuffer();
    const html = new TextDecoder("utf-8").decode(buf);
    const data = parse(html);
    data.fetched_at = new Date().toISOString();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scrape, parse };
