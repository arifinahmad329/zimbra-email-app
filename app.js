// ============================================================
// KONFIGURASI
// ============================================================
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzz-xF0hZk-O2s9oMRxq72ZhJeROjB32K17T176nVvHj9aDHh6oGdW7VGm80W87c1EM/exec';

const PAGE_SIZE = 30;
const DETAIL_BATCH = 8;                      // jumlah pesan per panggilan getMessages
const AUTO_SYNC_FOLDERS = ['inbox', 'sent']; // folder yang disinkron otomatis
const AUTO_SYNC_MAX_PAGES = 7;               // maks ~210 pesan terbaru per folder (otomatis)
const REQUEST_TIMEOUT_MS = 45000;

// ============================================================
// STATE
// ============================================================
let session = null; // { server, user, authToken, expired }
let currentFolder = null;
let currentOffset = 0;
let folderCache = [];
let db = null;
let loadToken = 0;     // membatalkan hasil loadMessages yang sudah basi
let detailToken = 0;   // membatalkan hasil openMessage yang sudah basi
let searchToken = 0;
let syncing = false;
let flushing = false;
let flushingReads = false;
let batchSupported = true;

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

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function idbPut(storeName, value) {
  return ensureDb().then((d) => {
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    return txDone(tx);
  });
}

function idbPutMany(storeName, values) {
  if (!values || !values.length) return Promise.resolve();
  return ensureDb().then((d) => {
    const tx = d.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    values.forEach((v) => st.put(v));
    return txDone(tx);
  });
}

function idbReplaceAll(storeName, values) {
  return ensureDb().then((d) => {
    const tx = d.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    st.clear();
    values.forEach((v) => st.put(v));
    return txDone(tx);
  });
}

