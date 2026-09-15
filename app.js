// ============================================================
// KONFIGURASI
// ============================================================
// GANTI dengan URL Web App Google Apps Script kamu setelah deploy Code.gs
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzz-xF0hZk-O2s9oMRxq72ZhJeROjB32K17T176nVvHj9aDHh6oGdW7VGm80W87c1EM/exec';

// ============================================================
// STATE
// ============================================================
let session = null; // { server, user, authToken }
let currentFolder = null;
let currentOffset = 0;
let db = null;

// ============================================================
// INDEXEDDB - penyimpanan lokal untuk mode offline
// ============================================================
let dbReadyPromise = null;
async function ensureDb() {
  if (db) return db;
  if (!dbReadyPromise) dbReadyPromise = openDb();
  db = await dbReadyPromise;
  return db;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('zimbra-mail-db', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('messages')) {
        const s = d.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('folderId', 'folderId');
      }
      if (!d.objectStoreNames.contains('messageDetail')) d.createObjectStore('messageDetail', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'localId' });
      if (!d.objectStoreNames.contains('session')) d.createObjectStore('session', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(storeName, value) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbGet(storeName, key) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbGetAll(storeName) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbGetByIndex(storeName, indexName, value) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbDelete(storeName, key) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function idbClearAll() {
  return ensureDb().then((d) => new Promise((resolve) => {
    const names = ['folders', 'messages', 'messageDetail', 'outbox', 'session'];
    const tx = d.transaction(names, 'readwrite');
    names.forEach((n) => tx.objectStore(n).clear());
    tx.oncomplete = () => resolve();
  }));
}

// ============================================================
// PANGGIL BACKEND (Google Apps Script)
// ============================================================
async function callBackend(action, params) {
  if (!navigator.onLine) {
    throw new Error('OFFLINE');
  }
  const resp = await fetch(BACKEND_URL, {
    method: 'POST',
    // pakai text/plain supaya browser tidak melakukan CORS preflight ke Apps Script
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, params })
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'Terjadi kesalahan');
  return data;
}

// ============================================================
// UI HELPERS
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function updateOnlineStatus() {
  document.body.classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', () => { updateOnlineStatus(); flushOutbox(); });
window.addEventListener('offline', updateOnlineStatus);

function fmtDate(ms) {
  const d = new Date(parseInt(ms, 10));
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
}

// ============================================================
// LOGIN / SESSION
// ============================================================
document.getElementById('btn-login').addEventListener('click', doLogin);

async function doLogin() {
  const server = document.getElementById('in-server').value.trim();
  const user = document.getElementById('in-user').value.trim();
  const pass = document.getElementById('in-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';

  if (!server || !user || !pass) {
    errEl.textContent = 'Semua kolom wajib diisi.';
    errEl.style.display = 'block';
    return;
  }
  if (BACKEND_URL.indexOf('PASTE_URL') !== -1) {
    errEl.textContent = 'BACKEND_URL di app.js belum diisi dengan URL Web App Google Apps Script.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Memproses...';

  try {
    const data = await callBackend('login', { server, user, pass });
    session = { server, user, authToken: data.authToken };
    await idbPut('session', { k: 'current', ...session });
    document.getElementById('drawer-user').textContent = user;
    document.getElementById('drawer-server').textContent = server;
    await loadFolders();
    showScreen('screen-inbox');
    autoSyncAllFolders(); // jalan di belakang layar, tidak perlu ditunggu
  } catch (e) {
    errEl.textContent = e.message === 'OFFLINE'
      ? 'Tidak ada koneksi internet. Login pertama kali membutuhkan koneksi.'
      : 'Gagal masuk: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Masuk';
  }
}

async function tryRestoreSession() {
  const saved = await idbGet('session', 'current');
  if (saved && saved.authToken) {
    session = saved;
    document.getElementById('drawer-user').textContent = saved.user;
    document.getElementById('drawer-server').textContent = saved.server;
    await loadFolders();
    showScreen('screen-inbox');
    autoSyncAllFolders(); // jalan di belakang layar, tidak perlu ditunggu
    return true;
  }
  return false;
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('Keluar dan hapus semua data email yang tersimpan di HP ini?')) return;
  await idbClearAll();
  session = null;
  closeDrawer();
  showScreen('screen-login');
});

// ============================================================
// FOLDERS
// ============================================================
async function loadFolders() {
  // Tampilkan dulu dari cache lokal (instan, tidak perlu tunggu jaringan)
  var cached = await idbGetAll('folders');
  if (cached.length) {
    renderFolderList(cached);
    if (!currentFolder) {
      const inbox = cached.find((f) => f.name.toLowerCase() === 'inbox') || cached[0];
      openFolder(inbox);
    }
  }

  try {
    if (navigator.onLine) {
      const data = await callBackend('getFolders', { server: session.server, authToken: session.authToken });
      for (const f of data.folders) await idbPut('folders', f);
      const fresh = await idbGetAll('folders');
      renderFolderList(fresh);
      if (!currentFolder && fresh.length) {
        const inbox = fresh.find((f) => f.name.toLowerCase() === 'inbox') || fresh[0];
        openFolder(inbox);
      }
    }
  } catch (e) {
    toast('Gagal ambil folder: ' + e.message);
  }
}

function renderFolderList(folders) {
  const el = document.getElementById('folder-list');
  el.innerHTML = '';
  folders.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'folder-item' + (currentFolder && currentFolder.id === f.id ? ' active' : '');
    div.innerHTML = `<span>${escapeHtml(f.name)}</span>` +
      (f.unread > 0 ? `<span class="badge">${f.unread}</span>` : '');
    div.addEventListener('click', () => { openFolder(f); closeDrawer(); });
    el.appendChild(div);
  });
}

