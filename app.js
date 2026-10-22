'use strict';
/* global icon, hydrateIcons, Equalizer, EQ_FREQS, EQ_PRESETS, jsmediatags */
// Melodia for phones: an offline player. Music is imported from the phone's files and kept
// inside the app (IndexedDB), so it plays without internet and survives restarts.

// ============================================================ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const fmtLong = (s) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} ч ${m} мин` : `${m} мин`; };
const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; };
const tracksWord = (n) => `${n} ${plural(n, 'трек', 'трека', 'треков')}`;
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' ГБ' : Math.round(b / 1e6) + ' МБ');

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 2600);
}

// ============================================================ storage (IndexedDB)
// tracks: id -> meta, audio: id -> Blob, covers: key -> Blob, kv: 'lib' -> user data
const db = {
  h: null,
  open() {
    if (!this.h) this.h = new Promise((res, rej) => {
      const r = indexedDB.open('melodia', 1);
      r.onupgradeneeded = () => { for (const s of ['tracks', 'audio', 'covers', 'kv']) r.result.createObjectStore(s); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.h;
  },
  async run(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('запись не удалась'));
    });
  },
  get: (s, k) => db.run(s, 'readonly', (st) => st.get(k)),
  put: (s, k, v) => db.run(s, 'readwrite', (st) => { st.put(v, k); }),
  del: (s, k) => db.run(s, 'readwrite', (st) => { st.delete(k); }),
  async entries(s) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const out = [];
      const req = d.transaction(s).objectStore(s).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
      req.onerror = () => rej(req.error);
    });
  },
};

// ============================================================ appearance (same palette as the desktop app)
const THEMES = [
  ['spruce', 'Ель', 160, 1], ['ocean', 'Океан', 205, 1], ['night', 'Ночь', 228, 0.85], ['violet', 'Аметист', 270, 0.9],
  ['cherry', 'Вишня', 340, 0.9], ['sunset', 'Закат', 14, 0.95], ['amber', 'Янтарь', 38, 0.9], ['olive', 'Олива', 85, 0.75],
  ['graphite', 'Графит', 210, 0.12],
];
function applyTheme(th) {
  const h = th.hue, k = th.sat;
  const c = (sat, light, a) => `hsla(${h}, ${Math.min(100, sat * k)}%, ${light}%, ${a == null ? 1 : a})`;
  const acc = (sat, light) => `hsl(${h}, ${Math.min(100, sat * Math.max(k, 0.35))}%, ${light}%)`;
  const vars = {
    '--g1': c(26, 41), '--g2': c(36, 28), '--g3': c(30, 33), '--g4': c(29, 28), '--g5': c(30, 22),
    '--panel-solid': c(28, 20, 0.9), '--sheet-bg': c(26, 22, 0.94), '--toast-bg': c(27, 26, 0.92), '--toast-ok': c(33, 38, 0.95), '--hero': c(41, 31),
    '--accent': acc(66, 79), '--accent-hi': acc(75, 86), '--accent-ink': acc(52, 15),
    '--liked1': acc(45, 34), '--liked2': acc(50, 66), '--switch': acc(45, 57),
  };
  for (const [n, v] of Object.entries(vars)) document.documentElement.style.setProperty(n, v);
  document.body.classList.toggle('no-ambient', !th.ambient);
  $('meta[name="theme-color"]').content = `hsl(${h}, ${Math.min(100, 30 * k)}%, 22%)`;
}
function hexToHueSat(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { hue: Math.round((h * 60 + 360) % 360), sat: Math.max(0.08, Math.min(1.3, sat * 1.3)) };
}
const themeSwatch = (hue, k) => `background:linear-gradient(135deg, hsl(${hue}, ${Math.min(100, 30 * k)}%, 45%) 0%, hsl(${hue}, ${Math.min(100, 32 * k)}%, 24%) 70%)`;
function setTheme(patch) { Object.assign(lib.settings.theme, patch); applyTheme(lib.settings.theme); save(); }

// ============================================================ library state
const DEFAULT_LIB = {
  version: 1,
  playlists: [],   // { id, name, created, ids: [] }
  liked: [],       // track ids
  recent: [],      // track ids
  recentLists: [], // list contexts
  settings: {
    shuffle: false, repeat: 'off', sort: 'added',
    eq: { enabled: false, preset: 'Ровный', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], preamp: 0 },
    eqCustom: {},
    theme: { id: 'spruce', hue: 160, sat: 1, ambient: true },
  },
};
let lib = structuredClone(DEFAULT_LIB);
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.put('kv', 'lib', lib).catch((e) => toast('Не удалось сохранить: ' + e.message, 'err')), 300);
}

let allTracks = [];        // track meta, newest first
let byId = new Map();
const coverUrls = new Map(); // cover key -> object URL
const coverOf = (t) => (t && t.cover ? coverUrls.get(t.cover) || '' : '');

const resolveIds = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
const isLiked = (t) => !!t && lib.liked.includes(t.id);
function toggleLike(t) {
  if (!t) return;
  if (isLiked(t)) { lib.liked = lib.liked.filter((x) => x !== t.id); toast('Удалено из любимых'); }
  else { lib.liked.unshift(t.id); toast('Добавлено в любимые', 'ok'); }
  save(); refreshLikes();
}
const getPlaylist = (id) => lib.playlists.find((p) => p.id === id);
function createPlaylist(name, tracks = []) {
  const p = { id: uid(), name: name || `Мой плейлист № ${lib.playlists.length + 1}`, created: Date.now(), ids: tracks.map((t) => t.id) };
  lib.playlists.unshift(p);
  save();
  return p;
}
function addToPlaylist(p, tracks) {
  const add = tracks.map((t) => t.id).filter((id) => !p.ids.includes(id));
  p.ids.push(...add);
  save();
  toast(add.length ? `Добавлено в «${p.name}»` : 'Уже есть в плейлисте', add.length ? 'ok' : '');
}
function pushRecent(t) {
  lib.recent = [t.id, ...lib.recent.filter((x) => x !== t.id)].slice(0, 60);
  if (queue.ctx && !queue.ctx.startsWith('queue') && ctxExists(queue.ctx)) lib.recentLists = [queue.ctx, ...lib.recentLists.filter((c) => c !== queue.ctx)].slice(0, 10);
  save();
}

function sorted(tracks) {
  const s = lib.settings.sort;
  const arr = tracks.slice();
  if (s === 'title') arr.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  else if (s === 'artist') arr.sort((a, b) => (a.artist || '').localeCompare(b.artist || '', 'ru') || a.title.localeCompare(b.title, 'ru'));
  else arr.sort((a, b) => b.added - a.added);
  return arr;
}
const lists = {}; // ctx -> tracks currently on screen
function listFromCtx(ctx) {
  if (ctx === 'all') return sorted(allTracks);
  if (ctx === 'liked') return resolveIds(lib.liked);
  if (ctx === 'recent') return resolveIds(lib.recent);
  if (ctx.startsWith('pl:')) { const p = getPlaylist(ctx.slice(3)); return p ? resolveIds(p.ids) : []; }
  return lists[ctx] || [];
}
function ctxTitle(ctx) {
  if (ctx === 'all') return 'Все треки';
  if (ctx === 'liked') return 'Любимые треки';
  if (ctx === 'recent') return 'Недавно прослушанные';
  if (ctx.startsWith('pl:')) { const p = getPlaylist(ctx.slice(3)); return p ? p.name : ''; }
  return '';
}
const ctxExists = (ctx) => ctx === 'all' || ctx === 'liked' || ctx === 'recent' || (ctx.startsWith('pl:') && !!getPlaylist(ctx.slice(3)));