function idbGet(storeName, key) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const req = d.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbGetAll(storeName) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const req = d.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbKeys(storeName) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const req = d.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbGetByIndex(storeName, indexName, value) {
  return ensureDb().then((d) => new Promise((resolve, reject) => {
    const req = d.transaction(storeName, 'readonly').objectStore(storeName).index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function idbDelete(storeName, key) {
  return ensureDb().then((d) => {
    const tx = d.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    return txDone(tx);
  });
}

function idbDeleteMany(storeName, keys) {
  if (!keys || !keys.length) return Promise.resolve();
  return ensureDb().then((d) => {
    const tx = d.transaction(storeName, 'readwrite');
    const st = tx.objectStore(storeName);
    keys.forEach((k) => st.delete(k));
    return txDone(tx);
  });
}

function idbClearAll() {
  return ensureDb().then((d) => {
    const names = ['folders', 'messages', 'messageDetail', 'outbox', 'session'];
    const tx = d.transaction(names, 'readwrite');
    names.forEach((n) => tx.objectStore(n).clear());
    return txDone(tx);
  });
}

// ============================================================
// PANGGIL BACKEND (Google Apps Script)
// ============================================================
function canUseNetwork() {
  return navigator.onLine && !!session && !session.expired;
}

async function callBackend(action, params, timeoutMs) {
  if (!navigator.onLine) throw new Error('OFFLINE');
  if (action !== 'login' && session && session.expired) throw new Error('AUTH_EXPIRED');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(BACKEND_URL, {
      method: 'POST',
      // text/plain supaya browser tidak melakukan CORS preflight ke Apps Script
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, params }),
      signal: ctrl.signal
    });
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error('Respons backend tidak valid (kuota Apps Script habis, atau deployment belum diperbarui)');
    }
    if (!data.ok) {
      const msg = data.error || 'Terjadi kesalahan';
      if (data.code === 'AUTH_EXPIRED' || /AUTH_EXPIRED|AUTH_REQUIRED/.test(msg)) {
        if (action !== 'login') markSessionExpired();
        throw new Error('AUTH_EXPIRED');
      }
      throw new Error(msg);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Server terlalu lama merespons');
    if (e instanceof TypeError) throw new Error('Tidak dapat menghubungi backend');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Tampilkan error ke pengguna, kecuali error yang sudah ditangani sendiri
function reportError(prefix, e) {
  if (!e) return;
  if (e.message === 'AUTH_EXPIRED' || e.message === 'OFFLINE') return;
  toast(prefix + ': ' + e.message);
}

// ============================================================
// SESI HABIS (AUTH_EXPIRED)
// ============================================================
function markSessionExpired() {
  if (!session || session.expired) return;
  session.expired = true;
  idbPut('session', { k: 'current', ...session }).catch(() => {});
  showExpiredBanner();
}

function showExpiredBanner() {
  let b = document.getElementById('expired-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'expired-banner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b3261e;color:#fff;' +
      'padding:calc(8px + env(safe-area-inset-top,0px)) 14px 8px;display:flex;align-items:center;' +
      'justify-content:space-between;gap:10px;font-size:13px;box-shadow:0 2px 6px rgba(0,0,0,.3);';
    const span = document.createElement('span');
    span.textContent = 'Sesi habis. Email tersimpan tetap bisa dibaca.';
    const btn = document.createElement('button');
    btn.textContent = 'Masuk lagi';
    btn.style.cssText = 'border:0;border-radius:6px;padding:6px 12px;font-weight:600;background:#fff;color:#b3261e;cursor:pointer;';
    btn.addEventListener('click', showLoginAgain);
    b.appendChild(span);
    b.appendChild(btn);
    document.body.appendChild(b);
  }
  b.style.display = 'flex';
}

function hideExpiredBanner() {
  const b = document.getElementById('expired-banner');
  if (b) b.style.display = 'none';
}

function ensureLoginCancel(show) {
  let b = document.getElementById('btn-login-cancel');
  if (!b) {
    const loginBtn = document.getElementById('btn-login');
    b = document.createElement('button');
    b.id = 'btn-login-cancel';
    b.type = 'button';
    b.textContent = 'Kembali baca email offline';
    b.style.cssText = 'display:block;width:100%;margin-top:12px;padding:12px;border:0;background:transparent;' +
      'color:inherit;text-decoration:underline;font-size:14px;cursor:pointer;';
    b.addEventListener('click', () => showScreen('screen-inbox'));
    loginBtn.insertAdjacentElement('afterend', b);
  }
  b.style.display = show ? 'block' : 'none';
}

function showLoginAgain() {
  if (session) {
    document.getElementById('in-server').value = session.server || '';
    document.getElementById('in-user').value = session.user || '';
  }
  document.getElementById('in-pass').value = '';
  const err = document.getElementById('login-error');
  err.textContent = 'Sesi habis. Masukkan password lagi. Email yang sudah tersimpan tetap aman.';
  err.style.display = 'block';
  ensureLoginCancel(true);
  showScreen('screen-login');
}

// ============================================================
// UI HELPERS
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function setProgress(text) {
  const el = document.getElementById('sync-progress');
  el.style.display = 'block';
  el.textContent = text;
}
function hideProgress(delay) {
  const el = document.getElementById('sync-progress');
  if (delay) setTimeout(() => { el.style.display = 'none'; }, delay);
  else el.style.display = 'none';
}

function updateOnlineStatus() {
  document.body.classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', () => {
  updateOnlineStatus();
  flushOutbox();
  flushPendingReads();
  autoSyncAllFolders();
});
window.addEventListener('offline', updateOnlineStatus);

function fmtDate(ms) {
  const d = new Date(parseInt(ms, 10));
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  }
  const opts = { day: '2-digit', month: 'short' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('id-ID', opts);
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function htmlToText(html) {
  if (!html) return '';
  const prepared = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  const doc = new DOMParser().parseFromString(prepared, 'text/html'); // tidak menjalankan skrip
  doc.querySelectorAll('style,script').forEach((n) => n.remove());
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function plainTextOf(msg) {
  return msg.textBody || htmlToText(msg.htmlBody) || '';
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

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.textContent = 'Memproses...';

  try {
    const data = await callBackend('login', { server, user, pass });
    session = { server: data.server || server, user, authToken: data.authToken, expired: false };
    await idbPut('session', { k: 'current', ...session });
    document.getElementById('in-pass').value = '';
    document.getElementById('drawer-user').textContent = user;
    document.getElementById('drawer-server').textContent = session.server;
    hideExpiredBanner();
    ensureLoginCancel(false);
    showScreen('screen-inbox');
    const hadFolder = !!currentFolder; // login ulang setelah sesi habis
    await loadFolders();
    if (hadFolder) loadMessages(true);
    flushOutbox();
    flushPendingReads();
    autoSyncAllFolders(); // di belakang layar
  } catch (e) {
    errEl.textContent = e.message === 'OFFLINE'
      ? 'Tidak ada koneksi internet. Login membutuhkan koneksi.'
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
    showScreen('screen-inbox');
    if (session.expired) showExpiredBanner();
    await loadFolders();
    autoSyncAllFolders(); // di belakang layar
    return true;
  }
  return false;
}

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!confirm('Keluar dan hapus semua data email yang tersimpan di HP ini?')) return;
  await idbClearAll();
  session = null;
  currentFolder = null;
  folderCache = [];
  loadToken++;
  document.getElementById('msg-list').innerHTML = '';
  document.getElementById('folder-list').innerHTML = '';
  document.getElementById('in-pass').value = '';
  hideExpiredBanner();
  ensureLoginCancel(false);
  closeDrawer();
  showScreen('screen-login');
});

// ============================================================
// FOLDER
// ============================================================
function sortFolders(list) {
  const arr = list.slice();
  arr.sort((a, b) => {
    const ai = a.name.toLowerCase() === 'inbox' ? 0 : 1;
    const bi = b.name.toLowerCase() === 'inbox' ? 0 : 1;
    return ai - bi;
  });
  return arr;
}

function pickInbox(list) {
  return list.find((f) => f.name.toLowerCase() === 'inbox') || list[0];
}

async function loadFolders() {
  // Tampilkan dulu dari cache lokal (instan)
  const cached = await idbGetAll('folders');
  if (cached.length) {
    renderFolderList(sortFolders(cached));
    if (!currentFolder) openFolder(pickInbox(cached));
  }

  if (!canUseNetwork()) return;
  try {
    const data = await callBackend('getFolders', { server: session.server, authToken: session.authToken });
    await idbReplaceAll('folders', data.folders);
    const fresh = await idbGetAll('folders');
    renderFolderList(sortFolders(fresh));
    if (!currentFolder && fresh.length) openFolder(pickInbox(fresh));
  } catch (e) {
    reportError('Gagal ambil folder', e);
  }
}

function renderFolderList(folders) {
  folderCache = folders;
  const el = document.getElementById('folder-list');
  el.innerHTML = '';
  folders.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'folder-item' + (currentFolder && currentFolder.id === f.id ? ' active' : '');
    div.innerHTML = `<span>${escapeHtml(f.path || f.name)}</span>` +
      (f.unread > 0 ? `<span class="badge">${f.unread}</span>` : '');
    div.addEventListener('click', () => { openFolder(f); closeDrawer(); });
    el.appendChild(div);
  });
}