function openFolder(f) {
  currentFolder = f;
  currentOffset = 0;
  document.getElementById('folder-title').textContent = f.name;
  loadMessages(true);
}

// ============================================================
// DAFTAR PESAN
// ============================================================
async function loadMessages(reset) {
  const listEl = document.getElementById('msg-list');
  if (reset) currentOffset = 0;

  // 1) Tampilkan dulu dari cache lokal supaya instan
  let cachedMsgs = await idbGetByIndex('messages', 'folderId', currentFolder.id);
  cachedMsgs.sort((a, b) => parseInt(b.date, 10) - parseInt(a.date, 10));
  if (reset) {
    listEl.innerHTML = '';
    if (cachedMsgs.length) {
      cachedMsgs.forEach((m) => listEl.appendChild(renderMsgItem(m)));
    } else {
      listEl.innerHTML = '<div class="spinner"></div>';
    }
  }

  // 2) Ambil versi terbaru dari server di belakang layar
  let messages = [];
  let fromNetwork = false;
  try {
    if (navigator.onLine) {
      const data = await callBackend('listMessages', {
        server: session.server, authToken: session.authToken,
        folderId: currentFolder.id, folderName: currentFolder.name, offset: currentOffset
      });
      messages = data.messages.map((m) => ({ ...m, folderId: currentFolder.id }));
      for (const m of messages) await idbPut('messages', m);
      fromNetwork = true;
    }
  } catch (e) { toast('Gagal ambil pesan: ' + e.message); }

  if (fromNetwork) {
    if (reset) listEl.innerHTML = '';
    if (messages.length === 0 && reset) {
      listEl.innerHTML = `<div class="empty-state"><div class="big">Tidak ada pesan</div>Folder ini kosong.</div>`;
      return;
    }
    messages.forEach((m) => listEl.appendChild(renderMsgItem(m)));
    if (messages.length >= 30) {
      const more = document.createElement('div');
      more.className = 'load-more';
      more.textContent = 'Muat lebih banyak';
      more.addEventListener('click', () => { currentOffset += 30; more.remove(); loadMessages(false); });
      listEl.appendChild(more);
    }
  } else if (reset && cachedMsgs.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="big">Tidak ada pesan</div>Folder ini kosong (mode offline).</div>`;
  }
}

function renderMsgItem(m) {
  const div = document.createElement('div');
  div.className = 'msg-item' + (m.unread ? '' : ' read');
  div.innerHTML = `
    <div class="dot"></div>
    <div class="body">
      <div class="row1">
        <span class="from">${escapeHtml(m.from ? m.from.name : '')}</span>
        <span class="date">${fmtDate(m.date)}</span>
      </div>
      <div class="subj">${escapeHtml(m.subject || '(tanpa subjek)')}</div>
      <div class="snippet">${escapeHtml(m.snippet || '')}</div>
      ${m.hasAttachment ? '<div class="clip">📎 Ada lampiran</div>' : ''}
    </div>`;
  div.addEventListener('click', () => openMessage(m.id));
  return div;
}

document.getElementById('btn-refresh').addEventListener('click', () => loadMessages(true));
document.getElementById('btn-sync-all').addEventListener('click', () => {
  closeDrawer();
  syncFolderFull(currentFolder);
});

async function syncFolderFull(folder) {
  if (!navigator.onLine) { toast('Sambungkan internet dulu untuk mengunduh semua pesan'); return; }
  const progEl = document.getElementById('sync-progress');
  progEl.style.display = 'block';
  progEl.textContent = 'Mengambil daftar pesan di "' + folder.name + '"...';

  // 1) Kumpulkan semua ID pesan di folder ini (looping per 30)
  let allHeaders = [];
  let offset = 0;
  while (true) {
    let data;
    try {
      data = await callBackend('listMessages', {
        server: session.server, authToken: session.authToken,
        folderId: folder.id, folderName: folder.name, offset
      });
    } catch (e) {
      progEl.textContent = 'Gagal: ' + e.message;
      setTimeout(() => { progEl.style.display = 'none'; }, 3000);
      return;
    }
    const batch = data.messages.map((m) => ({ ...m, folderId: folder.id }));
    for (const m of batch) await idbPut('messages', m);
    allHeaders = allHeaders.concat(batch);
    if (batch.length < 30) break;
    offset += 30;
    progEl.textContent = 'Mengambil daftar pesan... (' + allHeaders.length + ' ditemukan)';
  }

  // 2) Unduh isi lengkap tiap pesan yang belum tersimpan
  let done = 0;
  let skipped = 0;
  for (const h of allHeaders) {
    const existing = await idbGet('messageDetail', h.id);
    if (existing) { skipped++; done++; continue; }
    try {
      const data = await callBackend('getMessage', { server: session.server, authToken: session.authToken, id: h.id });
      await idbPut('messageDetail', data.message);
    } catch (e) {
      // lewati pesan ini kalau gagal, lanjut ke berikutnya
    }
    done++;
    if (done % 5 === 0 || done === allHeaders.length) {
      progEl.textContent = 'Menyimpan untuk offline: ' + done + ' / ' + allHeaders.length + ' pesan...';
    }
  }

  progEl.textContent = 'Selesai! ' + allHeaders.length + ' pesan di "' + folder.name + '" siap dibaca offline.';
  setTimeout(() => { progEl.style.display = 'none'; }, 4000);
}

// ============================================================
// SINKRONISASI OTOMATIS SEMUA FOLDER (jalan sendiri di belakang layar)
// ============================================================
let autoSyncRunning = false;
async function autoSyncAllFolders() {
  if (autoSyncRunning || !navigator.onLine) return;
  autoSyncRunning = true;
  try {
    const folders = await idbGetAll('folders');
    // dahulukan Inbox supaya yang paling penting selesai duluan
    folders.sort((a, b) => (a.name.toLowerCase() === 'inbox' ? -1 : b.name.toLowerCase() === 'inbox' ? 1 : 0));
    for (const f of folders) {
      if (!navigator.onLine) break; // berhenti kalau koneksi putus di tengah jalan
      await syncFolderFullSilent(f);
    }
  } finally {
    autoSyncRunning = false;
  }
}

// Sama seperti syncFolderFull, tapi tanpa mengganggu (dipakai untuk proses otomatis)
async function syncFolderFullSilent(folder) {
  const progEl = document.getElementById('sync-progress');
  let offset = 0;
  let allHeaders = [];
  while (true) {
    let data;
    try {
      data = await callBackend('listMessages', {
        server: session.server, authToken: session.authToken,
        folderId: folder.id, folderName: folder.name, offset
      });
    } catch (e) { return; } // kalau gagal, lewati folder ini, lanjut folder lain nanti

    const batch = data.messages.map((m) => ({ ...m, folderId: folder.id }));
    for (const m of batch) await idbPut('messages', m);
    allHeaders = allHeaders.concat(batch);
    if (batch.length < 30) break;
    offset += 30;
  }

  let done = 0;
  for (const h of allHeaders) {
    const existing = await idbGet('messageDetail', h.id);
    if (existing) { done++; continue; }
    try {
      const data = await callBackend('getMessage', { server: session.server, authToken: session.authToken, id: h.id });
      await idbPut('messageDetail', data.message);
    } catch (e) { /* lewati, lanjut pesan berikutnya */ }
    done++;
    if (done % 5 === 0 || done === allHeaders.length) {
      progEl.style.display = 'block';
      progEl.textContent = 'Menyinkronkan otomatis: ' + folder.name + ' (' + done + '/' + allHeaders.length + ')';
    }
  }
  progEl.style.display = 'none';
}

// ============================================================
// PENCARIAN (lintas semua folder)
// ============================================================
let searchMode = false;
const btnSearch = document.getElementById('btn-search');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');

btnSearch.addEventListener('click', () => {
  searchMode = !searchMode;
  searchBar.style.display = searchMode ? 'block' : 'none';
  if (searchMode) {
    searchInput.value = '';
    searchInput.focus();
  } else {
    document.getElementById('folder-title').textContent = currentFolder.name;
    loadMessages(true); // balik ke tampilan folder biasa
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch(searchInput.value.trim());
});

async function doSearch(keyword) {
  const listEl = document.getElementById('msg-list');
  if (!keyword) return;
  document.getElementById('folder-title').textContent = 'Hasil: "' + keyword + '"';
  listEl.innerHTML = '<div class="spinner"></div>';

  let results = [];
  if (navigator.onLine) {
    try {
      const data = await callBackend('search', { server: session.server, authToken: session.authToken, keyword });
      results = data.messages;
    } catch (e) {
      toast('Gagal mencari: ' + e.message);
    }
  } else {
    // Offline: cari di semua pesan yang sudah tersimpan di HP
    const all = await idbGetAll('messages');
    const kw = keyword.toLowerCase();
    results = all.filter((m) =>
      (m.subject || '').toLowerCase().includes(kw) ||
      (m.from && (m.from.name || '').toLowerCase().includes(kw)) ||
      (m.from && (m.from.address || '').toLowerCase().includes(kw)) ||
      (m.snippet || '').toLowerCase().includes(kw)
    );
    toast('Mode offline: mencari di pesan yang sudah tersimpan saja');
  }

  listEl.innerHTML = '';
  if (results.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="big">Tidak ditemukan</div>Tidak ada pesan yang cocok dengan "${escapeHtml(keyword)}".</div>`;
    return;
  }
  results.forEach((m) => listEl.appendChild(renderMsgItem(m)));
}