// ============================================================ import
// Reads tags (title, artist, album, cover) with jsmediatags and the duration with an <audio>.
function readTags(file) {
  return new Promise((res) => {
    try { jsmediatags.read(file, { onSuccess: (r) => res(r.tags || {}), onError: () => res({}) }); } catch { res({}); }
  });
}
function readDuration(blob) {
  return new Promise((res) => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = (d) => { URL.revokeObjectURL(url); a.removeAttribute('src'); res(isFinite(d) ? Math.round(d) : 0); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = url;
  });
}
function fromFileName(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  const m = base.match(/^(?:\d{1,3}[.\s-]+)?(.+?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: base };
}
function hashBytes(bytes) {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(bytes.length / 4096));
  for (let i = 0; i < bytes.length; i += step) h = Math.imul(h ^ bytes[i], 16777619);
  return (h >>> 0).toString(36) + '-' + bytes.length.toString(36);
}
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|mp4|alac)$/i;

let importing = false;
async function importFiles(files, playlist) {
  files = [...files].filter((f) => f.type.startsWith('audio/') || AUDIO_RE.test(f.name));
  if (!files.length) return toast('Это не аудиофайлы');
  if (importing) return toast('Подожди, предыдущие файлы ещё добавляются');
  importing = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const known = new Set(allTracks.map((t) => `${t.name}|${t.size}`));
  const added = [];
  let skipped = 0, failed = 0;
  const bar = showProgress(files.length);
  for (const [i, f] of files.entries()) {
    bar(i, f.name);
    if (known.has(`${f.name}|${f.size}`)) { skipped++; continue; }
    try {
      const tags = await readTags(f);
      const guess = fromFileName(f.name);
      const t = {
        id: uid(), name: f.name, size: f.size, type: f.type || '',
        title: (tags.title || guess.title || f.name).trim(), artist: (tags.artist || guess.artist || '').trim(), album: (tags.album || '').trim(),
        duration: await readDuration(f), added: Date.now() + i, cover: '',
      };
      const pic = tags.picture;
      if (pic && pic.data && pic.data.length) {
        const bytes = Uint8Array.from(pic.data);
        const key = hashBytes(bytes);
        if (!coverUrls.has(key)) {
          const blob = new Blob([bytes], { type: pic.format && pic.format.includes('/') ? pic.format : 'image/jpeg' });
          await db.put('covers', key, blob);
          coverUrls.set(key, URL.createObjectURL(blob));
        }
        t.cover = key;
      }
      await db.put('audio', t.id, f);
      await db.put('tracks', t.id, t);
      allTracks.unshift(t); byId.set(t.id, t); known.add(`${f.name}|${f.size}`);
      added.push(t);
    } catch (e) {
      failed++;
      if (/quota/i.test(e && (e.name + e.message))) { toast('На телефоне закончилось место для музыки', 'err'); break; }
    }
  }
  bar(files.length);
  importing = false;
  if (playlist && added.length) addToPlaylist(playlist, added);
  const parts = [added.length ? `Добавлено ${tracksWord(added.length)}` : 'Новых треков нет'];
  if (skipped) parts.push(`${skipped} уже были`);
  if (failed) parts.push(`${failed} не удалось прочитать`);
  toast(parts.join(' · '), added.length ? 'ok' : '');
  render();
}
function showProgress(total) {
  const el = document.createElement('div');
  el.className = 'toast progress';
  $('#toasts').appendChild(el);
  return (i, name) => {
    if (i >= total) { el.remove(); return; }
    el.innerHTML = `<div>Добавляю ${i + 1} из ${total}</div><div class="pname">${esc(name || '')}</div><div class="pbar"><div style="width:${(i / total) * 100}%"></div></div>`;
  };
}
let importTarget = null;
function pickFiles(playlist) { importTarget = playlist || null; $('#fileInput').value = ''; $('#fileInput').click(); }
$('#fileInput').addEventListener('change', (e) => { const f = e.target.files; if (f && f.length) importFiles(f, importTarget); });

async function deleteTracks(tracks) {
  for (const t of tracks) {
    await db.del('audio', t.id);
    await db.del('tracks', t.id);
    byId.delete(t.id);
  }
  const gone = new Set(tracks.map((t) => t.id));
  allTracks = allTracks.filter((t) => !gone.has(t.id));
  lib.liked = lib.liked.filter((id) => !gone.has(id));
  lib.recent = lib.recent.filter((id) => !gone.has(id));
  lib.playlists.forEach((p) => { p.ids = p.ids.filter((id) => !gone.has(id)); });
  queue.manual = queue.manual.filter((t) => !gone.has(t.id));
  if (player.current && gone.has(player.current.id)) player.close();
  // Covers nobody uses any more are removed too.
  const used = new Set(allTracks.map((t) => t.cover).filter(Boolean));
  for (const key of [...coverUrls.keys()]) if (!used.has(key)) { URL.revokeObjectURL(coverUrls.get(key)); coverUrls.delete(key); db.del('covers', key).catch(() => {}); }
  save();
}

// ============================================================ covers
function coverHtml(t, cls = '') {
  const c = coverOf(t);
  return c ? `<div class="cv ${cls}" style="background-image:url('${c}')"></div>` : `<div class="cv ${cls}">${icon('note')}</div>`;
}
function listCover(ctx, cls = '') {
  if (ctx === 'liked') return `<div class="cv liked ${cls}">${icon('heartFill')}</div>`;
  if (ctx === 'all') return `<div class="cv all ${cls}">${icon('library')}</div>`;
  const covers = [...new Set(listFromCtx(ctx).map(coverOf).filter(Boolean))];
  if (covers.length >= 4) return `<div class="cv mosaic ${cls}">${covers.slice(0, 4).map((c) => `<div style="background-image:url('${c}')"></div>`).join('')}</div>`;
  if (covers.length) return `<div class="cv ${cls}" style="background-image:url('${covers[0]}')"></div>`;
  return `<div class="cv ${cls}">${icon(ctx === 'recent' ? 'clock' : 'note')}</div>`;
}

// ============================================================ navigation
// Tabs at the bottom; inside a tab pages stack up and the back button / Android back gesture pops them.
const TABS = [['home', 'home', 'Главная'], ['all', 'library', 'Треки'], ['playlists', 'playlist', 'Плейлисты'], ['eq', 'eq', 'Эквалайзер'], ['settings', 'settings', 'Настройки']];
const state = { tab: 'home', stack: [{ name: 'home' }] };
const view = () => state.stack[state.stack.length - 1];

function go(name, arg) {
  state.stack.push({ name, arg });
  history.pushState({ depth: state.stack.length }, '');
  render(); $('#view').scrollTop = 0;
}
function goTab(tab) {
  state.tab = tab;
  state.stack = [{ name: tab }];
  render(); $('#view').scrollTop = 0;
}
function back() {
  if (sheetOpen()) return closeSheet();
  if ($('#modal').classList.contains('hidden') === false) return closeModal();
  if (fullOpen()) return closeFull(true);
  if (state.stack.length > 1) { state.stack.pop(); render(); return; }
  if (state.tab !== 'home') goTab('home');
}
// Closing the big player by its own button rewinds the history entry it added; that pop is not a "back".
let skipPop = false;
window.addEventListener('popstate', () => { if (skipPop) { skipPop = false; return; } back(); });
$('#backBtn').onclick = () => history.back();

function openCtx(ctx) {
  if (ctx === 'all') return goTab('all');
  go('list', ctx);
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([id, ic, label]) => `<button data-tab="${id}" class="${state.tab === id ? 'on' : ''}">${icon(ic)}<span>${label}</span></button>`).join('');
}

function render() {
  renderTabs();
  const v = view();
  const fn = VIEWS[v.name] || VIEWS.home;
  $('#backBtn').classList.toggle('hidden', state.stack.length < 2);
  $('#topActions').innerHTML = '';
  fn($('#view'), v.arg);
  markPlaying();
}
function setTop(title, actions = '') {
  $('#topTitle').textContent = title;
  $('#topActions').innerHTML = actions;
}

