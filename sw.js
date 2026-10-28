/* Imorat service worker: works offline with the last opened catalog, caches photos, shows push notifications. */
const VERSION = "20261027194442";
const SHELL = `imorat-shell-${VERSION}`, IMG = "imorat-img-v1";
const SHELL_FILES = ["./", "index.html", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("imorat-shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin !== location.origin) return; // API, fonts and maps go straight to the network
  if (url.pathname.includes("/img/") || url.pathname.includes("/icons/")) {
    e.respondWith(caches.open(IMG).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html") || url.pathname.endsWith("config.js")) {
    e.respondWith(fetch(req).then(r => { if (r.ok) caches.open(SHELL).then(c => c.put(req, r.clone())); return r; }).catch(async () => (await caches.match(req)) || caches.match("index.html")));
  }
});
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (er) { d = { title: "Imorat", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Imorat", { body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: d.tag, renotify: !!d.tag, vibrate: [120, 60, 120], data: { url: d.url || "./" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.startsWith(self.registration.scope));
    if (w) { w.navigate(target).catch(() => {}); return w.focus(); }
    return self.clients.openWindow(target);
  }));
});