// ============================================================
// DETAIL PESAN
// ============================================================
async function openMessage(id) {
  showScreen('screen-detail');
  const content = document.getElementById('detail-content');
  content.innerHTML = '<div class="spinner"></div>';

  let msg = null;
  try {
    if (navigator.onLine) {
      const data = await callBackend('getMessage', { server: session.server, authToken: session.authToken, id });
      msg = data.message;
      await idbPut('messageDetail', msg);
      callBackend('markRead', { server: session.server, authToken: session.authToken, id, read: true }).catch(() => {});
    }
  } catch (e) { /* fallback ke cache */ }

  if (!msg) {
    msg = await idbGet('messageDetail', id);
  }

  if (!msg) {
    content.innerHTML = '<div class="empty-state">Pesan ini belum tersimpan untuk offline. Sambungkan internet lalu buka lagi.</div>';
    return;
  }

  renderDetail(msg);
}

function renderDetail(msg) {
  const content = document.getElementById('detail-content');
  const attachHtml = (msg.attachments || []).map((a) =>
    `<div class="attach-chip" data-part="${a.part}" data-msgid="${msg.id}" data-filename="${escapeHtml(a.filename)}">📎 ${escapeHtml(a.filename)}</div>`
  ).join('');

  content.innerHTML = `
    <div class="detail-pad">
      <h2>${escapeHtml(msg.subject || '(tanpa subjek)')}</h2>
      <div class="who-row">
        <span class="name">${escapeHtml(msg.from.name)}</span>
        <span class="date">${fmtDate(msg.date)}</span>
      </div>
      <div class="to-line">Kepada: ${escapeHtml((msg.to || []).map(t => t.name).join(', ') || '-')}</div>
      <div class="body-html">${msg.htmlBody || `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(msg.textBody || '(tidak ada isi)')}</pre>`}</div>
      ${msg.attachments && msg.attachments.length ? `<div class="attach-list">${attachHtml}</div>` : ''}
    </div>
    <div class="detail-actions">
      <button id="btn-reply">Balas</button>
      <button class="primary" id="btn-forward">Teruskan</button>
    </div>`;

  content.querySelectorAll('.attach-chip').forEach((chip) => {
    chip.addEventListener('click', () => downloadAttachment(chip.dataset.msgid, chip.dataset.part, chip.dataset.filename));
  });

  document.getElementById('btn-reply').addEventListener('click', () => openCompose({
    to: msg.from.address, subject: 'Re: ' + (msg.subject || '')
  }));
  document.getElementById('btn-forward').addEventListener('click', () => openCompose({
    subject: 'Fwd: ' + (msg.subject || ''), body: '\n\n--- Pesan diteruskan ---\n' + (msg.textBody || '')
  }));
}

