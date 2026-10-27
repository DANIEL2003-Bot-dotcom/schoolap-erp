/* Service worker de l'Espace Enseignant : l'application s'ouvre même sans réseau.
   - Page : réseau d'abord (toujours la dernière version), copie locale si hors ligne
   - Fichiers de l'application (noms versionnés) : copie locale d'abord
   - Appels à l'API : jamais mis en cache (la file d'attente est gérée par l'application) */
const CACHE = 'schoolap-enseignant-v1';
const SHELL = ['./', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];

/** Met en cache la page et tous les fichiers qu'elle référence ; retire les anciennes versions. */
async function cacheShell(html) {
  const cache = await caches.open(CACHE);
  const base = new URL('./', self.registration.scope);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => new URL(m[1], base).href);
  await Promise.all(
    assets.map(async (url) => {
      if (!(await cache.match(url))) {
        const res = await fetch(url);
        if (res.ok) await cache.put(url, res);
      }
    }),
  );
  const keep = new Set([...assets, ...SHELL.map((p) => new URL(p, base).href)]);
  for (const req of await cache.keys()) {
    if (/\.(js|css)$/.test(new URL(req.url).pathname) && !keep.has(req.url)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      const page = await cache.match('./');
      if (page) await cacheShell(await page.clone().text());
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('schoolap-enseignant-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          if (res.ok) {
            const cache = await caches.open(CACHE);
            await cache.put('./', res.clone());
            res
              .clone()
              .text()
              .then(cacheShell)
              .catch(() => undefined);
          }
          return res;
        } catch {
          return (await caches.match('./')) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && /\.(js|css|png|webmanifest|svg|woff2?)$/.test(url.pathname)) {
        const cache = await caches.open(CACHE);
        await cache.put(req, res.clone());
      }
      return res;
    })(),
  );
});