// ============================================================ track list
function trackRow(t, i, ctx) {
  const liked = isLiked(t);
  return `<div class="tr" data-ctx="${esc(ctx)}" data-i="${i}">
    ${coverHtml(t)}
    <div class="tx"><div class="tt">${esc(t.title)}</div><div class="st">${esc(t.artist || 'Неизвестный исполнитель')}${t.duration ? ' · ' + fmt(t.duration) : ''}</div></div>
    <button class="icon-btn likebtn ${liked ? 'on' : ''}" data-act="like" aria-label="Любимое">${icon(liked ? 'heartFill' : 'heart')}</button>
    <button class="icon-btn" data-act="more" aria-label="Ещё">${icon('more')}</button>
  </div>`;
}
const PAGE = 200;
function trackList(tracks, ctx, limit = PAGE) {
  lists[ctx] = tracks;
  const more = tracks.length > limit ? `<button class="btn ghost small more-btn" data-more="${esc(ctx)}" data-limit="${limit}">Показать ещё ${tracks.length - limit}</button>` : '';
  return `<div class="tl">${tracks.slice(0, limit).map((t, i) => trackRow(t, i, ctx)).join('')}</div>${more}`;
}
function markPlaying() {
  const cur = player.current;
  $$('.tr').forEach((r) => {
    const t = (lists[r.dataset.ctx] || [])[+r.dataset.i];
    r.classList.toggle('playing', !!(cur && t && t.id === cur.id));
  });
  $$('[data-playctx]').forEach((b) => { b.innerHTML = icon(queue.ctx === b.dataset.playctx && player.playing ? 'pause' : 'play'); });
}
function refreshLikes() {
  $$('.tr').forEach((r) => {
    const t = (lists[r.dataset.ctx] || [])[+r.dataset.i];
    const b = r.querySelector('.likebtn');
    if (!t || !b) return;
    b.classList.toggle('on', isLiked(t));
    b.innerHTML = icon(isLiked(t) ? 'heartFill' : 'heart');
  });
  updateNowPlaying();
  if (view().name === 'list' && view().arg === 'liked') render();
  if (view().name === 'search') renderSearchResults();
}