async function downloadAttachment(msgId, part, filename) {
  if (!navigator.onLine) { toast('Sambungkan internet untuk mengunduh lampiran'); return; }
  toast('Mengunduh ' + filename + '...');
  try {
    const data = await callBackend('getAttachment', { server: session.server, authToken: session.authToken, msgId, part });
    const link = document.createElement('a');
    link.href = 'data:' + data.contentType + ';base64,' + data.base64;
    link.download = filename;
    link.click();
  } catch (e) {
    toast('Gagal mengunduh: ' + e.message);
  }
}

document.getElementById('btn-back-detail').addEventListener('click', () => showScreen('screen-inbox'));

// ============================================================
// TULIS / KIRIM EMAIL (dengan outbox untuk mode offline)
// ============================================================
document.getElementById('btn-compose').addEventListener('click', () => openCompose());
document.getElementById('btn-close-compose').addEventListener('click', closeCompose);
document.getElementById('btn-send').addEventListener('click', doSend);

function openCompose(prefill) {
  prefill = prefill || {};
  document.getElementById('compose-to').value = prefill.to || '';
  document.getElementById('compose-subject').value = prefill.subject || '';
  document.getElementById('compose-body').value = prefill.body || '';
  document.getElementById('compose-sheet').classList.add('open');
}
function closeCompose() {
  document.getElementById('compose-sheet').classList.remove('open');
}

