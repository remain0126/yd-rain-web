// service worker: 앱 셸(정적 파일)만 캐시. 강우 데이터(/api/rainfall)는
// 항상 네트워크에서 최신으로 받아온다 (재난 대응 특성상 실시간이 중요).
const CACHE = "yd-rain-v11";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // 데이터 요청: 항상 네트워크 (캐시 안 함)
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(
      fetch(e.request).catch(
        () => new Response(JSON.stringify({ error: "오프라인" }), { headers: { "Content-Type": "application/json" } })
      )
    );
    return;
  }

  // 앱 셸(html/js/css): 네트워크 우선 -> 코드 업데이트가 즉시 반영됨.
  // 네트워크 실패(오프라인) 시에만 캐시로 폴백.
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
