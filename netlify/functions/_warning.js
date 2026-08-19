// netlify/functions/_warning.js
// 기상청이 실제로 발효한 특보를 읽어 "영덕군에 호우주의보/호우경보가 걸려 있는가"를 판정한다.
//
// 1순위: 공공데이터포털 기상특보 조회서비스 getPwnStatus (정식 API)
// 2순위: 기상청 특보현황 페이지 (EUC-KR, API 장애 시 대체)
//
// 극한호우·재난성호우·관심단계는 이 파일이 관여하지 않는다(기존 _tiers.js 자체 계산 유지).

const API_URL = "http://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnStatus";
const PAGE_URL = "https://www.weather.go.kr/weather/special/special_day_05.jsp";

// 특보 발표관서: 143 = 대구지방기상청(경북 관할). 실제 응답은 전국 현황이 함께 온다.
const STN_ID = "143";

const PROVINCE = "경상북도";
const AREA = "영덕";

// 화면 단계 키와 맞춘다 (_tiers.js의 key와 동일)
//
// 태풍특보는 호우를 포함하는 상위 특보다. 태풍특보가 발효되면 같은 지역에
// 호우특보는 따로 발표되지 않는 것이 보통이므로 반드시 함께 잡아야 한다.
//   태풍주의보 : 강풍·풍랑·호우·해일이 주의보 기준 도달 예상
//   태풍경보   : 강풍(풍랑) 경보 기준 도달 / 총 강우량 200mm 이상 예상 / 폭풍해일 경보 기준 도달
//
// 강풍특보는 강우 재해가 아니지만 산불 확산·시설물 피해와 직결되므로 함께 반영한다.
// 등급은 호우와 동일하게 맞추되(주의보급/경보급), 조치사항은 화면에서 강풍 전용으로 교체한다.
// family: rain = 강우 조치사항 그대로 사용, wind = 강풍 전용 조치사항으로 교체
// rank는 같은 등급이 겹칠 때의 우선순위다. 강우 앱이므로 태풍·호우가 강풍보다 앞선다.
const WATCH = {
  "태풍경보": { key: "critical", rank: 0, family: "rain" },
  "호우경보": { key: "critical", rank: 1, family: "rain" },
  "강풍경보": { key: "critical", rank: 2, family: "wind" },
  "태풍주의보": { key: "high", rank: 3, family: "rain" },
  "호우주의보": { key: "high", rank: 4, family: "rain" },
  "강풍주의보": { key: "high", rank: 5, family: "wind" },
};

const TIMEOUT_MS = 6000;

// 같은 컨테이너가 살아 있는 동안은 짧게 재사용 (1분 주기 호출 시 과다 요청 방지)
const CACHE_TTL_MS = 45 * 1000;
let memoCache = null;

// ---------- 문자열 파싱 ----------