async function doSend() {
  const to = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value;

  if (!to) { toast('Isi alamat penerima dulu'); return; }

  const payload = { to, subject, body };

  if (!navigator.onLine) {
    await idbPut('outbox', { localId: 'out_' + Date.now(), ...payload });
    toast('Tidak ada internet — email disimpan di Outbox, akan dikirim otomatis saat online.');
    closeCompose();
    return;
  }

  try {
    await callBackend('sendMessage', { server: session.server, authToken: session.authToken, ...payload });
    toast('Email terkirim');
    closeCompose();
  } catch (e) {
    await idbPut('outbox', { localId: 'out_' + Date.now(), ...payload });
    toast('Gagal kirim sekarang, disimpan di Outbox: ' + e.message);
    closeCompose();
  }
}

async function flushOutbox() {
  if (!session) return;
  const pending = await idbGetAll('outbox');
  for (const item of pending) {
    try {
      await callBackend('sendMessage', {
        server: session.server, authToken: session.authToken,
        to: item.to, subject: item.subject, body: item.body
      });
      await idbDelete('outbox', item.localId);
      toast('Email dari Outbox terkirim: ' + (item.subject || '(tanpa subjek)'));
    } catch (e) {
      // biarkan di outbox, coba lagi nanti
    }
  }
}

// ============================================================
// DRAWER
// ============================================================
document.getElementById('btn-open-drawer').addEventListener('click', openDrawer);
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);
function openDrawer() {
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-backdrop').classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('open');
}

// ============================================================
// UTIL
// ============================================================
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ============================================================
// INIT
// ============================================================
(async function init() {
  updateOnlineStatus();
  ensureDb().catch(() => {}); // mulai siapkan di awal, tidak perlu ditunggu di sini

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const restored = await tryRestoreSession();
  if (!restored) showScreen('screen-login');

  if (navigator.onLine) flushOutbox();
})();
