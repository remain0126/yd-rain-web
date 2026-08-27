// 영덕 강우 감시 - 모바일 PWA 프론트엔드

const REFRESH_MS = 60 * 1000;

const EUPMYEON_ORDER = [
  "강구면", "남정면", "달산면", "병곡면", "영덕읍",
  "영해면대리", "지품면", "창수면", "축산면",
];
const DISPLAY_NAMES = { "영해면대리": "영해면" };
const dn = (n) => DISPLAY_NAMES[n] || n;

// 119안전센터 관할 (영덕소방서)
const CENTERS = [
  { name: "영덕", full: "영덕119안전센터", towns: ["영덕읍", "달산면", "지품면"] },
  { name: "영해", full: "영해119안전센터", towns: ["영해면대리", "축산면", "병곡면", "창수면"] },
  { name: "강구", full: "강구119안전센터", towns: ["강구면", "남정면"] },
];

// 강우 단계 기준은 서버(_tiers.js)에서 내려받는다 (기준을 한 곳에서만 관리)
let TIERS = [];
let NORMAL = { key: "normal", label: "양호", color: "#00F57A", actions: ["평시 모니터링"] };
const RANK = { extreme: 0, critical: 1, high: 2, low: 3, normal: 4 };

// 기상청이 영덕군에 실제 발효한 특보 (호우·폭염·강풍 등 전체)
let KMA_WARN = null;

const $ = (id) => document.getElementById(id);

function heatColor(v) {
  if (v === null || v === undefined) return null;
  if (v <= 0) return "#64748b";
  if (v < 1) return "#38bdf8";
  if (v < 5) return "#0ea5e9";
  if (v < 10) return "#2563eb";
  if (v < 20) return "#a855f7";
  return "#FF0033";
}

function fmtMm(v) {
  return v === null || v === undefined ? "-" : v + "mm";
}

// 배경색이 어두우면 흰 글자, 밝으면 검은 글자 (배지 가독성)
function isDarkColor(hex) {
  if (!hex || hex[0] !== "#" || hex.length < 7) return false;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // 상대 휘도 (간이)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.55;
}

// ---------- Center status ----------

// ISO 시각 → "18:00"
function fmtHm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  });
}

// 기상청 특보 시각 표기 (YYYYMMDDHHmm → "8.18 18:00")
function fmtTmKma(s) {
  if (!s || String(s).length < 12) return "";
  const v = String(s);
  return `${Number(v.slice(4, 6))}.${Number(v.slice(6, 8))} ${v.slice(8, 10)}:${v.slice(10, 12)}`;
}

// 기상청 특보 칩. 영덕군은 단일 특보구역이라 3개 센터에 동일하게 표시된다.
// 특보가 하나도 없으면 빈 문자열을 반환해 줄 자체가 생기지 않게 한다.
function warnChips() {
  const w = KMA_WARN;
  if (!w || !w.ok || !Array.isArray(w.all) || !w.all.length) return "";
  const heldMap = {};
  if (Array.isArray(w.held)) {
    for (const h of w.held) if (h && h.label) heldMap[h.label] = h.until;
  }
  const chips = w.all
    .map((label) => {
      // 새 색을 만들지 않고 기존 팔레트만 재사용: 경보=적색, 주의보=황색
      const color = /경보$/.test(label) ? "#FF0033" : "#FFE600";
      // 해제 예정이지만 발효시각까지 유지 중인 특보임을 밝힌다
      const until = heldMap[label];
      const tail = until ? ` <small>${fmtHm(until)} 해제예정</small>` : "";
      // 중대경보는 특보 체계의 최상위 단계다(2026.6 신설 폭염중대경보 등).
      // 일반 경보와 같은 색이면 구분이 안 되므로 배경을 채워 무게를 준다.
      const attr = `data-warn="${label}" role="button" tabindex="0"`;
      if (/중대경보$/.test(label)) {
        return `<span class="cc-alert cc-alert-major" ${attr} style="background:${color};border-color:${color};">${label}${tail}</span>`;
      }
      return `<span class="cc-alert" ${attr} style="background:${color}1f;color:${color};border-color:${color}55;">${label}${tail}</span>`;
    })
    .join("");
  return `<div class="cc-alerts"><span class="cc-alerts-k">기상특보</span>${chips}</div>`;
}

// 강풍특보로 승격된 경우에 쓰는 조치사항.
// 강우용 문구("주민 대피 준비 통보" 등)를 그대로 쓰면 상황과 맞지 않으므로 따로 둔다.
// 문구는 필요에 따라 이 자리에서 수정하면 된다.
const WIND_ACTIONS = {
  "강풍주의보": ["간판·가설물 낙하 대비", "산불 확산 위험 확인", "안전조치 출동 대비"],
  "강풍경보": ["시설물 피해 신고 급증 대비", "산불 확산 고위험 경계", "인접 센터 공조 태세 확인"],
};

// 기상청이 실제 발효한 호우·태풍·강풍특보를 반영해 단계를 끌어올린다.
// 자체 계산이 더 높으면(예: 극한호우) 자체 계산을 그대로 유지한다 → 어느 쪽도 놓치지 않는다.
// 승격된 경우 배지 문구는 실제 특보명을 쓴다 (태풍경보를 "호우경보"로 표시하지 않기 위함).
function applyKmaLevel(worst) {
  const w = KMA_WARN;
  if (!w || !w.ok || !w.level_key) return worst;
  const kmaTier = TIERS.find((x) => x.key === w.level_key);
  if (!kmaTier) return worst;
  if ((RANK[kmaTier.key] ?? 9) >= (RANK[worst.key] ?? 9)) return worst;
  const raised = { ...kmaTier, label: w.level_label || kmaTier.label };
  if (w.level_family === "wind" && WIND_ACTIONS[w.level_label]) {
    raised.actions = WIND_ACTIONS[w.level_label];
  }
  return raised;
}