// "경상북도(" 뒤의 괄호를 짝 맞춰 잘라낸다. 안쪽에 "완도(여서도 제외)" 같은
// 중첩 괄호가 있으므로 단순 정규식으로는 안 되고 깊이를 세어야 한다.
function balancedSegment(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

function provinceSegment(line, province) {
  const idx = line.indexOf(province + "(");
  if (idx === -1) return null;
  return balancedSegment(line, idx + province.length);
}

// 최상위 쉼표로만 분리 (괄호 안 쉼표는 무시)
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * 도(道) 단위 표기를 해석한다. 기상청은 두 가지 형식을 섞어 쓴다.
 *
 *  나열형: 경상북도(구미, 영천, 영덕, 포항)        → 나열된 곳만 발효
 *  제외형: 경상북도(문경, 울진산지 제외)            → 나열된 곳을 뺀 도 전역 발효
 *
 * 제외형을 나열형으로 잘못 읽으면 의미가 정반대가 된다(발효 중인데 없음으로 판정).
 * 목록의 마지막 항목이 "제외"로 끝나면 제외형으로 본다.
 */
function provinceCoverage(line, province) {
  const seg = provinceSegment(line, province);
  if (seg === null) return { mode: "none", list: [] };

  const items = splitTopLevel(seg);
  const last = items.length ? items[items.length - 1] : "";

  if (/제외\s*$/.test(last)) {
    const list = items.map((s) => s.replace(/\s*제외\s*$/, "").trim()).filter(Boolean);
    return { mode: "exclude", list };
  }
  return { mode: "include", list: items };
}

function areaIsUnder(line, province, area) {
  const cov = provinceCoverage(line, province);
  if (cov.mode === "none") return false;

  const norm = (s) => String(s).replace(/\s+/g, "");

  if (cov.mode === "include") {
    // "영덕" 정확 일치 또는 "영덕군"·"영덕평지"처럼 세분 표기까지 포괄
    return cov.list.some((a) => norm(a).startsWith(area));
  }

  // 제외형: 도 전역이 대상이며, 영덕이 통째로 빠진 경우에만 미발효로 본다.
  // "영덕산지 제외"처럼 일부만 빠진 경우는 나머지 지역이 여전히 발효 중이므로 발효로 취급한다.
  const fullyExcluded = cov.list.some((a) => {
    const n = norm(a);
    return n === area || n === area + "군" || n === area + "시";
  });
  return !fullyExcluded;
}

/**
 * 특보현황 본문 텍스트에서 영덕에 걸린 특보 목록을 뽑는다.
 * 본문 한 줄 예시:
 *   o 호우주의보 : 경상북도(영덕, 포항, 울진평지), 강원도(삼척평지)
 */
function parseWarnings(text) {
  const lines = String(text || "").split(/\r?\n/);
  const hits = [];

  for (const raw of lines) {
    const line = raw.trim();
    // 앞의 "o"는 기상청 통보문의 항목 기호
    const m = line.match(/^o?\s*([가-힣·]+(?:주의보|경보))\s*[:：]\s*(.+)$/);
    if (!m) continue;

    const kind = m[1].trim();
    const body = m[2];

    if (!areaIsUnder(body, PROVINCE, AREA)) continue;

    hits.push(kind);
  }

  return hits;
}

// 영덕에 걸린 특보 중 승격 대상(태풍·호우·강풍)만 골라 가장 높은 단계를 반환
function pickHeavyRain(hits) {
  let best = null;
  for (const kind of hits) {
    const w = WATCH[kind];
    if (!w) continue;
    if (!best || w.rank < best.rank) best = { label: kind, ...w };
  }
  return best;
}

// ---------- 수집 ----------

async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fromApi(timeoutMs) {
  const key = process.env.KMA_API_KEY;
  if (!key) throw new Error("KMA_API_KEY 미설정");

  const url =
    `${API_URL}?serviceKey=${encodeURIComponent(key)}` +
    `&pageNo=1&numOfRows=10&dataType=JSON&stnId=${STN_ID}`;

  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error("API 응답 " + res.status);

  const json = await res.json();
  const header = json?.response?.header || {};
  if (header.resultCode !== "00") {
    throw new Error("API 오류 " + header.resultCode + " " + (header.resultMsg || ""));
  }

  let items = json?.response?.body?.items?.item || [];
  if (!Array.isArray(items)) items = [items];
  if (!items.length) throw new Error("API 항목 없음");

  // t6 = 현재 발효 중인 특보 현황 본문
  const item = items[0];
  return {
    source: "api",
    text: item.t6 || "",
    tm_ef: item.tmEf || null,
    tm_fc: item.tmFc || null,
  };
}

async function fromPage(timeoutMs) {
  const res = await fetchWithTimeout(PAGE_URL, timeoutMs);
  if (!res.ok) throw new Error("페이지 응답 " + res.status);

  const buf = await res.arrayBuffer();
  const html = new TextDecoder("euc-kr").decode(buf);

  // 태그 제거 후 평문화
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|td)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");

  return { source: "page", text, tm_ef: null, tm_fc: null };
}

// ---------- 조기 해제 방지 ----------
//
// 특보현황 문서는 "발효시각(tmEf) 이후의 상태"를 담는다.
// 예: 16:00에 발표하면서 "18:00부터 호우경보 해제"를 반영해 목록에서 빼버린다.
// 이대로 쓰면 아직 유효한 경보가 화면에서 2시간 일찍 꺼진다.
// 그래서 문서에서 빠진 특보는 발효시각이 지날 때까지 붙잡아 둔다.
//
// 반대로 새로 추가된 특보는 일찍 뜨더라도 그대로 둔다(미리 아는 쪽이 안전하다).

const STORE_NAME = "rainfall-history";
const STATE_KEY = "kma-warning-state";

function blobStore(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && event !== "auto" && typeof blobs.connectLambda === "function") {
      blobs.connectLambda(event);
    }
    return blobs.getStore(STORE_NAME);
  } catch (_) {
    return null;
  }
}

