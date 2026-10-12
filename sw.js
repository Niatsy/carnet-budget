// Garde l'appli sur l'appareil pour qu'elle s'ouvre sans réseau.
// Change VERSION à chaque mise à jour de l'appli pour que les appareils récupèrent la nouvelle.
const VERSION = "carnet-v1";
const SHELL = ["./", "index.html", "config.js", "store.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Les données (Supabase) passent toujours par le réseau : le magasin local gère l'absence de connexion.
  if (url.hostname.endsWith("supabase.co")) return;
  // Polices Google : servies depuis le cache, rafraîchies en arrière-plan.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // L'appli : le réseau d'abord (pour avoir la dernière version), le cache si pas de réseau.
  e.respondWith(
    fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("index.html")))
  );
});