function renderCenters(rows) {
  const el = $("centerStatus");
  const cards = CENTERS.map((c) => {
    let worst = NORMAL;
    let m1 = null, m3 = null, m12 = null;
    let incomplete3 = false, incomplete12 = false;
    const elevated = [];
    c.towns.forEach((t) => {
      const r = rows[t];
      if (!r) return;
      const key = r.risk_key || "normal";
      const tier = key === "normal" ? NORMAL : TIERS.find((x) => x.key === key) || NORMAL;
      if ((RANK[tier.key] ?? 9) < (RANK[worst.key] ?? 9)) worst = tier;
      if (r.recent_1h_mm != null) m1 = m1 === null ? r.recent_1h_mm : Math.max(m1, r.recent_1h_mm);
      if (r.recent_3h_mm != null) m3 = m3 === null ? r.recent_3h_mm : Math.max(m3, r.recent_3h_mm);
      if (r.recent_12h_mm != null) m12 = m12 === null ? r.recent_12h_mm : Math.max(m12, r.recent_12h_mm);
      if (r.window_complete_3h === false) incomplete3 = true;
      if (r.window_complete_12h === false) incomplete12 = true;
      if (key !== "normal") elevated.push(dn(t));
    });
    return { c, worst: applyKmaLevel(worst), m1, m3, m12, elevated, incomplete3, incomplete12 };
  });

  el.innerHTML = cards
    .map(({ c, worst, m1, m3, m12, elevated, incomplete3, incomplete12 }) => {
      const isNormal = worst.key === "normal";
      // 자체 강우 계산 기준으로 구분한다. 기상청 특보와 혼동되지 않도록
      // "특보 대상" 대신 관심지역 / 위험지역으로 표기한다.
      const areaLabel = RANK[worst.key] <= RANK.high ? "위험지역" : "관심지역";
      // 첫 진입에서 카드 위를 한 번 지나가는 빛. 평소에는 화면 밖에 숨어 있다.
      const sheen = `<span class="cc-sheen"></span>`;
      const townsLine = elevated.length
        ? `<div class="cc-towns">${areaLabel} <b>${elevated.join(" · ")}</b></div>`
        : `<div class="cc-towns">관할 ${c.towns.map(dn).join(" · ")}</div>`;
      const actionsLine = isNormal
        ? ""
        : `<div class="cc-actions">▸ ${worst.actions.join(" · ")}</div>`;
      // 사용자가 정한 표시 원칙: 누적 산정에 필요한 시간대가 하나라도 없으면 0mm로 표시
      const warnLine = "";
      return `
        <div class="center-card ${isNormal ? "" : "elevated"}" style="--tier-color:${worst.color};">
          ${sheen}
          <div class="cc-top">
            <span class="cc-name">${c.name}<small>119안전센터</small></span>
            <span class="cc-badge ${isNormal ? "normal" : ""} ${!isNormal && isDarkColor(worst.color) ? "dark-bg" : ""}">${worst.label}</span>
          </div>
          ${warnChips()}
          <div class="cc-metrics">
            <div class="cc-metric"><span class="k">1시간</span><span class="v">${fmtMm(m1)}</span></div>
            <div class="cc-metric"><span class="k">3시간${incomplete3 ? " <i class='mk-part'>일부결측</i>" : ""}</span><span class="v">${fmtMm(m3)}${incomplete3 ? "<i class='mk-star'>*</i>" : ""}</span></div>
            <div class="cc-metric"><span class="k">12시간${incomplete12 ? " <i class='mk-part'>일부결측</i>" : ""}</span><span class="v">${fmtMm(m12)}${incomplete12 ? "<i class='mk-star'>*</i>" : ""}</span></div>
          </div>
          ${townsLine}
          ${actionsLine}
          ${warnLine}
        </div>`;
    })
    .join("");
}

// ---------- Ranking ----------

function renderRanking(rows) {
  const el = $("ranking");
  const items = EUPMYEON_ORDER.filter((n) => rows[n]).map((n) => {
    const r = rows[n];
    return {
      name: n,
      value: r["오늘누계"],
      riskKey: r.risk_key || "normal",
      riskLabel: r.risk_label || "양호",
      riskColor: r.risk_color || NORMAL.color,
    };
  });
  items.sort((a, b) => (b.value || 0) - (a.value || 0));
  const max = Math.max(0, ...items.map((i) => Number(i.value) || 0));

  el.innerHTML = items
    .map((it, idx) => {
      const value = Number(it.value) || 0;
      const hasRain = value > 0;
      const pct = hasRain && max > 0 ? Math.max(3, (value / max) * 100) : 0;
      const rankColor =
        hasRain && idx === 0 ? "#FFE600" : hasRain && idx === 1 ? "#cbd5e1" : hasRain && idx === 2 ? "#d97706" : "var(--muted)";
      // 관심단계는 경계지역, 주의보급 이상은 위험지역으로 구분해 표시한다.
      // (자체 강우 계산 기준이므로 읍면마다 다르게 나타난다)
      const rk = RANK[it.riskKey];
      const zone = rk <= RANK.high ? "위험지역" : rk === RANK.low ? "경계지역" : "";
      const badge = zone
        ? `<span class="rk-zone" style="background:${it.riskColor}22;color:${it.riskColor};border-color:${it.riskColor}66;">${zone}</span>`
        : "";
      const fillColor = it.riskKey !== "normal" ? `background:${it.riskColor};` : "";
      return `
        <div class="rk-row">
          <span class="rk-num" style="color:${rankColor};">${idx + 1}</span>
          <span class="rk-name">${dn(it.name)}</span>
          <span class="rk-track"><span class="rk-fill" style="width:${pct}%;${fillColor}"></span></span>
          ${badge}
          <span class="rk-val">${fmtMm(it.value)}</span>
        </div>`;
    })
    .join("");
}