function openFolder(f) {
  currentFolder = f;
  currentOffset = 0;
  if (searchMode) exitSearchUi();
  document.getElementById('folder-title').textContent = f.name;
  renderFolderList(folderCache);
  loadMessages(true);
}

// ============================================================
// PESAN TERTUNDA DITANDAI "DIBACA" (disinkronkan saat online)
// ============================================================
async function getPendingReads() {
  const rec = await idbGet('session', 'pendingRead');
  return new Set(rec && rec.ids ? rec.ids : []);
}
async function savePendingReads(set) {
  await idbPut('session', { k: 'pendingRead', ids: Array.from(set) });
}
async function applyPendingReads(messages) {
  const pend = await getPendingReads();
  if (!pend.size) return;
  messages.forEach((m) => { if (pend.has(m.id)) m.unread = false; });
}
async function flushPendingReads() {
  if (flushingReads || !canUseNetwork()) return;
  flushingReads = true;
  try {
    const pend = await getPendingReads();
    for (const id of Array.from(pend)) {
      if (!canUseNetwork()) break;
      try {
        await callBackend('markRead', { server: session.server, authToken: session.authToken, id, read: true });
        pend.delete(id);
        await savePendingReads(pend);
      } catch (e) {
        if (e.message === 'AUTH_EXPIRED' || e.message === 'OFFLINE') break;
      }
    }
  } finally {
    flushingReads = false;
  }
}

