const CACHE = 'drop-2026062730';
const PRECACHE = ['/', '/style.css', '/qrlib.js', '/app.js', '/manifest.json', '/favicon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== 'drop-share').map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', async e => {
  if (e.data === 'claim-share') {
    const cache = await caches.open('drop-share');
    const meta = await cache.match('/__share_meta');
    if (!meta) { e.source.postMessage({ type: 'shared-files', files: [] }); return; }
    const { count, names, types } = await meta.json();
    const files = [];
    for (let i = 0; i < count; i++) {
      const res = await cache.match(`/__share_${i}`);
      if (res) files.push(new File([await res.arrayBuffer()], names[i], { type: types[i] }));
    }
    await cache.delete('/__share_meta');
    for (let i = 0; i < count; i++) await cache.delete(`/__share_${i}`);
    e.source.postMessage({ type: 'shared-files', files });
  }
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();
        const files = formData.getAll('files').filter(f => f instanceof File);
        const cache = await caches.open('drop-share');
        await cache.put('/__share_meta', new Response(
          JSON.stringify({ count: files.length, names: files.map(f => f.name), types: files.map(f => f.type || 'application/octet-stream') })
        ));
        for (let i = 0; i < files.length; i++) {
          await cache.put(`/__share_${i}`, new Response(await files[i].arrayBuffer(), {
            headers: { 'Content-Type': files[i].type || 'application/octet-stream' }
          }));
        }
      } catch {}
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