// ---------- Sparkline ----------

// 시간 한 칸의 너비. 좁은 화면에서는 최소값을 쓰고,
// 화면이 넓으면 남는 폭만큼 벌려 그래프가 폭을 다 쓰게 한다.
const SP_W_MIN = 15, SP_W_MAX = 46, SP_H = 34, SP_PAD = 3;

function sparkline(hourValues, nowIdx, spW) {
  const n = hourValues.length || 24;
  const SP_W = spW || SP_W_MIN;
  const width = n * SP_W;
  const AXIS_H = 12; // 하단 시각 라벨 영역
  const totalH = SP_H + AXIS_H;
  const plotH = SP_H - SP_PAD * 2;
  const nums = hourValues.filter((v) => v != null);
  const max = Math.max(1, ...nums);
  const known = hourValues.map((v, i) => (v == null ? null : { i, v })).filter(Boolean);

  const grid = Array.from({ length: n }, (_, i) => {
    const x = i * SP_W + SP_W / 2;
    const major = (i + 1) % 6 === 0;
    return `<line x1="${x}" y1="0" x2="${x}" y2="${SP_H}" stroke="${major ? "#2c3d52" : "#182534"}" stroke-width="1"/>`;
  }).join("");
  const base = `<line x1="0" y1="${SP_H - SP_PAD}" x2="${width}" y2="${SP_H - SP_PAD}" stroke="#2c3d52" stroke-width="1"/>`;

  // 그래프 바로 아래 시각(시) 라벨 — 1~24 매시간 전부 표기(6시간 단위 강조)
  const axis = Array.from({ length: n }, (_, i) => {
    const h = i + 1;
    const x = i * SP_W + SP_W / 2;
    const major = h % 6 === 0;
    return `<text x="${x}" y="${SP_H + 9}" font-size="${major ? "7.5" : "6.5"}" fill="${major ? "#c3cedb" : "#6b7a8d"}" font-weight="${major ? "700" : "400"}" text-anchor="middle">${h}</text>`;
  }).join("");

  const nowMarker = (h2) => {
    if (nowIdx == null || nowIdx < 0 || nowIdx >= n) return "";
    const nx = nowIdx * SP_W + SP_W / 2;
    return `<line x1="${nx}" y1="0" x2="${nx}" y2="${h2}" stroke="#FF0033" stroke-width="1.2" stroke-dasharray="3,3" opacity="0.7"/>`;
  };

  if (!known.length) {
    return `<svg width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}">${grid}${base}${axis}${nowMarker(SP_H)}</svg>`;
  }

  const y = (v) => SP_H - SP_PAD - (v / max) * plotH;
  const x = (i) => i * SP_W + SP_W / 2;
  const line = known.map((k) => `${x(k.i)},${y(k.v).toFixed(1)}`).join(" ");
  const area = `${x(known[0].i)},${SP_H - SP_PAD} ${line} ${x(known[known.length - 1].i)},${SP_H - SP_PAD}`;
  const dots = known
    .map((k) => `<circle cx="${x(k.i)}" cy="${y(k.v).toFixed(1)}" r="2.2" fill="${heatColor(k.v)}" stroke="#0a0f16" stroke-width="0.8"><title>${k.i + 1}시: ${k.v}mm</title></circle>`)
    .join("");

  return `<svg width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}">${grid}${base}<polygon points="${area}" fill="#38bdf8" opacity="0.14"/><polyline points="${line}" fill="none" stroke="#38bdf8" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}${axis}${nowMarker(SP_H)}</svg>`;
}

// ---------- Detail list ----------

// 창 크기가 바뀌면 칸 너비를 다시 계산해 그린다
let lastDetail = null;
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (!lastDetail) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderDetail(lastDetail.rows, lastDetail.columns), 200);
});

function renderDetail(rows, columns) {
  const el = $("detailList");
  const hourCols = columns.filter((c) => /^\d{2}시$/.test(c));

  // 그릴 수 있는 폭을 재서 칸 너비를 정한다.
  // PC에서는 한 칸이 넓어져 그래프가 화면을 가득 채운다.
  const avail = Math.max(0, (el.clientWidth || 0) - 20);
  const cols = hourCols.length || 24;
  const spW = Math.max(SP_W_MIN, Math.min(SP_W_MAX, Math.floor(avail / cols)));

  const allNames = Object.keys(rows);
  let lastIdx = -1;
  allNames.forEach((name) => {
    hourCols.forEach((c, i) => {
      if (rows[name][c] != null && i > lastIdx) lastIdx = i;
    });
  });
  const nowIdx = lastIdx + 1;

  const item = (name, sub) => {
    const r = rows[name];
    const hv = hourCols.map((c) => r[c]);
    return `
      <div class="dt-item">
        <div class="dt-top">
          <span class="dt-name ${sub ? "sub" : ""}">${dn(name)}</span>
          <span class="dt-nums">전날 <b>${fmtMm(r["전날누적"])}</b> · 오늘 <b>${fmtMm(r["오늘누계"])}</b> · 당월 <b>${fmtMm(r["당월누계"])}</b></span>
        </div>
        <div class="dt-spark">${sparkline(hv, nowIdx, spW)}</div>
      </div>`;
  };

  lastDetail = { rows, columns };

  const eup = EUPMYEON_ORDER.filter((n) => rows[n]);
  const etc = allNames.filter((n) => !EUPMYEON_ORDER.includes(n)).sort((a, b) => a.localeCompare(b, "ko"));

  el.innerHTML =
    eup.map((n) => item(n, false)).join("") +
    (etc.length
      ? `<div class="etc-divider">기타 관측지점 ${etc.length}개</div>` + etc.map((n) => item(n, true)).join("")
      : "");
}

