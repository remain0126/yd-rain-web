// netlify/functions/watchdog.js
// 감시(watch)가 살아 있는지 5분마다 확인하고, 멈춰 있으면 대신 한 번 돌린다.
//
// [왜 필요한가]
// 알림 경로는 전적으로 외부 스케줄러(cron-job.org)의 1분 호출에 의존한다.
// 그쪽이 죽거나 토큰이 틀어지면 시스템이 조용히 멈춘다. 화면은 멀쩡해 보이고
// 알림만 안 간다. 다음 날 로그를 열어보기 전에는 아무도 모른다.
//
// 이 함수는 Netlify 자체 스케줄러로 돈다. 외부 서비스와 독립적이므로
// 한쪽이 죽어도 다른 쪽이 받는다. 1분 정밀도는 못 내지만
// "아무도 안 돌고 있는" 상태는 최대 5분 안에 끝난다.
//
// 결과는 health 키에 남고 /api/diag로 볼 수 있다.

exports.config = { schedule: "*/5 * * * *" };

const STORE_NAME = "rainfall-history";
const WATCH_KEY = "watch-state";
const HEALTH_KEY = "health";

// 감시가 이만큼 안 돌았으면 멈춘 것으로 본다.
// 정상이면 1분마다 갱신되므로 3분 반은 넉넉한 여유다.
const WATCH_STALE_MS = 3.5 * 60 * 1000;

function stores(event) {
  try {
    const blobs = require("@netlify/blobs");
    if (event && typeof blobs.connectLambda === "function") blobs.connectLambda(event);
    return { hist: blobs.getStore(STORE_NAME), rain: blobs.getStore("rainfall") };
  } catch (_) {
    return { hist: null, rain: null };
  }
}

async function readJSON(store, key) {
  if (!store) return null;
  try {
    return await store.get(key, { type: "json" });
  } catch (_) {
    return null;
  }
}

exports.handler = async function (event) {
  const started = Date.now();
  const { hist, rain } = stores(event);

  const state = await readJSON(hist, WATCH_KEY);
  const snap = await readJSON(rain, "latest");

  const savedAt = state && state.saved_at ? new Date(state.saved_at).getTime() : 0;
  const watchAge = savedAt ? started - savedAt : Infinity;

  const storedAt = snap && snap.stored_at ? new Date(snap.stored_at).getTime() : 0;
  const snapAge = storedAt ? started - storedAt : Infinity;

  const health = {
    at: new Date().toISOString(),
    watch_age_sec: Number.isFinite(watchAge) ? Math.round(watchAge / 1000) : null,
    snap_age_sec: Number.isFinite(snapAge) ? Math.round(snapAge / 1000) : null,
    // 군청 표가 시계보다 몇 시간 뒤처졌나 (우리가 언제 긁었나와 다른 값)
    table_lag_h: snap && snap.table_lag_h != null ? snap.table_lag_h : null,
    date_mismatch: !!(snap && snap.date_mismatch),
    level: (state && state.level) || null,
    revived: false,
  };

  // 감시가 멈춰 있으면 대신 한 번 돌린다.
  if (!Number.isFinite(watchAge) || watchAge > WATCH_STALE_MS) {
    const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/$/, "");
    const token = process.env.WATCH_TOKEN;
    if (!base) {
      health.revive_error = "사이트 주소 없음";
    } else {
      const url =
        `${base}/.netlify/functions/watch` + (token ? `?token=${encodeURIComponent(token)}` : "");
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
        health.revived = resp.ok;
        health.revive_status = resp.status;
      } catch (e) {
        health.revive_error = String(e && e.message ? e.message : e);
      }
    }
  }

  if (hist) {
    try {
      await hist.setJSON(HEALTH_KEY, health);
    } catch (_) {}
  }

  console.log(JSON.stringify({ ok: true, function: "watchdog", ...health }));

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ ok: true, ...health }, null, 2),
  };
};
