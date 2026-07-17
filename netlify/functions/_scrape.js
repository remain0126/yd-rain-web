// netlify/functions/_scrape.js
// 영덕군청 강우량정보 페이지를 긁어와 파싱하는 공용 로직 (파싱만 담당).
// 위험도 판정은 _history.js(이력 기반 창 계산) + _tiers.js(기준 판정)에서 수행.

const cheerio = require("cheerio");

const YD_URL = "https://www.yd.go.kr/?p=1020";
const FETCH_TIMEOUT_DEFAULT = 9000;   // 사용자 접속 함수용(무료 10초 제한 안쪽)
const FETCH_TIMEOUT_BACKGROUND = 90000; // 백그라운드 함수용(최대 15분이라 여유)

function toValue(text) {
  const t = (text || "").trim();
  if (t === "" || t === "-") return null;
  const n = parseFloat(t);
  return Number.isNaN(n) ? null : n;
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

  let dateLabel = null;
  $("h5").each((_, el) => {
    const t = $(el).text().trim();
    if (t.includes("시간별 강우량")) dateLabel = t;
  });

  return { columns: colLabels, rows, date_label: dateLabel };
}

async function scrape(timeoutMs) {
  const ms = timeoutMs || FETCH_TIMEOUT_DEFAULT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
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

module.exports = { scrape, parse, FETCH_TIMEOUT_DEFAULT, FETCH_TIMEOUT_BACKGROUND };