// ---------- Tier cards ----------

function renderTierCards() {
  const el = $("tierCards");
  if (!TIERS.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = TIERS.map(
    (t) => `
    <div class="tier-c" style="--tier-color:${t.color};">
      <div class="tier-c-top">
        <span class="tier-c-badge ${isDarkColor(t.color) ? "dark-bg" : ""}">${t.label}</span>
        <span class="tier-c-trigger">${t.trigger}</span>
      </div>
      <div class="tier-c-crit">${t.criteria}</div>
      <div class="tier-c-act">${t.actions.join(" · ")}</div>
    </div>`
  ).join("");
}

// ---------- Fetch & orchestrate ----------

const LS_KEY = "yd_rain_last";

// 마지막 성공 데이터를 브라우저에 저장 (재방문 시 즉시 표시용)
function saveLocal(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {}
}
function loadLocal() {
  try {
    const s = localStorage.getItem(LS_KEY);
    return s ? JSON.parse(s) : null;
  } catch (_) { return null; }
}

// 마지막으로 본 화면을 다시 꺼내 쓸 때의 표시.
//
// 앱을 열면 저장해 둔 화면을 먼저 그려 즉시 뜨게 한다. 그런데 오래 닫아두었다가
// 열면 몇 분 전 숫자가 최신인 것처럼 보인다. 재난 상황에서 이는 위험하다.
//
// 그렇다고 빈 화면으로 두는 것은 더 나쁘다. 통신이 끊긴 현장에서는 묵은 숫자라도
// 있는 편이 낫다. 그래서 지우지 않고, 옛 화면임을 분명히 밝힌 뒤
// 새 자료가 오면 조용히 바꿔 끼운다.
// 첫 진입 연출.
//
// 카드가 아래에서 밀려 올라오며 자리를 잡는다. 자료가 처음 그려질 때만
// 한 번 돈다. 1분마다 갱신될 때마다 들썩이면 숫자를 읽기 어렵고,
// 재난 화면으로서 산만하다.
let introDone = false;

// 그리기 전에 미리 걸어둔다.
//
// 카드를 먼저 그린 다음 연출을 붙이면, 완성된 화면이 한 순간 보였다가
// 처음으로 되감기며 다시 올라온다. 두 번 뜨는 것처럼 보인다.
// 그래서 상자에 클래스를 먼저 걸어두고, 그 안에 카드를 채워 넣는다.
function armIntro() {
  if (introDone) return false;
  introDone = true;
  const el = $("centerStatus");
  if (el) el.classList.add("stage-in");
  return true;
}

// 카드를 그린 직후에 부른다
function finishIntro(armed) {
  if (!armed) return;

  const el = $("centerStatus");
  // 연출이 끝나면 떼어낸다. 남겨두면 갱신 때마다 카드가 다시 들썩인다.
  if (el) setTimeout(() => el.classList.remove("stage-in"), 2600);

  document.querySelectorAll(".center-card.elevated").forEach((c) => {
    c.classList.add("stage-glow");
  });

  const head = document.querySelector(".app-sub");
  if (head) head.classList.add("head-in");
}

// 읍면 순위는 화면을 내려야 보인다. 첫 진입에 같이 돌려버리면
// 아무도 못 보는 사이에 끝나므로, 눈에 들어온 순간에 한 번만 돌린다.
let barsShown = false;

function watchRanking() {
  const el = $("ranking");
  if (!el || barsShown || typeof IntersectionObserver !== "function") return;

  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      barsShown = true;
      io.disconnect();
      el.classList.add("reveal-bars");
      // 클래스를 남겨두면 1분마다 새로 그려진 막대까지 다시 자란다.
      // 연출이 끝나면 떼어낸다.
      setTimeout(() => el.classList.remove("reveal-bars"), 2200);
    },
    {
      // 화면 아래쪽 25%는 아직 안 본 것으로 친다.
      // 그러지 않으면 앱을 열었을 때 순위표 윗부분이 살짝 걸쳐 있는 것만으로
      // 연출이 시작돼, 정작 스크롤해서 보면 이미 끝나 있다.
      rootMargin: "0px 0px -25% 0px",
      threshold: 0.2,
    }
  );
  io.observe(el);
}

function markCachedView(data) {
  const t = data && (data.fetched_at || data.stored_at);
  const hm = t
    ? new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : "—";
  const el = $("updatedAt");
  if (el) el.innerHTML = `자료기준 <b>${hm}</b> · 새 자료 확인 중`;
  const st = $("rainState");
  if (st) st.textContent = "이전 화면";
  const band = $("statusBand");
  if (band) band.style.setProperty("--band-color", "#8291a3");
  const dot = $("connDot");
  if (dot) dot.className = "dot dot-stale";
}

