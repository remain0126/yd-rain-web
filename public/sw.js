// service worker: 앱 셸(정적 파일)만 캐시. 강우 데이터(/api/rainfall)는
// 항상 네트워크에서 최신으로 받아온다 (재난 대응 특성상 실시간이 중요).
const CACHE = "yd-rain-v31";
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

// ---------- 웹 푸시 ----------
// 서버가 보낸 알림을 받아 화면에 띄운다.
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch (_) {
    d = { title: "영덕군 강우상황", body: e.data ? e.data.text() : "" };
  }

  const title = d.title || "영덕군 강우상황";
  // 같은 tag를 재사용하면 안드로이드가 "기존 알림 수정"으로 처리해 두 번째부터
  // 소리·진동이 나지 않는다. 그래서 매번 다른 tag로 새 알림을 띄우고,
  // 같은 묶음(group)의 이전 알림은 아래에서 직접 닫아 화면에 하나만 남긴다.
  const group = d.group || "yd-rain";
  const options = {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: d.tag || group + "-" + Date.now(),
    renotify: true,
    requireInteraction: !!d.sticky,
    // 진동 세기는 웹에서 정할 수 없고 길이·횟수만 지정할 수 있다.
    // 체감을 최대로 하기 위해 긴 진동을 여러 번 반복한다.
    //   경보급 이상: 약 6.5초 · 그 외: 약 3.5초
    vibrate: d.sticky
      ? [700, 150, 700, 150, 700, 150, 700, 150, 700, 150, 700, 150, 700]
      : [500, 200, 500, 200, 500, 200, 500],
    actions: d.key ? [{ action: "ack", title: "확인" }] : [],
    data: { url: d.url || "/", key: d.key || null, rank: d.rank, eid: d.eid || null, group },
  };

  e.waitUntil(
    self.registration
      .getNotifications()
      .then((list) => {
        for (const n of list) {
          if (n.data && n.data.group === group) n.close();
        }
      })
      .catch(() => {})
      .then(() => self.registration.showNotification(title, options))
  );
});

// 알림을 누르면 앱을 열거나, 이미 열려 있으면 그 창으로 이동한다.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const target = data.url || "/";

  // 확인 처리. 버튼을 누르든 본문을 누르든 "봤다"로 간주한다.
  // 버튼만 인정하면 알림을 확인하고도 계속 울리는 일이 생긴다.
  const sendAck = () =>
    self.registration.pushManager
      .getSubscription()
      .then((sub) => {
        if (!sub) return;
        return fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ack",
            endpoint: sub.endpoint,
            key: data.key,
            rank: data.rank,
            // 어느 알림에 대한 확인인지 알려준다
            eid: data.eid,
          }),
        });
      })
      .catch(() => {});

  // 알림을 밀어서 지운 경우도 확인으로 친다.
// 내용을 보고 넘긴 것이므로 읽은 것으로 본다.
self.addEventListener("notificationclose", (e) => {
  const data = (e.notification && e.notification.data) || {};
  e.waitUntil(
    self.registration.pushManager
      .getSubscription()
      .then((sub) => {
        if (!sub) return;
        return fetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "ack",
            endpoint: sub.endpoint,
            key: data.key,
            rank: data.rank,
            eid: data.eid,
          }),
        });
      })
      .catch(() => {})
  );
});

// 확인 버튼: 앱은 열지 않는다
  if (e.action === "ack") {
    e.waitUntil(sendAck());
    return;
  }

  // 본문을 누른 경우: 확인 처리하고 앱도 연다
  e.waitUntil(
    sendAck().then(() =>
      clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
        for (const c of list) {
          if ("focus" in c) {
            if ("navigate" in c) c.navigate(target);
            return c.focus();
          }
        }
        return clients.openWindow(target);
      })
    )
  );
});