async function markAsRead(id) {
  const hdr = await idbGet('messages', id);
  if (hdr && !hdr.unread) return; // sudah dibaca
  document.querySelectorAll('.msg-item').forEach((el) => {
    if (el.dataset.id === id) el.classList.add('read');
  });
  if (hdr) {
    hdr.unread = false;
    await idbPut('messages', hdr);
  }
  const pend = await getPendingReads();
  pend.add(id);
  await savePendingReads(pend);
  flushPendingReads();
}

// ============================================================
// DAFTAR PESAN
// ============================================================
function emptyState(title, text) {
  return `<div class="empty-state"><div class="big">${escapeHtml(title)}</div>${escapeHtml(text)}</div>`;
}

async function loadMessages(reset) {
  const folder = currentFolder;
  if (!folder) return;
  const token = ++loadToken;
  const listEl = document.getElementById('msg-list');
  if (reset) currentOffset = 0;
  const offset = currentOffset;

  // 1) Tampilkan dulu dari cache lokal
  let hadCache = false;
  if (reset) {
    const cached = await idbGetByIndex('messages', 'folderId', folder.id);
    if (token !== loadToken) return;
    cached.sort((a, b) => parseInt(b.date, 10) - parseInt(a.date, 10));
    listEl.innerHTML = '';
    if (cached.length) {
      hadCache = true;
      cached.forEach((m) => listEl.appendChild(renderMsgItem(m)));
    } else if (canUseNetwork()) {
      listEl.innerHTML = '<div class="spinner"></div>';
    }
  }

  if (!canUseNetwork()) {
    if (reset && !hadCache) {
      listEl.innerHTML = emptyState('Tidak ada pesan', 'Belum ada pesan tersimpan untuk folder ini (mode offline).');
    }
    return;
  }

  // 2) Ambil versi terbaru dari server
  try {
    const data = await callBackend('listMessages', {
      server: session.server, authToken: session.authToken,
      folderId: folder.id, folderName: folder.name, offset
    });
    if (token !== loadToken) return; // pengguna sudah pindah folder
    const messages = data.messages.map((m) => ({ ...m, folderId: folder.id }));
    await applyPendingReads(messages);
    await idbPutMany('messages', messages);
    if (token !== loadToken) return;

    if (reset) listEl.innerHTML = '';
    else listEl.querySelectorAll('.load-more').forEach((n) => n.remove());

    if (messages.length === 0 && reset) {
      listEl.innerHTML = emptyState('Tidak ada pesan', 'Folder ini kosong.');
      return;
    }
    messages.forEach((m) => listEl.appendChild(renderMsgItem(m)));
    if (messages.length >= PAGE_SIZE) {
      const more = document.createElement('div');
      more.className = 'load-more';
      more.textContent = 'Muat lebih banyak';
      more.addEventListener('click', () => {
        more.textContent = 'Memuat...';
        currentOffset = offset + PAGE_SIZE;
        loadMessages(false);
      });
      listEl.appendChild(more);
    }
  } catch (e) {
    if (token !== loadToken) return;
    reportError('Gagal ambil pesan', e);
    if (reset && !hadCache) {
      listEl.innerHTML = emptyState('Gagal memuat', 'Tarik ulang dengan tombol segarkan.');
    } else if (!reset) {
      currentOffset = Math.max(0, offset);
      const more = listEl.querySelector('.load-more');
      if (more) more.textContent = 'Muat lebih banyak';
    }
  }
}