function paint(data, opts) {
  const rows = data.rows || {};
  const columns = data.columns || [];

  // 서버가 내려준 강우 단계 기준을 반영 (기준 변경 시 서버만 고치면 됨)
  if (Array.isArray(data.tiers) && data.tiers.length) {
    TIERS = data.tiers;
    if (data.normal) NORMAL = data.normal;
    renderTierCards();
  }

  // 기상청 특보 반영 (조회 실패 시에는 직전 값을 유지해 표시가 깜빡이지 않게 한다)
  if (data.kma_warning && data.kma_warning.ok) KMA_WARN = data.kma_warning;

  renderCenters(rows);

  // 상황실 경보음: 세 센터 중 가장 높은 단계가 직전보다 올라가면 울린다
  try {
    const worstRank = CENTERS.reduce((acc, c) => {
      const names = (c.towns || []).map((t) => t);
      let r = 4;
      for (const n of names) {
        const row = rows[n];
        if (row && RANK[row.risk_key] != null) r = Math.min(r, RANK[row.risk_key]);
      }
      return Math.min(acc, r);
    }, 4);
    const kmaRank = KMA_WARN && KMA_WARN.ok && KMA_WARN.level_key ? RANK[KMA_WARN.level_key] : 4;
    const overall = Math.min(worstRank, kmaRank == null ? 4 : kmaRank);
    checkAlarm(overall);
    curRank = overall;
    if (typeof ackCurrent === "function") ackCurrent(overall);
  } catch (_) {}
  renderRanking(rows);
  renderDetail(rows, columns);

  // 군청 자료의 날짜에 요일을 붙여 보여준다.
  // 자정을 넘겨도 자료의 날짜를 따라가므로 화면과 숫자가 어긋나지 않는다.
  const dm = String(data.date_label || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dm) {
    const dd = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]));
    const wd = ["일", "월", "화", "수", "목", "금", "토"][dd.getDay()];
    $("dateLabel").innerHTML =
      `${Number(dm[1])}년 ${Number(dm[2])}월 ${Number(dm[3])}일 <b>${wd}요일</b>`;
  } else {
    $("dateLabel").textContent = "영덕군 재난안전대책본부 관측망";
  }

  const t = new Date(data.fetched_at || data.stored_at || Date.now());
  const nowTime = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

  // 자료기준 시각: 오늘 자료면 시:분, 어제 이전이면 날짜까지 붙여 명확히
  const now = new Date();
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  const hm = t.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const mo = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  const dataStamp = sameDay ? hm : `${mo}/${d} ${hm}`;

  const anyRain = Object.values(rows).some(
    (r) => (r["오늘누계"] || 0) > 0 || (r["전날누적"] || 0) > 0
  );
  // 상태 띠. 가장 높은 단계를 띠 색으로 삼는다.
  // 강우가 없으면 양호 색으로 두어 평상시임을 알린다.
  const worstKey = Object.values(rows).reduce((acc, r) => {
    const k = r.risk_key || "normal";
    return RANK[k] < RANK[acc] ? k : acc;
  }, "normal");
  const worstTier = worstKey === "normal" ? NORMAL : TIERS.find((t) => t.key === worstKey) || NORMAL;

  const band = $("statusBand");
  if (band) band.style.setProperty("--band-color", worstTier.color);
  const stateEl = $("rainState");
  if (stateEl) stateEl.textContent = anyRain ? worstTier.label : "무강우";

  // 항상 "자료기준 · 확인" 형식으로 표시 (실패/지연 문구 없이 신뢰성 유지).
  // 점 색: 확인 시점과 자료기준이 크게 벌어지면(20분 초과) 주황으로만 '오래됨'을 은근히 표시.
  $("updatedAt").innerHTML =
    `자료기준 <b>${dataStamp}</b> · 확인 <b>${nowTime}</b>`;

  const ageMin = (now.getTime() - t.getTime()) / 60000;
  if (ageMin > 20) {
    $("connDot").className = "dot dot-stale";
  } else {
    $("connDot").className = "dot dot-ok";
  }
}

let retryTimer = null;
function scheduleRetry(ms = 25000) {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    load(false);
  }, ms);
}

// 접속 집계용 임의 식별자. 개인을 식별하는 정보가 아니며,
// 브라우저 저장소에만 남아 있어 지우면 새로 발급된다.
function visitorId() {
  try {
    let v = localStorage.getItem("yd_vid");
    if (!v) {
      v = Math.random().toString(36).slice(2, 10);
      localStorage.setItem("yd_vid", v);
    }
    return v;
  } catch (_) {
    return "anon";
  }
}

async function load(force) {
  const icon = $("refreshIcon");
  icon.classList.add("spin");
  try {
    const sep = force ? "?fresh=1&" : "?";
    const url = "/api/rainfall" + sep + "v=" + visitorId() + "&_=" + Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));

    // 최초 스냅샷 생성 중: 기존 로컬 자료를 유지하고 잠시 후 자동 재시도.
    if (res.status === 202 || data.pending) {
      const local = loadLocal();
      if (local) {
        paint(local, { cachedView: true });
        markCachedView(local);
      } else {
        $("updatedAt").textContent = "자료 수집 중 · 잠시 후 자동 갱신";
        $("connDot").className = "dot dot-stale";
      }
      scheduleRetry(25000);
      return;
    }

    if (!res.ok) throw new Error("서버 응답 " + res.status);
    if (data.error) throw new Error(data.error);

    firstPaintDone = true;
    clearTimeout(cachedTimer);
    const armed = armIntro();
    paint(data, { cachedView: false });
    finishIntro(armed);
    // 순위표는 화면에 들어올 때 따로 돈다. 첫 진입 연출과 별개다.
    watchRanking();
    saveLocal(data);

    // 수동 새로고침 또는 오래된 자료로 인해 백그라운드 수집을 요청했다면
    // 실제 저장이 끝난 뒤 한 번 더 읽어 화면을 교체한다.
    if (data.refresh_requested) scheduleRetry(25000);
  } catch (e) {
    const local = loadLocal();
    if (local) {
      firstPaintDone = true;
      clearTimeout(cachedTimer);
      const armed = armIntro();
      paint(local, { cachedView: true });
      finishIntro(armed);
      markCachedView(local);
    } else {
      $("updatedAt").textContent = "자료 수신 대기 중 · 잠시 후 자동 갱신";
      $("connDot").className = "dot dot-stale";
      scheduleRetry(25000);
    }
    console.error(e);
  } finally {
    icon.classList.remove("spin");
  }
}