function playCtx(ctx, startIndex = -1, shuffleStart = false) {
  const tracks = listFromCtx(ctx);
  if (!tracks.length) return toast('Здесь пока нет треков');
  if (queue.ctx === ctx && player.current && startIndex === -1 && !shuffleStart) return player.toggle();
  if (shuffleStart && !lib.settings.shuffle) { lib.settings.shuffle = true; save(); updateModeButtons(); }
  const start = startIndex === -1 ? (lib.settings.shuffle ? Math.floor(Math.random() * tracks.length) : 0) : startIndex;
  queue.set(tracks, start, ctx);
  player.playIndex();
}
function playFromRow(ctx, i) {
  const track = lists[ctx][i];
  if (ctx === 'queue:manual') { queue.manual.splice(i, 1); return player.load(track); }
  if (ctx === 'queue:next') { queue.pos += i + 1; return player.playIndex(); }
  if (player.current && player.current.id === track.id) return openFull();
  const base = ctx === 'home:new' ? 'all' : ctx.replace(/#f$/, '');
  if (base === 'search') { queue.set(lists.search, i, 'search'); return player.playIndex(); }
  const full = listFromCtx(base);
  const idx = Math.max(0, full.findIndex((x) => x.id === track.id));
  queue.set(full, idx, base);
  player.playIndex();
}

// ============================================================ views
const VIEWS = {};

function emptyHtml() {
  return `<div class="empty">${icon('note')}<h3>Добавь свою музыку</h3>
    <p>Скинь mp3, m4a или flac на телефон (из Telegram, с компьютера, из «Файлов») и выбери их здесь. Музыка сохранится внутри Melodia и будет играть без интернета.</p>
    <button class="btn green" data-act="import">${icon('upload')}Добавить музыку</button></div>`;
}

VIEWS.home = (el) => {
  const h = new Date().getHours();
  setTop(h < 5 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер', `<button class="icon-btn" data-act="search" aria-label="Поиск">${icon('search')}</button><button class="icon-btn" data-act="import" aria-label="Добавить музыку">${icon('upload')}</button>`);
  if (!allTracks.length) { el.innerHTML = `<div class="page">${emptyHtml()}</div>`; return; }
  const quick = ['all', 'liked', ...lib.playlists.map((p) => 'pl:' + p.id)].slice(0, 6);
  let html = `<div class="page"><div class="quick">${quick.map((c) => `<div class="quick-item" data-open="${esc(c)}">${listCover(c)}<div class="tt">${esc(ctxTitle(c))}</div></div>`).join('')}</div>`;
  const recent = resolveIds(lib.recent);
  if (recent.length) {
    lists.recent = recent;
    html += `<h2 class="sec">Недавно прослушанные <small data-open="recent">Все</small></h2><div class="cards">${recent.slice(0, 12).map((t, i) => card(t, i, 'recent')).join('')}</div>`;
  }
  const recentCtx = lib.recentLists.filter((c) => ctxExists(c) && c !== 'recent').slice(0, 8);
  if (recentCtx.length) {
    html += `<h2 class="sec">Недавние плейлисты</h2><div class="cards">${recentCtx.map((c) => `<div class="tcard" data-open="${esc(c)}">${listCover(c)}<div class="tt">${esc(ctxTitle(c))}</div><div class="st">${tracksWord(listFromCtx(c).length)}</div></div>`).join('')}</div>`;
  }
  const fresh = sorted(allTracks).slice(0, 12);
  lists['home:new'] = lib.settings.sort === 'added' ? fresh : allTracks.slice(0, 12);
  html += `<h2 class="sec">Недавно добавленные <small data-tab="all">Все</small></h2><div class="cards">${lists['home:new'].map((t, i) => card(t, i, 'home:new')).join('')}</div>`;
  el.innerHTML = html + '</div>';
};
const card = (t, i, ctx) => `<div class="tcard" data-ctx="${ctx}" data-i="${i}" data-act="playcard">${coverHtml(t)}<div class="tt">${esc(t.title)}</div><div class="st">${esc(t.artist)}</div></div>`;

// One page layout for every list: all tracks, liked, recent and playlists.
function listPage(el, ctx) {
  const tracks = listFromCtx(ctx);
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const name = ctxTitle(ctx);
  const own = ctx.startsWith('pl:');
  const v = view();
  const filter = v.filter || '';
  const shown = filter ? tracks.filter(matcher(filter)) : tracks;
  setTop(ctx === 'all' ? 'Треки' : '', ctx === 'all' ? `<button class="icon-btn" data-act="search" aria-label="Поиск">${icon('search')}</button><button class="icon-btn" data-act="import" aria-label="Добавить музыку">${icon('upload')}</button>` : own ? `<button class="icon-btn" data-act="plmenu" aria-label="Ещё">${icon('more')}</button>` : '');
  el.innerHTML = `<div class="page">
    <div class="hero">${listCover(ctx, 'big')}
      <div class="hero-tx"><h1 ${own ? 'data-act="rename"' : ''}>${esc(name)}</h1><div class="st">${tracksWord(tracks.length)}${total ? ' · ' + fmtLong(total) : ''}</div></div>
    </div>
    <div class="actions">
      <button class="fab" data-playctx="${esc(ctx)}" aria-label="Слушать">${icon('play')}</button>
      <button class="icon-btn ${lib.settings.shuffle ? 'on' : ''}" data-act="shuffleplay" aria-label="Перемешать">${icon('shuffle')}</button>
      ${own ? `<button class="btn ghost small" data-act="importpl">${icon('upload')}Добавить файлы</button>` : ''}
      ${ctx === 'recent' && tracks.length ? `<button class="btn ghost small" data-act="clearrecent">Очистить</button>` : ''}
    </div>
    ${tracks.length ? `<label class="filter">${icon('search')}<input id="plFilter" placeholder="Искать в списке" value="${esc(filter)}" enterkeyhint="search"></label>` : ''}
    ${ctx === 'all' && tracks.length ? `<div class="chips">${[['added', 'Новые'], ['title', 'Название'], ['artist', 'Исполнитель']].map(([k, n]) => `<button class="chip ${lib.settings.sort === k ? 'on' : ''}" data-sort="${k}">${n}</button>`).join('')}</div>` : ''}
    ${tracks.length ? trackList(shown, filter ? ctx + '#f' : ctx)
      : ctx === 'all' ? emptyHtml()
      : `<div class="empty">${icon('note')}<h3>${ctx === 'liked' ? 'Нажми ♥ у любого трека' : 'Здесь пока пусто'}</h3><p>${ctx === 'liked' ? 'Любимые треки появятся здесь.' : own ? 'Нажми ⋯ у трека → «Добавить в плейлист» или «Добавить файлы» выше.' : 'Здесь появятся треки, которые ты слушал.'}</p></div>`}
  </div>`;
  const inp = $('#plFilter');
  if (inp) inp.oninput = () => { v.filter = inp.value; const pos = inp.selectionStart; render(); const n = $('#plFilter'); n.focus(); n.setSelectionRange(pos, pos); };
}
VIEWS.all = (el) => listPage(el, 'all');

// ------------------------------------------------------------ search in the library
// Every word of the query has to appear in the title, artist or album; «ё» counts as «е».
const norm = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е');
function matcher(q) {
  const words = norm(q).split(/\s+/).filter(Boolean);
  return (t) => { const hay = norm(`${t.title} ${t.artist} ${t.album} ${t.name || ''}`); return words.every((w) => hay.includes(w)); };
}
let searchQuery = '';
VIEWS.search = (el) => {
  setTop('Поиск');
  el.innerHTML = `<div class="page">
    <label class="filter search-field">${icon('search')}<input id="searchInput" type="search" placeholder="Трек, исполнитель или альбом" value="${esc(searchQuery)}" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false">
      <button class="icon-btn ${searchQuery ? '' : 'hidden'}" id="searchClear" aria-label="Очистить">${icon('close')}</button></label>
    <div id="searchResults"></div></div>`;
  const inp = $('#searchInput');
  inp.oninput = () => { searchQuery = inp.value; $('#searchClear').classList.toggle('hidden', !searchQuery); renderSearchResults(); };
  inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
  $('#searchClear').onclick = (e) => { e.preventDefault(); searchQuery = ''; inp.value = ''; $('#searchClear').classList.add('hidden'); renderSearchResults(); inp.focus(); };
  renderSearchResults();
  if (!searchQuery) setTimeout(() => inp.focus(), 50);
};
// Only the results are redrawn while typing, so the keyboard stays open.
function renderSearchResults() {
  const box = $('#searchResults');
  if (!box) return;
  const q = searchQuery.trim();
  if (!allTracks.length) { box.innerHTML = emptyHtml(); return; }
  if (!q) { box.innerHTML = `<div class="empty">${icon('search')}<h3>Поиск по твоей музыке</h3><p>Ищет среди ${tracksWord(allTracks.length)}: по названию, исполнителю и альбому. Можно писать несколько слов, например «сплин романс».</p></div>`; return; }
  const found = sorted(allTracks).filter(matcher(q));
  const pls = lib.playlists.filter((p) => norm(p.name).includes(norm(q)));
  let html = '';
  if (pls.length) html += `<h2 class="sec">Плейлисты</h2><div class="lib-list">${pls.map((p) => `<div class="lib-item" data-open="pl:${p.id}">${listCover('pl:' + p.id)}<div class="meta"><div class="tt">${esc(p.name)}</div><div class="st">Плейлист · ${tracksWord(resolveIds(p.ids).length)}</div></div></div>`).join('')}</div>`;
  if (found.length) html += `<h2 class="sec">Треки <small>${tracksWord(found.length)}</small></h2>${trackList(found, 'search')}`;
  if (!html) html = `<div class="empty">${icon('search')}<h3>Ничего не нашлось</h3><p>По запросу «${esc(q)}» в твоей музыке ничего нет. Попробуй написать короче или иначе.</p></div>`;
  box.innerHTML = html;
  markPlaying();
}
VIEWS.list = (el, ctx) => (ctxExists(ctx) ? listPage(el, ctx) : VIEWS.home(el));

VIEWS.playlists = (el) => {
  setTop('Плейлисты', `<button class="icon-btn" data-act="search" aria-label="Поиск">${icon('search')}</button><button class="icon-btn" data-act="newpl" aria-label="Новый плейлист">${icon('add')}</button>`);
  const items = ['liked', ...lib.playlists.map((p) => 'pl:' + p.id)];
  el.innerHTML = `<div class="page"><div class="lib-list">
    <button class="lib-item new" data-act="newpl"><div class="cv">${icon('add')}</div><div class="meta"><div class="tt">Новый плейлист</div></div></button>
    ${items.map((c) => `<div class="lib-item" data-open="${esc(c)}">${listCover(c)}<div class="meta"><div class="tt">${esc(ctxTitle(c))}</div><div class="st">Плейлист · ${tracksWord(listFromCtx(c).length)}</div></div></div>`).join('')}
    ${lib.recent.length ? `<div class="lib-item" data-open="recent">${listCover('recent')}<div class="meta"><div class="tt">Недавно прослушанные</div><div class="st">${tracksWord(resolveIds(lib.recent).length)}</div></div></div>` : ''}
  </div></div>`;
};

// ------------------------------------------------------------ equalizer
VIEWS.eq = (el) => {
  setTop('Эквалайзер');
  const cfg = lib.settings.eq;
  const presets = { ...EQ_PRESETS, ...lib.settings.eqCustom };
  const hz = (f) => (f >= 1000 ? f / 1000 + 'k' : f);
  el.innerHTML = `<div class="page">
    <div class="panel eq-wrap ${cfg.enabled ? '' : 'off'}">
      <div class="eq-top"><h3>${esc(cfg.enabled ? cfg.preset || 'Свой' : 'Выключен')}</h3><div class="switch ${cfg.enabled ? 'on' : ''}" data-act="eqtoggle"></div></div>
      <canvas id="eqCurve"></canvas>
      <div class="eq-bands">
        <div class="eq-band"><div class="db" id="db-pre">${fmtDb(cfg.preamp)}</div><div class="vslider" data-band="pre"><div class="track"></div><div class="zero"></div><div class="fill"></div><div class="knob"></div></div><div class="hz">Усил.</div></div>
        ${EQ_FREQS.map((f, i) => `<div class="eq-band"><div class="db" id="db-${i}">${fmtDb(cfg.gains[i])}</div><div class="vslider" data-band="${i}"><div class="track"></div><div class="zero"></div><div class="fill"></div><div class="knob"></div></div><div class="hz">${hz(f)}</div></div>`).join('')}
      </div>
    </div>
    <h2 class="sec">Пресеты</h2>
    <div class="chips wrap">${Object.keys(presets).map((n) => `<button class="chip ${cfg.enabled && cfg.preset === n ? 'on' : ''}" data-preset="${esc(n)}">${esc(n)}${lib.settings.eqCustom[n] ? ` <span class="cnt" data-delpreset="${esc(n)}">✕</span>` : ''}</button>`).join('')}</div>
    <div class="row"><button class="btn ghost small" data-act="eqsave">Сохранить как пресет</button><button class="btn ghost small" data-act="eqreset">Сбросить</button></div>
    <p class="hint">На iPhone при включённом эквалайзере музыка может останавливаться, когда экран гаснет, — это ограничение iOS. Если так происходит, выключи эквалайзер.</p>
  </div>`;
  $$('.vslider', el).forEach(initVSlider);
  drawEqCurve();
};
const fmtDb = (v) => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10);
function setVSlider(s, v) {
  const pct = (12 - v) / 24 * 100;
  s.querySelector('.knob').style.top = pct + '%';
  const f = s.querySelector('.fill');
  f.style.top = Math.min(pct, 50) + '%';
  f.style.height = Math.abs(pct - 50) + '%';
}
function initVSlider(s) {
  const band = s.dataset.band;
  const cfg = lib.settings.eq;
  const get = () => (band === 'pre' ? cfg.preamp : cfg.gains[+band]);
  setVSlider(s, get());
  const setFrom = (e) => {
    const r = s.getBoundingClientRect();
    let v = 12 - ((e.clientY - r.top) / r.height) * 24;
    v = Math.max(-12, Math.min(12, Math.round(v * 2) / 2));
    if (band === 'pre') cfg.preamp = v; else cfg.gains[+band] = v;
    if (!cfg.enabled) enableEq();
    if (cfg.preset) { cfg.preset = ''; const h = $('.eq-top h3'); if (h) h.textContent = 'Свой'; $$('.chip[data-preset]').forEach((c) => c.classList.remove('on')); }
    setVSlider(s, v);
    $('#db-' + band).textContent = fmtDb(v);
    eq.apply(cfg); drawEqCurve(); save();
  };
  s.addEventListener('pointerdown', (e) => { e.preventDefault(); s.setPointerCapture(e.pointerId); setFrom(e); s.onpointermove = setFrom; });
  s.addEventListener('pointerup', () => { s.onpointermove = null; });
}
function drawEqCurve() {
  const c = $('#eqCurve'); if (!c) return;
  const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const x = c.getContext('2d'); x.scale(dpr, dpr);
  const N = 120, fmin = 20, fmax = 20000;
  const freqs = new Float32Array(N).map((_, i) => fmin * Math.pow(fmax / fmin, i / (N - 1)));
  const resp = eq.response(freqs, lib.settings.eq);
  const yOf = (db) => h / 2 - (db / 18) * (h / 2 - 6);
  x.strokeStyle = 'rgba(255,255,255,.08)'; x.lineWidth = 1;
  for (const db of [-12, 0, 12]) { x.beginPath(); x.moveTo(0, yOf(db)); x.lineTo(w, yOf(db)); x.stroke(); }
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#a6ecce';
  x.beginPath();
  resp.forEach((db, i) => { const px = (i / (N - 1)) * w, py = yOf(Math.max(-18, Math.min(18, db))); i ? x.lineTo(px, py) : x.moveTo(px, py); });
  x.strokeStyle = accent; x.lineWidth = 2.5; x.stroke();
}
// The Web Audio graph is only built once the equalizer is switched on: on iPhone it can stop
// background playback, so without EQ the music goes straight to the speaker.
function enableEq() {
  lib.settings.eq.enabled = true;
  eq.init(); eq.resume(); eq.apply(lib.settings.eq);
}

// ------------------------------------------------------------ settings
VIEWS.settings = (el) => {
  setTop('Настройки');
  const th = lib.settings.theme;
  const total = allTracks.reduce((a, t) => a + (t.size || 0), 0);
  el.innerHTML = `<div class="page">
    <div class="panel"><h3>Оформление</h3>
      <div class="swatches">
        ${THEMES.map(([id, name, hue, sat]) => `<button class="swatch ${th.id === id ? 'on' : ''}" data-theme="${id}"><span class="dot" style="${themeSwatch(hue, sat)}"></span>${name}</button>`).join('')}
        <label class="swatch ${th.id === 'custom' ? 'on' : ''}"><span class="dot ${th.id === 'custom' ? '' : 'custom'}" style="${th.id === 'custom' ? themeSwatch(th.hue, th.sat) : ''}"><input type="color" id="themeColor" value="${esc(th.color || '#3a7d6a')}"></span>Свой</label>
      </div>
      <div class="setting" data-act="ambienttoggle"><div class="sd"><b>Фон из обложки трека</b><span>Цвета обложки мягко проступают на фоне</span></div><div class="switch ${th.ambient ? 'on' : ''}"></div></div>
    </div>
    <div class="panel"><h3>Музыка</h3>
      <div class="setting"><div class="sd"><b>${tracksWord(allTracks.length)}</b><span>Занимают ${fmtSize(total)} в памяти телефона</span></div><button class="btn small" data-act="import">${icon('upload')}Добавить</button></div>
      <div class="setting" id="storageRow"><div class="sd"><b>Хранилище</b><span>Проверяю…</span></div></div>
      ${allTracks.length ? `<div class="setting"><div class="sd"><b>Удалить всю музыку</b><span>Плейлисты останутся пустыми</span></div><button class="btn ghost small danger" data-act="wipe">Удалить</button></div>` : ''}
    </div>
    ${native ? '' : `<div class="panel"><h3>Как установить на телефон</h3>
      <p class="hint"><b>iPhone:</b> открой эту страницу в Safari → кнопка «Поделиться» → «На экран Домой».<br><b>Android:</b> в Chrome меню ⋮ → «Установить приложение» (или «Добавить на гл. экран»).<br>После этого Melodia открывается с иконки и работает без интернета.</p>
    </div>`}
    <p class="hint center">Melodia · вся музыка и плейлисты хранятся только на этом телефоне</p>
  </div>`;
  if (navigator.storage && navigator.storage.estimate) {
    Promise.all([navigator.storage.estimate(), navigator.storage.persisted ? navigator.storage.persisted() : false]).then(([est, kept]) => {
      const row = $('#storageRow span');
      if (row) row.textContent = `Свободно примерно ${fmtSize(Math.max(0, (est.quota || 0) - (est.usage || 0)))}${kept ? ' · музыка защищена от автоочистки' : ''}`;
    }).catch(() => {});
  }
};

// ============================================================ queue & player
const queue = {
  tracks: [], order: [], pos: 0, ctx: null, manual: [],
  set(tracks, start, ctx) {
    this.tracks = tracks.slice();
    this.ctx = ctx;
    this.order = this.tracks.map((_, i) => i);
    if (lib.settings.shuffle) this.shuffle(start); else this.pos = start;
  },
  shuffle(keep) {
    const rest = this.order.filter((i) => i !== keep);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    this.order = keep == null ? rest : [keep, ...rest];
    this.pos = 0;
  },
  unshuffle() { const cur = this.order[this.pos]; this.order = this.tracks.map((_, i) => i); this.pos = cur == null ? 0 : cur; },
  current() { return this.tracks[this.order[this.pos]]; },
  upcoming(n) { const out = []; for (let k = this.pos + 1; k < this.order.length && out.length < n; k++) out.push(this.tracks[this.order[k]]); return out; },
};

const audio = new Audio();
audio.preload = 'auto';
audio.setAttribute('playsinline', '');
const eq = new Equalizer(audio);
let audioUrl = null;

const player = {
  current: null, playing: false, loading: false, token: 0, errors: 0,
  async load(track) {
    const token = ++this.token;
    this.current = track;
    this.loading = true;
    updateNowPlaying(); markPlaying();
    try {
      if (lib.settings.eq.enabled) { eq.init(); eq.resume(); }
      const blob = await db.get('audio', track.id);
      if (token !== this.token) return;
      if (!blob) throw new Error('файл не найден в памяти');
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob);
      audio.src = audioUrl;
      await audio.play();
      this.errors = 0;
      pushRecent(track);
    } catch (e) {
      if (token !== this.token || e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') { this.loading = false; updatePlayButton(); return; } // autoplay blocked: wait for a tap
      this.loading = false; updatePlayButton();
      toast(`«${track.title}» не играет: ${e.message || 'формат не поддерживается'}`, 'err');
      if (++this.errors < 5) setTimeout(() => { if (this.current === track) this.next(true); }, 1200);
    } finally {
      if (token === this.token) { this.loading = false; updatePlayButton(); }
    }
  },
  playIndex() { const t = queue.current(); if (t) this.load(t); },
  toggle() {
    if (!this.current) { const ctx = lib.recentLists.find(ctxExists) || 'all'; return playCtx(ctx); }
    if (!audio.getAttribute('src') && !this.loading) return this.load(this.current);
    eq.resume();
    if (audio.paused) audio.play().catch(() => {}); else audio.pause();
  },
  next(auto = false) {
    if (queue.manual.length) return this.load(queue.manual.shift());
    if (auto && lib.settings.repeat === 'one') { audio.currentTime = 0; return audio.play(); }
    if (queue.pos + 1 < queue.order.length) queue.pos++;
    else if (lib.settings.repeat === 'all' || !auto) { if (!queue.order.length) return; queue.pos = 0; if (lib.settings.shuffle) queue.shuffle(); }
    else { audio.pause(); return; }
    this.playIndex();
  },
  prev() {
    if (audio.currentTime > 3 || queue.pos === 0) { audio.currentTime = 0; return; }
    queue.pos--; this.playIndex();
  },
  // Stops the music and hides the mini player until something is played again.
  close() {
    this.token++;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
    Object.assign(this, { current: null, playing: false, loading: false });
    queue.manual = [];
    closeFull();
    if ('mediaSession' in navigator) { navigator.mediaSession.metadata = null; navigator.mediaSession.playbackState = 'none'; }
    updatePlayButton(); updateNowPlaying(); markPlaying(); syncNative();
  },
};

audio.addEventListener('play', () => { player.playing = true; updatePlayButton(); markPlaying(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { player.playing = false; updatePlayButton(); markPlaying(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('ended', () => player.next(true));
audio.addEventListener('waiting', () => { player.loading = true; updatePlayButton(); });
audio.addEventListener('playing', () => { player.loading = false; updatePlayButton(); });
audio.addEventListener('loadedmetadata', () => {
  const t = player.current;
  if (t && !t.duration && isFinite(audio.duration)) { t.duration = Math.round(audio.duration); db.put('tracks', t.id, t).catch(() => {}); }
});

// ------------------------------------------------------------ player UI
function updatePlayButton() {
  const ic = icon(player.playing ? 'pause' : 'play');
  $('#playBtn').innerHTML = ic;
  $('#miniPlay').innerHTML = ic;
  $('#playBtn').classList.toggle('loading', player.loading && !!player.current);
}
function updateNowPlaying() {
  const t = player.current;
  document.body.classList.toggle('has-player', !!t);
  $('#mini').classList.toggle('hidden', !t);
  if (!t) { $('#ambient').classList.remove('on'); document.title = 'Melodia'; return; }
  const c = coverOf(t);
  const artist = (t.artist || '').trim() || 'Неизвестный исполнитель';
  $('#miniTitle').textContent = t.title;
  $('#miniArtist').textContent = artist;
  $('#fullTitle').textContent = t.title;
  $('#fullArtist').textContent = artist;
  $('#fullFrom').textContent = queue.ctx && ctxTitle(queue.ctx) ? ctxTitle(queue.ctx) : 'Сейчас играет';
  for (const el of [$('#miniCover'), $('#fullCover')]) { el.style.backgroundImage = c ? `url('${c}')` : ''; el.innerHTML = c ? '' : icon('note'); }
  $('#fullBg').style.backgroundImage = c ? `url('${c}')` : '';
  const amb = $('#ambient');
  if (c) { amb.style.backgroundImage = `url('${c}')`; amb.classList.add('on'); } else amb.classList.remove('on');
  const liked = isLiked(t);
  for (const b of [$('#miniLike'), $('#fullLike')]) { b.classList.toggle('on', liked); b.innerHTML = icon(liked ? 'heartFill' : 'heart'); }
  document.title = `${t.title} · ${artist}`;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist, album: t.album || '', artwork: c ? [{ src: c, sizes: '512x512' }] : [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }] });
  }
  if (fullOpen()) renderNext();
  syncNative();
}
function updateModeButtons() {
  const s = lib.settings;
  $('#shuffleBtn').classList.toggle('on', s.shuffle);
  $('#repeatBtn').classList.toggle('on', s.repeat !== 'off');
  $('#repeatBtn').innerHTML = icon(s.repeat === 'one' ? 'repeatOne' : 'repeat');
}

let seeking = null;
function makeSlider(el, onChange, onEnd) {
  const pick = (e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); el.classList.add('drag'); onChange(pick(e)); el.onpointermove = (ev) => onChange(pick(ev)); });
  el.addEventListener('pointerup', (e) => { el.classList.remove('drag'); el.onpointermove = null; if (onEnd) onEnd(pick(e)); });
  el.addEventListener('pointercancel', () => { el.classList.remove('drag'); el.onpointermove = null; seeking = null; });
}
makeSlider($('#seek'), (p) => { seeking = p; drawProgress(); }, (p) => { if (isFinite(audio.duration)) audio.currentTime = p * audio.duration; seeking = null; });
function drawProgress() {
  const d = isFinite(audio.duration) ? audio.duration : (player.current && player.current.duration) || 0;
  const p = seeking != null ? seeking : d ? audio.currentTime / d : 0;
  $('#seek .fill').style.width = p * 100 + '%';
  $('#seek .knob').style.left = p * 100 + '%';
  $('.mini-progress .fill').style.width = p * 100 + '%';
  $('#curTime').textContent = fmt(seeking != null ? seeking * d : audio.currentTime);
  $('#durTime').textContent = '-' + fmt(Math.max(0, d - (seeking != null ? seeking * d : audio.currentTime)));
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d && isFinite(audio.currentTime)) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(d, audio.currentTime), playbackRate: 1 }); } catch { /* not supported */ }
  }
}
audio.addEventListener('timeupdate', drawProgress);
audio.addEventListener('durationchange', drawProgress);