// "YYYYMMDDHHmm"(한국시각) -> epoch ms
function kstToEpoch(s) {
  const v = String(s || "");
  if (v.length < 12) return null;
  const y = +v.slice(0, 4), mo = +v.slice(4, 6), d = +v.slice(6, 8);
  const h = +v.slice(8, 10), mi = +v.slice(10, 12);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null;
  return Date.UTC(y, mo - 1, d, h - 9, mi); // KST = UTC+9
}

/**
 * 직전 상태와 비교해 조기 해제를 막는다.
 * @returns {{ all: string[], held: Array<{label:string, until:string}> }}
 */
async function holdReleases(docList, tmEf, event) {
  const store = blobStore(event);
  const now = Date.now();
  const efAt = kstToEpoch(tmEf);

  let prev = null;
  if (store) {
    try {
      prev = await store.get(STATE_KEY, { type: "json" });
    } catch (_) {}
  }

  const prevDoc = Array.isArray(prev && prev.doc) ? prev.doc : [];
  const prevHeld = Array.isArray(prev && prev.held) ? prev.held : [];

  // 1) 아직 유효한 보류분만 남긴다 (문서에 다시 나타났으면 보류 해제)
  const held = prevHeld.filter(
    (h) => h && h.until && new Date(h.until).getTime() > now && !docList.includes(h.label)
  );

  // 2) 이번에 문서에서 사라진 특보 중, 발효시각이 아직 안 된 것은 붙잡아 둔다
  if (efAt && efAt > now) {
    for (const label of prevDoc) {
      if (docList.includes(label)) continue;
      if (held.some((h) => h.label === label)) continue;
      held.push({ label, until: new Date(efAt).toISOString() });
    }
  }

  if (store) {
    try {
      await store.setJSON(STATE_KEY, { doc: docList, held, saved_at: new Date().toISOString() });
    } catch (_) {}
  }

  const all = docList.slice();
  for (const h of held) if (!all.includes(h.label)) all.push(h.label);
  return { all, held };
}

// ---------- 공개 함수 ----------

/**
 * @param {boolean} [force] true면 메모리 캐시를 무시하고 새로 조회
 * @param {number} [timeoutMs] 조회 제한시간. 화면 응답 경로에서는 짧게 준다.
 * @param {object|string|null} [event] Blobs 연결용 이벤트("auto"면 자동주입)
 * @returns {Promise<object>} 특보 판정 결과
 */
async function getWarning(force = false, timeoutMs, event = "auto") {
  if (!force && memoCache && Date.now() - memoCache.at < CACHE_TTL_MS) {
    return { ...memoCache.value, cached: true };
  }

  const errors = [];
  let raw = null;

  for (const fn of [fromApi, fromPage]) {
    try {
      raw = await fn(timeoutMs);
      break;
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e));
    }
  }

  // 두 경로 모두 실패: 특보를 "없음"으로 단정하지 않고 확인 불가로 표시한다.
  if (!raw) {
    const failed = {
      ok: false,
      checked_at: new Date().toISOString(),
      source: null,
      level_key: null,
      level_label: null,
      level_family: null,
      all: [],
      doc: [],
      held: [],
      errors,
    };
    return failed; // 실패는 캐시하지 않는다
  }

  const docHits = parseWarnings(raw.text);

  // 발효시각 전에 사라진 특보는 붙잡아 둔다 (조기 해제 방지)
  let hits = docHits;
  let held = [];
  try {
    const merged = await holdReleases(docHits, raw.tm_ef, event);
    hits = merged.all;
    held = merged.held;
  } catch (_) {}

  const best = pickHeavyRain(hits);

  const value = {
    ok: true,
    checked_at: new Date().toISOString(),
    source: raw.source,
    level_key: best ? best.key : null,
    level_label: best ? best.label : null,
    level_family: best ? best.family : null,
    tm_ef: raw.tm_ef,
    tm_fc: raw.tm_fc,
    all: hits, // 영덕에 걸린 전체 특보 (폭염·강풍 등 포함)
    doc: docHits, // 기상청 문서에 그대로 적힌 목록
    held, // 해제 예정이지만 발효시각까지 유지 중인 특보
    errors,
  };

  memoCache = { at: Date.now(), value };
  return value;
}

module.exports = {
  getWarning,
  // 테스트용 내부 함수
  _parseWarnings: parseWarnings,
  _pickHeavyRain: pickHeavyRain,
  _splitTopLevel: splitTopLevel,
  _provinceSegment: provinceSegment,
};