// 새로고침 버튼 = 강제 최신(fresh), 자동/최초 = 캐시 허용
$("refreshBtn").addEventListener("click", () => load(true));

// 재방문이면 저장된 직전 데이터를 먼저 즉시 그려서 체감 속도 향상,
// 그 뒤 백그라운드로 최신 데이터를 받아 교체
// 저장해 둔 화면을 곧바로 그리면, 0.5초 뒤 새 자료가 도착해 화면이 두 번
// 바뀐다. 서버가 대개 그 안에 답하므로 잠깐 기다렸다가, 그래도 안 오면
// 그때 저장 화면을 띄운다. 통신이 나쁠 때 빈 화면으로 두지 않기 위함이다.
let firstPaintDone = false;
let cachedTimer = null;

$("updatedAt").textContent = "자료 확인 중";

const cached = loadLocal();
if (cached) {
  cachedTimer = setTimeout(() => {
    if (firstPaintDone) return;
    const armed = armIntro();
    paint(cached, { cachedView: true });
    finishIntro(armed);
    markCachedView(cached);
  }, 700);
}

load();
// 1분 주기 자동 새로고침.
// 화면을 보지 않는 동안에는 멈추고, 다시 돌아오면 즉시 한 번 갱신한다.
// (불필요한 호출을 줄이면서, 복귀 시점에는 최신 상태를 바로 보여주기 위함)
let refreshTimer = setInterval(load, REFRESH_MS);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  } else if (!refreshTimer) {
    // 화면으로 돌아온 즉시 확인 처리한다. 자료 갱신을 기다리면
    // 그 사이 발송이 한 번 더 나갈 수 있다.
    if (typeof ackCurrent === "function" && curRank != null) ackCurrent(curRank);
    load();
    refreshTimer = setInterval(load, REFRESH_MS);
  }
});

// PWA service worker 등록
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ---------- 웹 푸시 (강제 방식) ----------
//
// 앱 안에서는 알림을 끌 수 없다. 켜지 않은 상태면 상단에 붉은 경고 띠가
// 계속 떠 있고, 켜면 사라진다. 끄려면 휴대폰 설정에 직접 들어가야 한다.
//
// 브라우저 정책상 "권한 허용"만은 사용자가 직접 눌러야 한다. 우회할 수 없으므로
// 대신 켤 때까지 경고를 계속 노출하는 방식으로 사실상 강제한다.

const pushBanner = document.getElementById("pushBanner");
const pushBannerText = document.getElementById("pushBannerText");
const pushBannerBtn = document.getElementById("pushBannerBtn");
const pushNote = document.getElementById("pushNote");

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let bannerTimer = null;

// autoHideMs를 주면 그 시간 동안 깜빡인 뒤 흐려지며 사라진다.
// 사용자가 지금 당장 할 수 있는 일이 없는 안내에만 쓴다.
// "꺼져 있음"·"차단됨"처럼 조치가 필요한 경고는 그대로 남는다.
function banner(html, btnLabel, onClick, autoHideMs) {
  if (!pushBanner) return;
  clearTimeout(bannerTimer);
  pushBanner.classList.remove("pb-flash", "pb-out");
  pushBanner.hidden = false;
  pushBannerText.innerHTML = html;
  if (btnLabel) {
    pushBannerBtn.hidden = false;
    pushBannerBtn.textContent = btnLabel;
    pushBannerBtn.onclick = onClick;
  } else {
    pushBannerBtn.hidden = true;
    pushBannerBtn.onclick = null;
  }
  if (autoHideMs) {
    void pushBanner.offsetWidth;
    pushBanner.classList.add("pb-flash");
    bannerTimer = setTimeout(() => {
      pushBanner.classList.remove("pb-flash");
      pushBanner.classList.add("pb-out");
      bannerTimer = setTimeout(hideBanner, 400);
    }, autoHideMs);
  }
}
function hideBanner() {
  if (!pushBanner) return;
  clearTimeout(bannerTimer);
  pushBanner.classList.remove("pb-flash", "pb-out");
  pushBanner.hidden = true;
  pushBannerText.innerHTML = "";
  pushBannerBtn.hidden = true;
}
function note(html) {
  if (!pushNote) return;
  pushNote.innerHTML = html;
  pushNote.hidden = false;
  setTimeout(() => { if (pushNote) pushNote.hidden = true; }, 6000);
}

function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function currentSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// 권한이 이미 허용된 상태면 사용자 조작 없이 조용히 등록한다.
async function subscribeSilently() {
  const info = await fetch("/api/push").then((r) => r.json());
  if (!info.configured || !info.public_key) throw new Error("서버 알림 설정 없음");

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const already = !!sub;
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.public_key),
    });
  }

  // 이미 등록된 구독이면 서버에 다시 보내지 않는다.
  // 불필요한 갱신을 줄이고, 확인 상태가 초기화될 여지를 없앤다.
  if (already) return sub;

  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "subscribe", subscription: sub.toJSON() }),
  }).then((r) => r.json());

  if (!res.ok) throw new Error(res.error || "등록 실패");
  return sub;
}

async function requestAndSubscribe() {
  const perm = await Notification.requestPermission();
  if (perm === "granted") {
    try {
      await subscribeSilently();
      hideBanner();
      note("알림이 <b>켜졌습니다</b>.");
    } catch (e) {
      banner("알림 등록에 실패했습니다.<small>" + String(e && e.message) + "</small>", "다시 시도", requestAndSubscribe);
    }
    return;
  }
  if (perm === "denied") {
    banner(
      "알림이 <b>차단</b>되어 있습니다 — 재난 상황을 받을 수 없습니다." +
        "<small>휴대폰 설정 → 브라우저 → 알림에서 이 사이트를 허용해 주세요.</small>"
    );
    return;
  }
  banner("알림이 <b>꺼져 있습니다</b> — 재난 상황을 받을 수 없습니다.", "지금 켜기", requestAndSubscribe);
}

