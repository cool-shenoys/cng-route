// Network-first cache so the app and station list still open with a weak signal on the highway.
const C = "cng-route-v202609261320";
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(["./", "index.html", "app.js", "stations.json", "icon.svg", "manifest.json"]))); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const mine = u.origin === location.origin, lib = /cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com|tile\.openstreetmap\.org|bhuvan-vec1\.nrsc\.gov\.in/.test(u.host);
  if (!mine && !lib) return; // routing & search always go to the network
  e.respondWith(fetch(e.request).then(r => { if (r.ok || r.type === "opaque") { const cp = r.clone(); caches.open(C).then(c => c.put(e.request, cp)); } return r; })
    .catch(() => caches.match(e.request)));
});
