// Garde l'appli sur l'appareil pour qu'elle s'ouvre sans réseau.
// Change VERSION à chaque mise à jour de l'appli pour que les appareils récupèrent la nouvelle.
const VERSION = "carnet-v3";
const SHELL = [
  "./", "index.html", "confidentialite.html", "config.js", "store.js", "manifest.webmanifest",
  "fonts/figtree-latin.woff2", "fonts/figtree-latin-ext.woff2",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

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
  // Seuls les fichiers de l'appli passent par le cache ; les données (Supabase) vont toujours au réseau.
  if (url.origin !== location.origin) return;
  // Le réseau d'abord (pour avoir la dernière version), le cache si pas de réseau.
  e.respondWith(
    fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
  );
});