async function initPush() {
  if (!pushBanner) return;

  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  if (!supported) {
    if (isIOS && !isStandalone) {
      banner(
        "이 화면에서는 알림을 받을 수 없습니다." +
          "<small>사파리 아래 공유 버튼 → '홈 화면에 추가' 후, 추가된 아이콘으로 열어 주세요.</small>",
        null, null, 5000
      );
    } else {
      banner(
        "이 브라우저는 알림을 지원하지 않습니다." +
          "<small>웹앱 설치 후 알림을 설정해 주세요.</small>",
        null, null, 5000
      );
    }
    return;
  }

  if (Notification.permission === "granted") {
    try {
      await subscribeSilently();
      hideBanner();
    } catch (_) {
      banner("알림 등록을 확인하지 못했습니다.", "다시 시도", requestAndSubscribe);
    }
    return;
  }

  if (Notification.permission === "denied") {
    banner(
      "알림이 <b>차단</b>되어 있습니다 — 재난 상황을 받을 수 없습니다." +
        "<small>휴대폰 설정 → 브라우저 → 알림에서 이 사이트를 허용해 주세요.</small>"
    );
    return;
  }

  banner("알림이 <b>꺼져 있습니다</b> — 재난 상황을 받을 수 없습니다.", "지금 켜기", requestAndSubscribe);
}

// ---------- 로고 2초 길게 누르기 = 알림 켜기/끄기 ----------
//
// 웹에서는 휴대폰의 알림 설정 자체를 건드릴 수 없다. 브라우저가 막아 두었고
// 우회 방법은 없다. 여기서 켜고 끄는 것은 "이 앱의 푸시 구독"이다.
// 끄면 서버가 이 기기로 보내지 않으므로 결과는 같지만, 한 번 "차단"으로
// 눌러 버린 권한은 휴대폰 설정에서 직접 풀어야 한다.

async function unsubscribePush() {
  const sub = await currentSub();
  if (!sub) return false;
  await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "unsubscribe", endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  return true;
}

async function togglePush() {
  const supported =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  if (!supported) {
    note(
      isIOS && !isStandalone
        ? "홈 화면에 추가한 뒤 그 아이콘으로 열어야 알림을 켤 수 있습니다."
        : "이 브라우저는 알림을 지원하지 않습니다. 웹앱을 설치해 주세요."
    );
    return;
  }

  const sub = await currentSub().catch(() => null);
  if (sub) {
    try {
      await unsubscribePush();
      note("알림을 <b>껐습니다</b>. 로고를 2초 누르면 다시 켜집니다.");
      banner("알림이 <b>꺼져 있습니다</b> — 재난 상황을 받을 수 없습니다.", "지금 켜기", requestAndSubscribe);
    } catch (_) {
      note("알림을 끄지 못했습니다.");
    }
    return;
  }

  if (Notification.permission === "denied") {
    note("알림이 <b>차단</b>되어 있습니다. 휴대폰 설정 → 브라우저 → 알림에서 허용해 주세요.");
    return;
  }
  await requestAndSubscribe();
}

(function bindBrandHold() {
  const el = document.getElementById("brandBtn");
  if (!el) return;
  let timer = null;
  let long = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = null;
    el.classList.remove("holding");
  };

  el.addEventListener("pointerdown", () => {
    long = false;
    el.classList.add("holding");
    timer = setTimeout(() => {
      long = true;
      el.classList.remove("holding");
      if (navigator.vibrate) navigator.vibrate(30);
      togglePush();
    }, 2000);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((t) =>
    el.addEventListener(t, cancel)
  );
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    if (long) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();

// 새로고침 버튼을 길게 누르면 시험 알림을 보낸다 (별도 버튼 없이 점검용)
(function bindPushTest() {
  const btn = document.getElementById("refreshBtn");
  if (!btn) return;
  let timer = null;
  let long = false;
  btn.addEventListener("pointerdown", () => {
    long = false;
    timer = setTimeout(async () => {
      long = true;
      const sub = await currentSub().catch(() => null);
      if (!sub) return note("먼저 알림을 켜 주세요.");
      note("시험 발송 중…");
      const res = await fetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", endpoint: sub.endpoint }),
      }).then((r) => r.json()).catch(() => null);
      note(res && res.ok && res.sent > 0
        ? "시험 알림을 보냈습니다."
        : "시험 발송 실패: " + (res && res.error ? res.error : "알 수 없는 오류"));
    }, 800);
  });
  btn.addEventListener("pointerup", () => clearTimeout(timer));
  btn.addEventListener("pointerleave", () => clearTimeout(timer));
  btn.addEventListener("click", (e) => { if (long) { e.preventDefault(); e.stopPropagation(); } }, true);
})();

// ---------- 상황실 경보음 ----------
//
// 화면을 열어둔 PC에서 단계가 오르면 소리로 알린다. 알림 권한과 무관하게 동작한다.
// 다만 브라우저 정책상 사용자가 화면을 한 번이라도 누른 뒤에야 소리가 난다.

let audioCtx = null;
let lastAlarmRank = null;

function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_) {}
}
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });

// 단계가 높을수록 더 급하게 울린다
function playAlarm(rank) {
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

  const plan =
    rank <= 1 ? { beeps: 5, freq: 1180, gap: 0.26, len: 0.2 } // 경보급 이상
      : rank === 2 ? { beeps: 3, freq: 940, gap: 0.32, len: 0.2 } // 주의보급
        : { beeps: 2, freq: 760, gap: 0.4, len: 0.18 }; // 관심단계

  const t0 = audioCtx.currentTime;
  for (let i = 0; i < plan.beeps; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.value = plan.freq;
    const st = t0 + i * plan.gap;
    gain.gain.setValueAtTime(0.0001, st);
    gain.gain.exponentialRampToValueAtTime(0.18, st + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, st + plan.len);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(st);
    osc.stop(st + plan.len + 0.05);
  }
}

