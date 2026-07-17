// 영덕 강우 감시 - 모바일 PWA 프론트엔드

const REFRESH_MS = 5 * 60 * 1000;

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
let NORMAL = { key: "normal", label: "양호", color: "#34d399", actions: ["평시 모니터링"] };
const RANK = { extreme: 0, critical: 1, high: 2, low: 3, normal: 4 };

const $ = (id) => document.getElementById(id);

function heatColor(v) {
  if (v === null || v === undefined) return null;
  if (v <= 0) return "#64748b";
  if (v < 1) return "#38bdf8";
  if (v < 5) return "#0ea5e9";
  if (v < 10) return "#2563eb";
  if (v < 20) return "#a855f7";
  return "#f43f5e";
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

function renderCenters(rows) {
  const el = $("centerStatus");
  const cards = CENTERS.map((c) => {
    let worst = NORMAL;
    let m1 = null, m3 = null, m12 = null;
    let incomplete = false;
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
      if (r.window_complete_12h === false) incomplete = true;
      if (key !== "normal") elevated.push(dn(t));
    });
    return { c, worst, m1, m3, m12, elevated, incomplete };
  });

  el.innerHTML = cards
    .map(({ c, worst, m1, m3, m12, elevated, incomplete }) => {
      const isNormal = worst.key === "normal";
      const townsLine = elevated.length
        ? `<div class="cc-towns">특보 대상 <b>${elevated.join(" · ")}</b></div>`
        : `<div class="cc-towns">관할 ${c.towns.map(dn).join(" · ")}</div>`;
      const actionsLine = isNormal
        ? ""
        : `<div class="cc-actions">▸ ${worst.actions.join(" · ")}</div>`;
      const warnLine = incomplete
        ? `<div class="cc-warn">※ 누적 이력이 아직 부족해 12시간 값이 불완전할 수 있음</div>`
        : "";
      return `
        <div class="center-card ${isNormal ? "" : "elevated"}" style="--tier-color:${worst.color};">
          <div class="cc-top">
            <span class="cc-name">${c.name}<small>119안전센터</small></span>
            <span class="cc-badge ${isNormal ? "normal" : ""} ${!isNormal && isDarkColor(worst.color) ? "dark-bg" : ""}">${worst.label}</span>
          </div>
          <div class="cc-metrics">
            <div class="cc-metric"><span class="k">1시간</span><span class="v">${fmtMm(m1)}</span></div>
            <div class="cc-metric"><span class="k">3시간</span><span class="v">${fmtMm(m3)}</span></div>
            <div class="cc-metric"><span class="k">12시간</span><span class="v">${fmtMm(m12)}</span></div>
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
        hasRain && idx === 0 ? "#fbbf24" : hasRain && idx === 1 ? "#cbd5e1" : hasRain && idx === 2 ? "#d97706" : "var(--muted)";
      const badge =
        it.riskKey !== "normal"
          ? `<span class="rk-badge" style="background:${it.riskColor}22;color:${it.riskColor};">${it.riskLabel}</span>`
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

const SP_W = 15, SP_H = 34, SP_PAD = 3;

function sparkline(hourValues, nowIdx) {
  const n = hourValues.length || 24;
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
    return `<line x1="${nx}" y1="0" x2="${nx}" y2="${h2}" stroke="#f43f5e" stroke-width="1.2" stroke-dasharray="3,3" opacity="0.7"/>`;
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

function renderDetail(rows, columns) {
  const el = $("detailList");
  const hourCols = columns.filter((c) => /^\d{2}시$/.test(c));

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
        <div class="dt-spark">${sparkline(hv, nowIdx)}</div>
      </div>`;
  };

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

function paint(data, opts) {
  const rows = data.rows || {};
  const columns = data.columns || [];

  // 서버가 내려준 강우 단계 기준을 반영 (기준 변경 시 서버만 고치면 됨)
  if (Array.isArray(data.tiers) && data.tiers.length) {
    TIERS = data.tiers;
    if (data.normal) NORMAL = data.normal;
    renderTierCards();
  }

  renderCenters(rows);
  renderRanking(rows);
  renderDetail(rows, columns);

  $("dateLabel").textContent = data.date_label
    ? data.date_label.replace("당일", "").replace("시간별 강우량", "").trim() + " 기준"
    : "영덕군 재난안전대책본부 관측망";

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
  const noRainNote = anyRain ? "" : " · 현재 무강우";

  // 항상 "자료기준 · 확인" 형식으로 표시 (실패/지연 문구 없이 신뢰성 유지).
  // 점 색: 확인 시점과 자료기준이 크게 벌어지면(20분 초과) 주황으로만 '오래됨'을 은근히 표시.
  $("updatedAt").textContent = "자료기준 " + dataStamp + " · 확인 " + nowTime + noRainNote;

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

async function load(force) {
  const icon = $("refreshIcon");
  icon.classList.add("spin");
  try {
    const sep = force ? "?fresh=1&" : "?";
    const url = "/api/rainfall" + sep + "_=" + Date.now();
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
      } else {
        $("updatedAt").textContent = "자료 수집 중 · 잠시 후 자동 갱신";
        $("connDot").className = "dot dot-stale";
      }
      scheduleRetry(25000);
      return;
    }

    if (!res.ok) throw new Error("서버 응답 " + res.status);
    if (data.error) throw new Error(data.error);

    paint(data, { cachedView: false });
    saveLocal(data);

    // 수동 새로고침 또는 오래된 자료로 인해 백그라운드 수집을 요청했다면
    // 실제 저장이 끝난 뒤 한 번 더 읽어 화면을 교체한다.
    if (data.refresh_requested) scheduleRetry(25000);
  } catch (e) {
    const local = loadLocal();
    if (local) {
      paint(local, { cachedView: true });
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
const cached = loadLocal();
if (cached) paint(cached, { cachedView: true });

load();
setInterval(load, REFRESH_MS);

// PWA service worker 등록
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