// ------------------------------------------------------------ full-screen player
const fullOpen = () => $('#full').classList.contains('open');
function openFull() {
  if (!player.current || fullOpen()) return;
  $('#full').classList.add('open');
  document.body.classList.add('full-open');
  $('#full').setAttribute('aria-hidden', 'false');
  history.pushState({ full: true }, '');
  renderNext(); drawProgress();
}
function closeFull(fromHistory) {
  if (!fullOpen()) return;
  $('#full').classList.remove('open');
  document.body.classList.remove('full-open');
  $('#full').setAttribute('aria-hidden', 'true');
  if (!fromHistory && history.state && history.state.full) { skipPop = true; history.back(); }
}
function renderNext() {
  const nextUp = queue.upcoming(Math.max(0, 25 - queue.manual.length));
  $('#fullNext').innerHTML = queue.manual.length || nextUp.length
    ? `<h2 class="sec">Далее</h2>${queue.manual.length ? trackList(queue.manual, 'queue:manual') : ''}${nextUp.length ? trackList(nextUp, 'queue:next') : ''}` : '';
  markPlaying();
}
// Swipe the big player down to close it.
(() => {
  let y0 = null, dy = 0;
  const panel = $('#full');
  panel.addEventListener('touchstart', (e) => { if ($('#full .full-inner').scrollTop > 0 || e.target.closest('.slider')) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  panel.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = `translateY(${dy}px)`; }, { passive: true });
  panel.addEventListener('touchend', () => { if (y0 == null) return; panel.style.transform = ''; if (dy > 110) closeFull(); y0 = null; });
})();

