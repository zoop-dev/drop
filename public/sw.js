const CACHE = 'drop-2026062711';
const PRECACHE = ['/', '/style.css', '/app.js', '/manifest.json', '/favicon.svg'];

let sharedFiles = null;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', e => {
  if (e.data === 'claim-share') {
    const files = sharedFiles || [];
    sharedFiles = null;
    e.source.postMessage({ type: 'shared-files', files });
  }
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      const formData = await e.request.formData();
      sharedFiles = formData.getAll('files').filter(f => f instanceof File);
      return Response.redirect('/?incoming=share', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (res.ok) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});