function renderMsgItem(m) {
  const div = document.createElement('div');
  div.className = 'msg-item' + (m.unread ? '' : ' read');
  div.dataset.id = m.id;
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

document.getElementById('btn-refresh').addEventListener('click', () => {
  loadMessages(true);
  // sekalian unduh isi pesan baru di halaman pertama (di belakang layar)
  if (currentFolder && !syncing && canUseNetwork()) {
    const folder = currentFolder;
    syncing = true;
    syncFolder(folder, { maxPages: 1 })
      .catch(() => {})
      .finally(() => { syncing = false; hideProgress(); });
  }
});

// ============================================================
// SINKRONISASI
// ============================================================
async function fetchDetails(ids) {
  if (batchSupported) {
    try {
      const d = await callBackend('getMessages', { server: session.server, authToken: session.authToken, ids });
      return d.messages;
    } catch (e) {
      if (/Aksi tidak dikenal/.test(e.message)) batchSupported = false; // backend lama
      else throw e;
    }
  }
  const out = [];
  for (const id of ids) {
    try {
      const d = await callBackend('getMessage', { server: session.server, authToken: session.authToken, id });
      out.push(d.message);
    } catch (e) {
      if (e.message === 'AUTH_EXPIRED' || e.message === 'OFFLINE') throw e;
    }
  }
  return out;
}

// opts: { full: true } = telusuri semua halaman + bersihkan pesan yang sudah dihapus di server
//       { maxPages: n } = batasi jumlah halaman
// Tanpa full: berhenti begitu satu halaman sudah tersimpan semua (sinkronisasi bertahap).
async function syncFolder(folder, opts) {
  opts = opts || {};
  const maxPages = opts.maxPages || Infinity;
  const have = new Set(await idbKeys('messageDetail'));
  const seen = new Set();
  const toFetch = [];
  let offset = 0;
  let pages = 0;
  let listedAll = false;

  while (pages < maxPages) {
    if (!canUseNetwork()) return { total: seen.size, complete: false };
    const data = await callBackend('listMessages', {
      server: session.server, authToken: session.authToken,
      folderId: folder.id, folderName: folder.name, offset
    });
    const batch = data.messages.map((m) => ({ ...m, folderId: folder.id }));
    await applyPendingReads(batch);
    await idbPutMany('messages', batch);
    pages++;

    let missing = 0;
    for (const m of batch) {
      seen.add(m.id);
      if (!have.has(m.id)) { toFetch.push(m.id); missing++; }
    }
    setProgress('Mengambil daftar pesan "' + folder.name + '" (' + seen.size + ' ditemukan)...');

    if (batch.length < PAGE_SIZE) { listedAll = true; break; }
    if (!opts.full && missing === 0) break;
    offset += PAGE_SIZE;
  }

  let done = 0;
  for (let i = 0; i < toFetch.length; i += DETAIL_BATCH) {
    if (!canUseNetwork()) break;
    const ids = toFetch.slice(i, i + DETAIL_BATCH);
    try {
      const msgs = await fetchDetails(ids);
      await idbPutMany('messageDetail', msgs);
    } catch (e) {
      if (e.message === 'AUTH_EXPIRED' || e.message === 'OFFLINE') throw e;
      // kelompok ini dilewati, lanjut ke berikutnya
    }
    done += ids.length;
    setProgress('Menyimpan untuk offline: ' + done + ' / ' + toFetch.length + ' pesan baru (' + folder.name + ')...');
  }

  // Bersihkan pesan yang sudah tidak ada di server (hanya saat daftar lengkap diambil)
  if (opts.full && listedAll) {
    const local = await idbGetByIndex('messages', 'folderId', folder.id);
    const gone = local.filter((m) => !seen.has(m.id)).map((m) => m.id);
    await idbDeleteMany('messages', gone);
    await idbDeleteMany('messageDetail', gone);
  }
  return { total: seen.size, complete: listedAll };
}

async function autoSyncAllFolders() {
  if (syncing || !canUseNetwork()) return;
  syncing = true;
  try {
    const all = await idbGetAll('folders');
    const folders = sortFolders(all.filter((f) => AUTO_SYNC_FOLDERS.indexOf(f.name.toLowerCase()) !== -1));
    for (const f of folders) {
      if (!canUseNetwork()) break;
      await syncFolder(f, { maxPages: AUTO_SYNC_MAX_PAGES });
    }
  } catch (e) {
    // sinkronisasi otomatis tidak boleh mengganggu pengguna
  } finally {
    syncing = false;
    hideProgress();
  }
}

document.getElementById('btn-sync-all').addEventListener('click', async () => {
  closeDrawer();
  if (!currentFolder) return;
  if (!navigator.onLine) { toast('Sambungkan internet dulu untuk mengunduh semua pesan'); return; }
  if (session && session.expired) { showLoginAgain(); return; }
  if (syncing) { toast('Sinkronisasi sedang berjalan, tunggu sebentar'); return; }
  syncing = true;
  const folder = currentFolder;
  try {
    const r = await syncFolder(folder, { full: true });
    setProgress('Selesai! ' + r.total + ' pesan di "' + folder.name + '" siap dibaca offline.');
    hideProgress(4000);
  } catch (e) {
    hideProgress();
    reportError('Gagal sinkronisasi', e);
  } finally {
    syncing = false;
  }
});

// ============================================================
// PENCARIAN (lintas semua folder)
// ============================================================
let searchMode = false;
const btnSearch = document.getElementById('btn-search');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');

function exitSearchUi() {
  searchMode = false;
  searchToken++;
  searchBar.style.display = 'none';
}

btnSearch.addEventListener('click', () => {
  searchMode = !searchMode;
  searchBar.style.display = searchMode ? 'block' : 'none';
  if (searchMode) {
    searchInput.value = '';
    searchInput.focus();
  } else {
    searchToken++;
    if (currentFolder) {
      document.getElementById('folder-title').textContent = currentFolder.name;
      loadMessages(true);
    }
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch(searchInput.value.trim());
});

async function doSearch(keyword) {
  if (!keyword) return;
  const token = ++searchToken;
  const listEl = document.getElementById('msg-list');
  document.getElementById('folder-title').textContent = 'Hasil: "' + keyword + '"';
  listEl.innerHTML = '<div class="spinner"></div>';

  let results = [];
  let usedOffline = false;
  if (canUseNetwork()) {
    try {
      const data = await callBackend('search', { server: session.server, authToken: session.authToken, keyword });
      results = data.messages;
    } catch (e) {
      reportError('Gagal mencari', e);
      usedOffline = true;
    }
  } else {
    usedOffline = true;
  }

  if (usedOffline) {
    // Cari di semua pesan yang sudah tersimpan di HP (termasuk isi pesan)
    const [all, details] = await Promise.all([idbGetAll('messages'), idbGetAll('messageDetail')]);
    const bodies = new Map(details.map((d) => [d.id, plainTextOf(d).toLowerCase()]));
    const kw = keyword.toLowerCase();
    results = all.filter((m) =>
      (m.subject || '').toLowerCase().includes(kw) ||
      (m.from && (m.from.name || '').toLowerCase().includes(kw)) ||
      (m.from && (m.from.address || '').toLowerCase().includes(kw)) ||
      (m.snippet || '').toLowerCase().includes(kw) ||
      (bodies.get(m.id) || '').includes(kw)
    );
    results.sort((a, b) => parseInt(b.date, 10) - parseInt(a.date, 10));
    results = results.slice(0, 100);
    toast('Mencari di pesan yang tersimpan di HP saja');
  }

  if (token !== searchToken) return;
  listEl.innerHTML = '';
  if (results.length === 0) {
    listEl.innerHTML = emptyState('Tidak ditemukan', 'Tidak ada pesan yang cocok dengan "' + keyword + '".');
    return;
  }
  results.forEach((m) => listEl.appendChild(renderMsgItem(m)));
}

// ============================================================
// DETAIL PESAN
// ============================================================
async function openMessage(id) {
  const token = ++detailToken;
  showScreen('screen-detail');
  const content = document.getElementById('detail-content');
  content.innerHTML = '<div class="spinner"></div>';

  // Isi pesan jarang berubah: pakai cache dulu, hemat kuota & lebih cepat
  let msg = await idbGet('messageDetail', id);

  if (!msg && canUseNetwork()) {
    try {
      const data = await callBackend('getMessage', { server: session.server, authToken: session.authToken, id });
      msg = data.message;
      await idbPut('messageDetail', msg);
    } catch (e) {
      reportError('Gagal ambil pesan', e);
    }
  }
  if (token !== detailToken) return; // pengguna sudah membuka pesan lain / kembali

  if (!msg) {
    const why = (session && session.expired)
      ? 'Sesi habis, masuk lagi untuk mengambil pesan ini.'
      : 'Pesan ini belum tersimpan untuk offline. Sambungkan internet lalu buka lagi.';
    content.innerHTML = emptyState('Pesan tidak tersedia', why);
    return;
  }

  renderDetail(msg);
  markAsRead(id);
}

// Isi email HTML ditampilkan di iframe ter-sandbox: tanpa skrip, tanpa gambar jarak jauh
function renderBodyInto(container, msg) {
  if (!msg.htmlBody) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'white-space:pre-wrap;font-family:inherit;margin:0;';
    pre.textContent = msg.textBody || '(tidak ada isi)';
    container.replaceChildren(pre);
    return;
  }
  const safeHtml = String(msg.htmlBody)
    .replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.style.cssText = 'width:100%;border:0;display:block;';
  frame.srcdoc =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:">' +
    '<base target="_blank">' +
    '<style>body{margin:0;font:15px/1.5 sans-serif;overflow-wrap:anywhere;word-wrap:break-word}' +
    'img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}' +
    'blockquote{margin-left:0;padding-left:10px;border-left:3px solid #ccc}</style>' +
    safeHtml;
  const resize = () => {
    try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch (e) {}
  };
  frame.addEventListener('load', () => { resize(); setTimeout(resize, 300); });
  container.replaceChildren(frame);
}

function renderDetail(msg) {
  const content = document.getElementById('detail-content');
  const attachHtml = (msg.attachments || []).map((a) =>
    `<div class="attach-chip" data-part="${escapeHtml(a.part)}" data-msgid="${escapeHtml(msg.id)}" data-filename="${escapeHtml(a.filename)}">📎 ${escapeHtml(a.filename)}</div>`
  ).join('');

  content.innerHTML = `
    <div class="detail-pad">
      <h2>${escapeHtml(msg.subject || '(tanpa subjek)')}</h2>
      <div class="who-row">
        <span class="name">${escapeHtml(msg.from ? msg.from.name : '')}</span>
        <span class="date">${fmtDate(msg.date)}</span>
      </div>
      <div class="to-line">Kepada: ${escapeHtml((msg.to || []).map((t) => t.name).join(', ') || '-')}</div>
      <div class="body-html"></div>
      ${msg.attachments && msg.attachments.length ? `<div class="attach-list">${attachHtml}</div>` : ''}
    </div>
    <div class="detail-actions">
      <button id="btn-reply">Balas</button>
      <button class="primary" id="btn-forward">Teruskan</button>
    </div>`;

  renderBodyInto(content.querySelector('.body-html'), msg);

  content.querySelectorAll('.attach-chip').forEach((chip) => {
    chip.addEventListener('click', () => downloadAttachment(chip.dataset.msgid, chip.dataset.part, chip.dataset.filename));
  });

  const subj = msg.subject || '';
  const senderName = msg.from ? msg.from.name : '';
  const original = plainTextOf(msg);

  document.getElementById('btn-reply').addEventListener('click', () => {
    const quoted = original.split('\n').map((l) => '> ' + l).join('\n');
    openCompose({
      to: msg.from ? msg.from.address : '',
      subject: /^re:/i.test(subj) ? subj : 'Re: ' + subj,
      body: '\n\n' + 'Pada ' + fmtDate(msg.date) + ', ' + senderName + ' menulis:\n' + quoted
    });
  });
  document.getElementById('btn-forward').addEventListener('click', () => {
    openCompose({
      subject: /^fwd?:/i.test(subj) ? subj : 'Fwd: ' + subj,
      body: '\n\n--- Pesan diteruskan ---\nDari: ' + senderName +
        (msg.from && msg.from.address ? ' <' + msg.from.address + '>' : '') +
        '\nTanggal: ' + fmtDate(msg.date) + '\nSubjek: ' + subj + '\n\n' + original
    });
  });
}

async function downloadAttachment(msgId, part, filename) {
  if (!navigator.onLine) { toast('Sambungkan internet untuk mengunduh lampiran'); return; }
  if (session && session.expired) { showLoginAgain(); return; }
  toast('Mengunduh ' + filename + '...');
  try {
    const data = await callBackend('getAttachment',
      { server: session.server, authToken: session.authToken, msgId, part }, 90000);
    const bin = atob(data.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: data.contentType || 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    reportError('Gagal mengunduh', e);
  }
}

document.getElementById('btn-back-detail').addEventListener('click', () => {
  detailToken++;
  showScreen('screen-inbox');
});

// ============================================================
// TULIS / KIRIM EMAIL (dengan outbox untuk mode offline)
// ============================================================
document.getElementById('btn-compose').addEventListener('click', () => openCompose());
document.getElementById('btn-close-compose').addEventListener('click', closeCompose);
document.getElementById('btn-send').addEventListener('click', doSend);

function openCompose(prefill) {
  prefill = prefill || {};
  document.getElementById('compose-to').value = prefill.to || '';
  const ccEl = document.getElementById('compose-cc'); // opsional, hanya jika ada di index.html
  if (ccEl) ccEl.value = prefill.cc || '';
  document.getElementById('compose-subject').value = prefill.subject || '';
  document.getElementById('compose-body').value = prefill.body || '';
  document.getElementById('compose-sheet').classList.add('open');
}
function closeCompose() {
  document.getElementById('compose-sheet').classList.remove('open');
}

async function doSend() {
  const to = document.getElementById('compose-to').value.trim();
  const ccEl = document.getElementById('compose-cc');
  const cc = ccEl ? ccEl.value.trim() : '';
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value;

  if (!to) { toast('Isi alamat penerima dulu'); return; }
  if (to.indexOf('@') === -1) { toast('Alamat penerima tidak valid'); return; }

  const payload = { to, cc, subject, body };
  const sendBtn = document.getElementById('btn-send');
  sendBtn.disabled = true;

  const saveToOutbox = () => idbPut('outbox', {
    localId: 'out_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    ...payload
  });

  try {
    if (!canUseNetwork()) {
      await saveToOutbox();
      toast(session && session.expired
        ? 'Sesi habis — email disimpan di Outbox, akan dikirim setelah kamu masuk lagi.'
        : 'Tidak ada internet — email disimpan di Outbox, akan dikirim otomatis saat online.');
      closeCompose();
      return;
    }
    try {
      await callBackend('sendMessage', { server: session.server, authToken: session.authToken, ...payload });
      toast('Email terkirim');
      closeCompose();
    } catch (e) {
      await saveToOutbox();
      toast(e.message === 'AUTH_EXPIRED'
        ? 'Sesi habis — email disimpan di Outbox, akan dikirim setelah kamu masuk lagi.'
        : 'Gagal kirim sekarang, disimpan di Outbox: ' + e.message);
      closeCompose();
    }
  } finally {
    sendBtn.disabled = false;
  }
}

async function flushOutbox() {
  if (flushing || !canUseNetwork()) return;
  flushing = true;
  try {
    const pending = await idbGetAll('outbox');
    pending.sort((a, b) => (a.localId < b.localId ? -1 : 1));
    for (const item of pending) {
      if (!canUseNetwork()) break;
      try {
        await callBackend('sendMessage', {
          server: session.server, authToken: session.authToken,
          to: item.to, cc: item.cc || '', subject: item.subject, body: item.body
        });
        await idbDelete('outbox', item.localId);
        toast('Email dari Outbox terkirim: ' + (item.subject || '(tanpa subjek)'));
      } catch (e) {
        if (e.message === 'AUTH_EXPIRED' || e.message === 'OFFLINE') break;
        // kegagalan lain: biarkan di outbox, coba lagi nanti
      }
    }
  } finally {
    flushing = false;
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
// INIT
// ============================================================
(async function init() {
  updateOnlineStatus();
  ensureDb().catch(() => {});

  // Izinkan zoom dengan cubit (maximum-scale=1 menyulitkan membaca email)
  const vp = document.querySelector('meta[name="viewport"]');
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1');

  // Minta Android agar tidak menghapus data offline saat ruang penyimpanan menipis
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('Versi baru terpasang. Tutup lalu buka lagi aplikasi.');
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  const restored = await tryRestoreSession();
  if (!restored) showScreen('screen-login');

  flushOutbox();
  flushPendingReads();

  try {
    const waiting = (await idbGetAll('outbox')).length;
    if (waiting) toast(waiting + ' email menunggu di Outbox');
  } catch (e) {}
})();
