// Service Worker - menyimpan "app shell" (HTML/CSS/JS) agar aplikasi
// tetap bisa DIBUKA walau tidak ada internet. Data email disimpan
// terpisah di IndexedDB (lihat app.js), bukan di sini.

const CACHE_NAME = 'zimbra-mail-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Hanya cache-first untuk file app shell milik kita sendiri.
  // Panggilan ke backend Google Apps Script SELALU lewat network
  // (data email tidak boleh basi dan butuh koneksi real-time saat kirim).
  const url = new URL(event.request.url);
  const isOwnFile = url.origin === self.location.origin;

  if (!isOwnFile) return; // biarkan request ke GAS lewat normal (tidak diintersep)

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return resp;
      }).catch(() => cached);
    })
  );
});
