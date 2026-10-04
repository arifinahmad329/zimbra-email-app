// Service Worker - menyimpan "app shell" (HTML/CSS/JS) agar aplikasi
// tetap bisa DIBUKA walau tidak ada internet. Data email disimpan
// terpisah di IndexedDB (lihat app.js), bukan di sini.
//
// PENTING: naikkan angka versi di bawah (v4 -> v5, dst.) setiap kali
// kamu mengubah file aplikasi, supaya cache lama dibuang.

const CACHE_NAME = 'zimbra-mail-shell-v4';
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
    caches.open(CACHE_NAME).then((cache) =>
      // satu file gagal tidak menggagalkan seluruh instalasi
      Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})))
    )
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
  const req = event.request;
  const url = new URL(req.url);

  // Hanya file milik aplikasi sendiri. Panggilan ke backend Google Apps Script
  // (origin lain) tidak diintersep sama sekali.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Stale-while-revalidate: tampilkan dari cache dulu (cepat & bisa offline),
  // sambil mengambil versi terbaru untuk pembukaan berikutnya.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone(); // clone SEBELUM resp dipakai
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => {
          if (cached) return cached;
          // buka aplikasi saat offline dan alamat tidak ada di cache
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        });
      return cached || network;
    })
  );
});
