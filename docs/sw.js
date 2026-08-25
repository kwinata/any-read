'use strict';

const VERSION = 'anyread-v3'; // v3: content-hashed audio filenames
const SHELL = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// iOS <audio> issues Range requests; a cached full response must be sliced into a 206.
async function audioResponse(request) {
  const cache = await caches.open(VERSION);
  let full = await cache.match(request.url);
  if (!full) {
    full = await fetch(request.url);
    if (full.ok) await cache.put(request.url, full.clone());
  }
  const range = request.headers.get('range');
  if (!range) return full;
  const buf = await full.arrayBuffer();
  const m = /bytes=(\d+)-(\d+)?/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    // GitHub Pages sends max-age=600; revalidate so updates show up immediately.
    const resp = await fetch(request, { cache: 'no-cache' });
    if (resp.ok) await cache.put(request, resp.clone());
    return resp;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp.ok) await cache.put(request, resp.clone());
  return resp;
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const path = url.pathname;
  if (path.endsWith('.mp3')) {
    e.respondWith(audioResponse(e.request));
  } else if (path.endsWith('/articles/index.json')) {
    e.respondWith(networkFirst(e.request));
  } else if (path.includes('/articles/')) {
    e.respondWith(cacheFirst(e.request));
  } else {
    e.respondWith(networkFirst(e.request));
  }
});