$('#playBtn').onclick = () => player.toggle();
$('#nextBtn').onclick = () => player.next();
$('#prevBtn').onclick = () => player.prev();
$('#miniPlay').onclick = (e) => { e.stopPropagation(); player.toggle(); };
$('#miniNext').onclick = (e) => { e.stopPropagation(); player.next(); };
$('#miniLike').onclick = (e) => { e.stopPropagation(); toggleLike(player.current); };
$('#miniClose').onclick = (e) => { e.stopPropagation(); player.close(); };
$('#fullLike').onclick = () => toggleLike(player.current);
$('#mini').onclick = () => openFull();
$('#fullDown').onclick = () => closeFull();
$('#fullMore').onclick = () => {
  const t = player.current; if (!t) return;
  trackMenu(t, 'queue:now', [['close', 'close', 'Закрыть плеер']]);
};
$('#shuffleBtn').onclick = () => {
  lib.settings.shuffle = !lib.settings.shuffle;
  if (lib.settings.shuffle) queue.shuffle(queue.order[queue.pos]); else queue.unshuffle();
  updateModeButtons(); save(); renderNext();
};
$('#repeatBtn').onclick = () => { const s = lib.settings; s.repeat = { off: 'all', all: 'one', one: 'off' }[s.repeat]; updateModeButtons(); save(); toast({ off: 'Повтор выключен', all: 'Повторять всё', one: 'Повторять трек' }[s.repeat]); };