// paint()가 부른다. 단계가 이전보다 올라갔을 때만 울린다.
function checkAlarm(worstRank) {
  if (worstRank == null || worstRank >= 4) { // 4 = 양호
    lastAlarmRank = worstRank;
    return;
  }
  if (lastAlarmRank == null) { lastAlarmRank = worstRank; return; }
  if (worstRank < lastAlarmRank) playAlarm(worstRank);
  lastAlarmRank = worstRank;
}

initPush();

// ---------- 특보 상세 팝업 ----------
//
// 칩이 좁아 시각을 다 담을 수 없으므로, 누르면 발표·발효 시각을 팝업으로 보여준다.
// 발효 중인 특보만 화면에 남으므로 해제시각은 표시하지 않는다.

// 칩은 좁으므로 시각만 적고, 날짜와 요일은 칩을 눌러 여는 팝업에서 밝힌다.
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

function fmtReleaseFull(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAY[d.getDay()]}) ${fmtHm(iso)}`;
}

// 기상청 시각 문자열(YYYYMMDDHHmm)을 표기용으로 바꾼다.
// 해제예정과 같은 형식이 되도록 요일까지 붙인다.
function fmtKmaTm(v) {
  const s = String(v || "");
  if (s.length < 12) return "—";
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const da = Number(s.slice(6, 8));
  const d = new Date(y, mo - 1, da);
  const wd = isNaN(d.getTime()) ? "" : `(${WEEKDAY[d.getDay()]})`;
  return `${mo}월 ${da}일${wd} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

function closeWarnPopup() {
  const el = document.getElementById("warnPopup");
  if (el) el.remove();
}

// 화면에 그려둔 해제예정 정보를 마지막 자료에서 찾아 쓴다
function heldUntil(label) {
  const w = KMA_WARN || {};
  if (!Array.isArray(w.held)) return null;
  const h = w.held.find((x) => x && x.label === label);
  return h ? h.until : null;
}

function openWarnPopup(label) {
  closeWarnPopup();

  const w = KMA_WARN || {};
  const t = (w.times && w.times[label]) || {};
  const isAlert = /경보$/.test(label);
  const color = isAlert ? "#FF0033" : "#FFE600";

  const rows = [
    ["발표", fmtKmaTm(t.tm_fc)],
    ["발효", fmtKmaTm(t.tm_ef)],
    // 해제 예정이 잡혀 있으면 함께 보여준다. 위의 발효는 이 특보가 처음
    // 효력을 얻은 시각이므로, 언제 풀리는지와는 다른 정보다.
    ...(heldUntil(label) ? [["해제예정", fmtReleaseFull(heldUntil(label))]] : []),
  ]
    .map(
      ([k, v]) =>
        `<div class="wp-row"><span class="wp-k">${k}</span><span class="wp-v">${v}</span></div>`
    )
    .join("");

  const missing = !t.tm_fc && !t.tm_ef;

  const el = document.createElement("div");
  el.id = "warnPopup";
  el.className = "wp-back";
  el.innerHTML = `
    <div class="wp-box" role="dialog" aria-label="${label} 상세">
      <div class="wp-title" style="color:${color};">${label}</div>
      <div class="wp-body">${rows}</div>
      ${missing ? '<div class="wp-note">기상청에서 시각을 받아오지 못했습니다.</div>' : ""}
      <button type="button" class="wp-close">닫기</button>
    </div>`;

  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.classList.contains("wp-close")) closeWarnPopup();
  });
  document.addEventListener("keydown", function esc(ev) {
    if (ev.key === "Escape") {
      closeWarnPopup();
      document.removeEventListener("keydown", esc);
    }
  });

  document.body.appendChild(el);
}

// 칩은 매번 새로 그려지므로 상위 요소에서 한 번만 받는다
document.addEventListener("click", (e) => {
  const chip = e.target.closest && e.target.closest(".cc-alert[data-warn]");
  if (chip) openWarnPopup(chip.getAttribute("data-warn"));
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const chip = e.target.closest && e.target.closest(".cc-alert[data-warn]");
  if (chip) {
    e.preventDefault();
    openWarnPopup(chip.getAttribute("data-warn"));
  }
});

// ---------- 확인 처리 ----------
//
// 앱을 열면(또는 화면을 보고 있으면) 자동으로 확인 처리한다.
// 화면에는 아무것도 표시하지 않는다.

let lastAckRank = null;
let curRank = null;

async function postAck(rank) {
  const sub = await navigator.serviceWorker.ready
    .then((r) => r.pushManager.getSubscription())
    .catch(() => null);
  if (!sub) throw new Error("알림이 켜져 있지 않습니다");

  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "ack", endpoint: sub.endpoint, rank }),
  }).then((r) => r.json());

  if (!res.ok) throw new Error(res.error || "확인 실패");
  lastAckRank = rank;
  return res;
}

// 화면을 보고 있으면 자동으로 확인 처리 (단계가 더 나빠지면 서버가 무효화한다)
async function ackCurrent(rank) {
  if (rank == null || rank > RANK.low) return;
  if (lastAckRank !== null && rank >= lastAckRank) return;
  if (document.hidden) return;
  try {
    await postAck(rank);
  } catch (_) {
    // 실패해도 화면에는 아무것도 띄우지 않는다.
    // 다음 갱신(1분 주기)이나 알림의 확인 버튼으로 다시 시도된다.
  }
}

