// Офлайн-кэш «ЛУЧ-МК: показания в 1 клик».
// При изменении любого файла из ASSETS поднять версию CACHE — иначе
// установленные PWA продолжат работать со старой копией.
const CACHE = "k20-viewer-v17";
const ASSETS = ["./", "index.html", "xlsx.write.js", "manifest.json",
                "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  // страницы — сначала сеть (чтобы обновления доезжали), при офлайне — кэш
  if (req.mode === "navigate"){
    e.respondWith(fetch(req)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return r;
      })
      .catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
    return;
  }
  // остальное — из кэша сразу, с фоновым обновлением копии
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => {
      if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone()));
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
