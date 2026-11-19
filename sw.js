/* Quriliş Go service worker: works offline with the last opened catalog, caches photos, shows push notifications. */
const VERSION = "20261119122308";
const SHELL = `imorat-shell-${VERSION}`, IMG = "imorat-img-v1";
const SHELL_FILES = ["./", "index.html", "config.js", "app.js?v=5bbf02c9dd", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"]; // the page script carries its version in the address; the language files (en.js, uz.js) are cached when they are first used

/* Nothing here may end as an unanswered error: a failed write to the cache is not a failed page (and every such error lands in
   the browser's console as "Uncaught (in promise)"). A response is copied for the cache at once, while its body is untouched —
   copying it later, after the page has started reading it, throws "Response body is already used". */
const quiet = p => p.catch(() => {});
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => Promise.all(SHELL_FILES.map(u => quiet(c.add(u))))).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("imorat-shell-") && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin !== location.origin) return; // API, fonts and maps go straight to the network
  if (url.pathname.includes("/img/") || url.pathname.includes("/icons/") || url.pathname.includes("/vendor/") || url.pathname.includes("/fonts/")) { // vendor/: versioned libraries (the 3D viewer), fonts/: font files named by their content — neither changes under the same path
    e.respondWith(caches.open(IMG).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.status === 200) quiet(c.put(req, r.clone())); return r; })));
    return;
  }
  if (/\/(app|en|uz)\.js$/.test(url.pathname)) { // versioned by ?v=: what is cached under this address never changes
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.status === 200) { const copy = r.clone(); quiet(caches.open(SHELL).then(c => c.put(req, copy))); } return r; })));
    return;
  }
  if (req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html") || url.pathname.endsWith("config.js")) {
    e.respondWith(fetch(req).then(r => { if (r.status === 200) { const copy = r.clone(); quiet(caches.open(SHELL).then(c => c.put(req, copy))); } return r; }).catch(async () => (await caches.match(req)) || caches.match("index.html")));
  }
});
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (er) { d = { title: "Quriliş Go", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Quriliş Go", { body: d.body || "", icon: "icons/icon-192.png", badge: "icons/icon-192.png", tag: d.tag, renotify: !!d.tag, vibrate: [120, 60, 120], data: { url: d.url || "./" } }));
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
