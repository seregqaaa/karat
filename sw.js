// Офлайн-кэш «ЛУЧ-МК: показания в 1 клик».
// При изменении любого файла из ASSETS поднять версию CACHE — иначе
// установленные PWA продолжат работать со старой копией. Тем же коммитом
// поднимается K20_VER в k20.core.js: по нему опознаётся сборка в диагностике.
const CACHE = "k20-viewer-v25";
const ASSETS = ["./", "index.html", "k20.core.js", "xlsx.write.js", "manifest.json",
                "favicon.svg", "favicon.ico",
                "icon-180.png", "icon-192.png", "icon-512.png", "icon-512-maskable.png"];

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

// Кэшируем только удачные ответы: 404 с GitHub Pages в момент перевыкладки
// иначе осел бы в кэше и потом отдавался как «офлайн-версия приложения».
const putIfOk = (req, res) => {
  if (!res.ok) return;
  const copy = res.clone();
  caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
};

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  // страницы — сначала сеть (чтобы обновления доезжали), при офлайне — кэш
  if (req.mode === "navigate"){
    e.respondWith(fetch(req)
      .then(r => { putIfOk(req, r); return r; })
      .catch(() => caches.match(req)
        .then(r => r || caches.match("index.html"))
        .then(r => r || Response.error())));
    return;
  }
  // остальное — из кэша сразу, с фоновым обновлением копии
  e.respondWith(caches.match(req).then(hit => {
    if (hit) {
      // фоновое обновление: ошибки сети здесь никого не касаются
      fetch(req).then(r => putIfOk(req, r)).catch(() => {});
      return hit;
    }
    // промах кэша: сеть — единственный источник, и respondWith обязан получить
    // Response даже при отказе, иначе браузер бросит TypeError
    return fetch(req).then(r => { putIfOk(req, r); return r; }).catch(() => Response.error());
  }));
});