if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, fn) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported action */ } };
  set('play', () => player.toggle());
  set('pause', () => player.toggle());
  set('nexttrack', () => player.next());
  set('previoustrack', () => player.prev());
  set('seekto', (d) => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
  set('seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
  set('seekforward', (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
}

// ------------------------------------------------------------ Android app bridge
// Inside the Android app (android-app/) the system media notification, lock screen and headset
// buttons are driven from here; in a browser (iPhone) window.MelodiaAndroid doesn't exist.
const native = window.MelodiaAndroid || null;
const nativeCovers = new Map(); // cover key -> small JPEG data URL for the notification
let nativeCoverKey = null, nativeActive = false;
function smallCover(t) {
  const key = t && t.cover;
  if (!key || !coverOf(t)) return Promise.resolve('');
  if (nativeCovers.has(key)) return Promise.resolve(nativeCovers.get(key));
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 320;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 320, 320);
      const url = c.toDataURL('image/jpeg', 0.85);
      nativeCovers.set(key, url); res(url);
    };
    img.onerror = () => res('');
    img.src = coverOf(t);
  });
}
async function syncNative() {
  if (!native) return;
  const t = player.current;
  // The notification appears once something has really been played, not for the restored last track.
  if (!t || !audio.getAttribute('src')) { if (nativeActive && !t) { nativeActive = false; nativeCoverKey = null; native.stop(); } return; }
  const cover = await smallCover(t);
  if (player.current !== t) return;
  const key = t.cover || '';
  native.update(JSON.stringify({
    title: t.title, artist: (t.artist || '').trim() || 'Неизвестный исполнитель', playing: player.playing,
    position: audio.currentTime || 0, duration: isFinite(audio.duration) ? audio.duration : t.duration || 0,
    coverKey: key, cover: key === nativeCoverKey ? '' : cover,
  }));
  nativeActive = true; nativeCoverKey = key;
}
if (native) {
  ['play', 'pause', 'seeked', 'durationchange'].forEach((ev) => audio.addEventListener(ev, syncNative));
  window.melodiaCommand = (cmd) => {
    if (cmd === 'toggle') player.toggle();
    else if (cmd === 'play') { if (audio.paused) player.toggle(); }
    else if (cmd === 'pause') { if (!audio.paused) audio.pause(); }
    else if (cmd === 'next') player.next();
    else if (cmd === 'prev') player.prev();
    else if (cmd.startsWith('seek:')) { audio.currentTime = +cmd.slice(5) || 0; }
  };
  // Android back button: true when the app handled it, false to send the app to the background.
  window.melodiaBack = () => {
    if (sheetOpen()) { closeSheet(); return true; }
    if (!$('#modal').classList.contains('hidden')) { closeModal(); return true; }
    if (fullOpen()) { closeFull(true); return true; }
    if (state.stack.length > 1) { state.stack.pop(); render(); return true; }
    if (state.tab !== 'home') { goTab('home'); return true; }
    return false;
  };
}

// ============================================================ sheets & dialogs
const sheetOpen = () => !$('#sheet').classList.contains('hidden');
function openSheet(html, bind) {
  $('#sheetPanel').innerHTML = `<div class="grabber"></div>${html}`;
  $('#sheet').classList.remove('hidden');
  requestAnimationFrame(() => $('#sheet').classList.add('show'));
  $('#sheetPanel').onclick = (e) => { const b = e.target.closest('button[data-m]'); if (!b) return; closeSheet(); bind(b.dataset.m, b.dataset.v); };
}
function closeSheet() { $('#sheet').classList.remove('show'); setTimeout(() => $('#sheet').classList.add('hidden'), 180); }
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });

function trackMenu(t, ctx, extra = []) {
  const base = ctx.replace(/#f$/, '');
  const pl = base.startsWith('pl:') ? getPlaylist(base.slice(3)) : null;
  const liked = isLiked(t);
  openSheet(`<div class="sheet-head">${coverHtml(t)}<div class="tx"><div class="tt">${esc(t.title)}</div><div class="st">${esc(t.artist || 'Неизвестный исполнитель')}</div></div></div>
    <button data-m="playnext">${icon('playNext')}Играть следующим</button>
    <button data-m="enqueue">${icon('queue')}Добавить в очередь</button>
    <button data-m="like">${icon(liked ? 'heartFill' : 'heart')}${liked ? 'Удалить из любимых' : 'Добавить в любимые'}</button>
    <button data-m="addpl">${icon('playlist')}Добавить в плейлист</button>
    ${pl ? `<button data-m="remove">${icon('close')}Убрать из плейлиста</button>` : ''}
    ${base === 'recent' ? `<button data-m="unrecent">${icon('close')}Удалить из истории</button>` : ''}
    ${extra.map(([m, ic, label]) => `<button data-m="${m}">${icon(ic)}${label}</button>`).join('')}
    <button data-m="delete" class="danger">${icon('trash')}Удалить с телефона</button>`, async (m) => {
    if (m === 'playnext') { queue.manual.unshift(t); toast('Сыграет следующим'); if (!player.current) player.next(); renderNext(); }
    else if (m === 'enqueue') { queue.manual.push(t); toast('Добавлено в очередь'); if (!player.current) player.next(); renderNext(); }
    else if (m === 'like') toggleLike(t);
    else if (m === 'addpl') playlistPicker([t]);
    else if (m === 'remove' && pl) { pl.ids = pl.ids.filter((id) => id !== t.id); save(); render(); toast('Убрано из плейлиста'); }
    else if (m === 'unrecent') { lib.recent = lib.recent.filter((id) => id !== t.id); save(); render(); }
    else if (m === 'close') player.close();
    else if (m === 'delete') {
      if (!await confirm2('Удалить трек?', `«${t.title}» пропадёт из Melodia и всех плейлистов.`)) return;
      await deleteTracks([t]); render(); toast('Трек удалён');
    }
  });
}
function playlistPicker(tracks) {
  setTimeout(() => openSheet(`<div class="sheet-title">Добавить в плейлист</div>
    <button data-m="new">${icon('add')}Новый плейлист</button>
    ${lib.playlists.map((p) => `<button data-m="add" data-v="${p.id}">${icon('note')}${esc(p.name)}</button>`).join('')}`, async (m, v) => {
    if (m === 'add') { addToPlaylist(getPlaylist(v), tracks); render(); }
    if (m === 'new') { const n = await prompt2('Новый плейлист', `Мой плейлист № ${lib.playlists.length + 1}`, 'Создать'); if (n) { const p = createPlaylist(n, tracks); toast(`Создан «${p.name}»`, 'ok'); render(); } }
  }), 200);
}

function closeModal() { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; }
function prompt2(title, value, okText = 'Сохранить') {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><input class="field" id="dlgInput" value="${esc(value || '')}" enterkeyhint="done"><div class="btns"><button class="btn ghost" id="dlgCancel">Отмена</button><button class="btn" id="dlgOk">${esc(okText)}</button></div></div>`;
    m.classList.remove('hidden');
    const inp = $('#dlgInput'); inp.focus(); inp.select();
    const done = (v) => { closeModal(); resolve(v); };
    $('#dlgOk').onclick = () => done(inp.value.trim());
    $('#dlgCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); };
  });
}
function confirm2(title, text, okText = 'Удалить') {
  return new Promise((resolve) => {
    const m = $('#modal');
    m.innerHTML = `<div class="dialog"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="btns"><button class="btn ghost" id="dlgCancel">Отмена</button><button class="btn danger-btn" id="dlgOk">${esc(okText)}</button></div></div>`;
    m.classList.remove('hidden');
    $('#dlgOk').onclick = () => { closeModal(); resolve(true); };
    $('#dlgCancel').onclick = () => { closeModal(); resolve(false); };
  });
}
async function renamePlaylist(p) { const n = await prompt2('Переименовать плейлист', p.name); if (n) { p.name = n; save(); render(); } }
async function deletePlaylist(p) {
  if (!await confirm2('Удалить плейлист?', `«${p.name}» пропадёт, сами треки останутся.`)) return false;
  lib.playlists = lib.playlists.filter((x) => x !== p);
  save();
  return true;
}

// ============================================================ taps
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#sheet') || t.closest('#modal')) return;
  const tab = t.closest('[data-tab]'); if (tab) return goTab(tab.dataset.tab);

  const playCtxBtn = t.closest('[data-playctx]');
  if (playCtxBtn) return playCtx(playCtxBtn.dataset.playctx, -1);

  const row = t.closest('[data-ctx][data-i]');
  const act = t.closest('[data-act]');
  if (row) {
    const ctx = row.dataset.ctx, i = +row.dataset.i;
    const track = (lists[ctx] || [])[i];
    if (!track) return;
    const a = act && row.contains(act) ? act.dataset.act : 'play';
    if (a === 'like') return toggleLike(track);
    if (a === 'more') return trackMenu(track, ctx);
    return playFromRow(ctx, i);
  }

  const open = t.closest('[data-open]'); if (open) return openCtx(open.dataset.open);

  const more = t.closest('[data-more]');
  if (more) {
    const ctx = more.dataset.more, limit = +more.dataset.limit + PAGE;
    const tmp = document.createElement('div');
    tmp.innerHTML = trackList(lists[ctx], ctx, limit);
    more.previousElementSibling.replaceWith(tmp.firstElementChild);
    more.replaceWith(...[...tmp.children]);
    markPlaying();
    return;
  }

  const sortChip = t.closest('[data-sort]'); if (sortChip) { lib.settings.sort = sortChip.dataset.sort; save(); return render(); }
  const th = t.closest('[data-theme]');
  if (th) { const [id, , hue, sat] = THEMES.find((x) => x[0] === th.dataset.theme); setTheme({ id, hue, sat }); return render(); }
  const pr = t.closest('[data-preset]');
  if (pr) {
    if (t.closest('[data-delpreset]')) { delete lib.settings.eqCustom[pr.dataset.preset]; save(); return render(); }
    const n = pr.dataset.preset;
    const g = EQ_PRESETS[n] || lib.settings.eqCustom[n];
    Object.assign(lib.settings.eq, { preset: n, gains: g.slice(), preamp: Math.min(0, -Math.max(0, ...g) / 2) });
    enableEq(); save(); return render();
  }

  if (!act) return;
  const v = view();
  const ctx = v.name === 'all' ? 'all' : v.arg;
  switch (act.dataset.act) {
    case 'import': pickFiles(); break;
    case 'search': go('search'); break;
    case 'importpl': pickFiles(getPlaylist(String(ctx).slice(3))); break;
    case 'newpl': { const n = await prompt2('Новый плейлист', `Мой плейлист № ${lib.playlists.length + 1}`, 'Создать'); if (n) { const p = createPlaylist(n); go('list', 'pl:' + p.id); } break; }
    case 'rename': { const p = getPlaylist(String(ctx).slice(3)); if (p) renamePlaylist(p); break; }
    case 'plmenu': {
      const p = getPlaylist(String(ctx).slice(3)); if (!p) break;
      openSheet(`<div class="sheet-title">${esc(p.name)}</div><button data-m="add">${icon('upload')}Добавить файлы</button><button data-m="rename">${icon('edit')}Переименовать</button><button data-m="delete" class="danger">${icon('trash')}Удалить плейлист</button>`, async (m) => {
        if (m === 'add') pickFiles(p);
        if (m === 'rename') renamePlaylist(p);
        if (m === 'delete' && await deletePlaylist(p)) back();
      });
      break;
    }
    case 'shuffleplay': playCtx(ctx, -1, true); render(); break;
    case 'clearrecent': lib.recent = []; lib.recentLists = []; save(); render(); toast('История очищена'); break;
    case 'eqtoggle': if (lib.settings.eq.enabled) { lib.settings.eq.enabled = false; eq.apply(lib.settings.eq); } else enableEq(); save(); render(); break;
    case 'eqreset': Object.assign(lib.settings.eq, { preset: 'Ровный', gains: Array(10).fill(0), preamp: 0 }); eq.apply(lib.settings.eq); save(); render(); break;
    case 'eqsave': { const n = await prompt2('Название пресета', 'Мой пресет'); if (n) { lib.settings.eqCustom[n] = lib.settings.eq.gains.slice(); lib.settings.eq.preset = n; save(); render(); toast('Пресет сохранён', 'ok'); } break; }
    case 'ambienttoggle': setTheme({ ambient: !lib.settings.theme.ambient }); render(); break;
    case 'wipe': if (await confirm2('Удалить всю музыку?', `Все ${tracksWord(allTracks.length)} пропадут с телефона. Плейлисты останутся пустыми.`)) { await deleteTracks(allTracks.slice()); render(); toast('Музыка удалена'); } break;
    default: break;
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id !== 'themeColor') return;
  const hs = hexToHueSat(e.target.value);
  applyTheme({ ...lib.settings.theme, ...hs });
  const dot = e.target.closest('.dot'); dot.classList.remove('custom'); dot.setAttribute('style', themeSwatch(hs.hue, hs.sat));
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'themeColor') return;
  setTheme({ id: 'custom', color: e.target.value, ...hexToHueSat(e.target.value) });
  render();
});

// ============================================================ boot
(async function boot() {
  hydrateIcons();
  history.replaceState({ depth: 1 }, '');
  try {
    const saved = await db.get('kv', 'lib');
    if (saved) {
      lib = { ...structuredClone(DEFAULT_LIB), ...saved };
      lib.settings = { ...DEFAULT_LIB.settings, ...saved.settings, eq: { ...DEFAULT_LIB.settings.eq, ...(saved.settings || {}).eq }, theme: { ...DEFAULT_LIB.settings.theme, ...(saved.settings || {}).theme } };
    }
    for (const [key, blob] of await db.entries('covers')) coverUrls.set(key, URL.createObjectURL(blob));
    allTracks = (await db.entries('tracks')).map(([, t]) => t).sort((a, b) => b.added - a.added);
    byId = new Map(allTracks.map((t) => [t.id, t]));
  } catch (e) { toast('Не удалось открыть медиатеку: ' + e.message, 'err'); }
  applyTheme(lib.settings.theme);
  eq.apply(lib.settings.eq);
  updateModeButtons(); updatePlayButton();
  const last = resolveIds(lib.recent)[0];
  if (last) {
    const ctx = lib.recentLists.find(ctxExists);
    const list = ctx ? listFromCtx(ctx) : [last];
    const i = list.findIndex((t) => t.id === last.id);
    queue.set(i >= 0 ? list : [last], Math.max(0, i), i >= 0 ? ctx : 'recent');
    player.current = last;
  }
  updateNowPlaying();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !native) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
