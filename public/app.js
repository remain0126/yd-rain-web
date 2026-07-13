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

const NORMAL = { key: "normal", label: "정상", color: "#34d399", actions: ["평시 모니터링"] };
const TIERS = [
  { key: "critical", label: "호우특보(경보)", trigger: "호우경보", c3: 90, c12: 180, color: "#f43f5e",
    actions: ["주민 즉각 대피 발령", "전 대원 현장 출동", "위험구역 접근 통제"] },
  { key: "high", label: "호우특보(주의보)", trigger: "호우주의보", c3: 60, c12: 110, color: "#fb923c",
    actions: ["순찰반 현장 출동", "주민 대피 준비 통보", "유관기관 상황 공유"] },
  { key: "low", label: "호우특보(예비)", trigger: "특보 전 단계", c3: 30, c12: 60, color: "#fbbf24",
    actions: ["위험구역 순찰 개시", "모니터링 강화", "기상청 예보 실시간 확인"] },
];
const RANK = { critical: 0, high: 1, low: 2, normal: 3 };

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

// ---------- Center status ----------

function renderCenters(rows) {
  const el = $("centerStatus");
  const cards = CENTERS.map((c) => {
    let worst = NORMAL;
    let m3 = null, m12 = null;
    const elevated = [];
    c.towns.forEach((t) => {
      const r = rows[t];
      if (!r) return;
      const key = r.risk_key || "normal";
      const tier = key === "normal" ? NORMAL : TIERS.find((x) => x.key === key) || NORMAL;
      if (RANK[tier.key] < RANK[worst.key]) worst = tier;
      if (r.recent_3h_mm != null) m3 = m3 === null ? r.recent_3h_mm : Math.max(m3, r.recent_3h_mm);
      if (r.recent_12h_mm != null) m12 = m12 === null ? r.recent_12h_mm : Math.max(m12, r.recent_12h_mm);
      if (key !== "normal") elevated.push(dn(t));
    });
    return { c, worst, m3, m12, elevated };
  });

  el.innerHTML = cards
    .map(({ c, worst, m3, m12, elevated }) => {
      const isNormal = worst.key === "normal";
      const townsLine = elevated.length
        ? `<div class="cc-towns">특보 대상 <b>${elevated.join(" · ")}</b></div>`
        : `<div class="cc-towns">관할 ${c.towns.map(dn).join(" · ")}</div>`;
      const actionsLine = isNormal
        ? ""
        : `<div class="cc-actions">▸ ${worst.actions.join(" · ")}</div>`;
      return `
        <div class="center-card ${isNormal ? "" : "elevated"}" style="--tier-color:${worst.color};">
          <div class="cc-top">
            <span class="cc-name">${c.name}<small>119안전센터</small></span>
            <span class="cc-badge ${isNormal ? "normal" : ""}">${worst.label}</span>
          </div>
          <div class="cc-metrics">
            <div class="cc-metric"><span class="k">3시간 최대</span><span class="v">${fmtMm(m3)}</span></div>
            <div class="cc-metric"><span class="k">12시간 최대</span><span class="v">${fmtMm(m12)}</span></div>
          </div>
          ${townsLine}
          ${actionsLine}
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
      riskLabel: r.risk_label || "정상",
      riskColor: r.risk_color || NORMAL.color,
    };
  });
  items.sort((a, b) => (b.value || 0) - (a.value || 0));
  const max = Math.max(1, ...items.map((i) => i.value || 0));

  el.innerHTML = items
    .map((it, idx) => {
      const pct = Math.max(3, ((it.value || 0) / max) * 100);
      const hasRain = (it.value || 0) > 0;
      const rankColor =
        hasRain && idx === 0 ? "#fbbf24" : hasRain && idx === 1 ? "#cbd5e1" : hasRain && idx === 2 ? "#d97706" : "var(--muted)";
      const badge =
        it.riskKey !== "normal"
          ? `<span class="rk-badge" style="background:${it.riskColor}22;color:${it.riskColor};">${it.riskLabel.replace("호우특보", "").replace(/[()]/g, "")}</span>`
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
  el.innerHTML = TIERS.map(
    (t) => `
    <div class="tier-c" style="--tier-color:${t.color};">
      <div class="tier-c-top">
        <span class="tier-c-badge">${t.label}</span>
        <span class="tier-c-trigger">${t.trigger}</span>
      </div>
      <div class="tier-c-crit">3시간 ${t.c3}mm · 12시간 ${t.c12}mm 이상</div>
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
  renderCenters(rows);
  renderRanking(rows);
  renderDetail(rows, columns);

  $("dateLabel").textContent = data.date_label
    ? data.date_label.replace("당일", "").replace("시간별 강우량", "").trim() + " 기준"
    : "영덕군 재난안전대책본부 관측망";

  const t = new Date(data.fetched_at || data.stored_at || Date.now());
  const dataTime = t.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  const nowTime = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });

  if (opts && opts.cachedView) {
    $("updatedAt").textContent = "자료기준 " + dataTime + " · 최신 확인 중…";
    $("connDot").className = "dot dot-unknown";
  } else {
    const anyRain = Object.values(rows).some(
      (r) => (r["오늘누계"] || 0) > 0 || (r["전날누적"] || 0) > 0
    );
    const noRainNote = anyRain ? "" : " · 현재 무강우";
    $("updatedAt").textContent = "자료기준 " + dataTime + " · 확인 " + nowTime + noRainNote;
    $("connDot").className = "dot dot-ok";
  }
}

async function load(force) {
  const icon = $("refreshIcon");
  icon.classList.add("spin");
  try {
    const url = force ? "/api/rainfall?fresh=1" : "/api/rainfall";
    const res = await fetch(url, force ? { cache: "no-store" } : {});
    if (!res.ok) throw new Error("서버 응답 " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    paint(data, { cachedView: false });
    saveLocal(data);
  } catch (e) {
    // 네트워크 실패 시, 브라우저에 저장된 마지막 데이터라도 유지
    const local = loadLocal();
    if (local) {
      paint(local, { cachedView: true });
      $("updatedAt").textContent = "연결 실패 · 저장된 이전 자료 표시";
    } else {
      $("updatedAt").textContent = "데이터를 불러오지 못했습니다";
    }
    $("connDot").className = "dot dot-error";
    console.error(e);
  } finally {
    icon.classList.remove("spin");
  }
}

// 새로고침 버튼 = 강제 최신(fresh), 자동/최초 = 캐시 허용
$("refreshBtn").addEventListener("click", () => load(true));
renderTierCards();

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
