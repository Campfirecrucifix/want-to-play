'use strict';
// ===== constants =====
const REPO = 'Campfirecrucifix/want-to-play';
const KEY = 'wtp.v1', SET = 'wtp.settings', TAGS = 'wtp.tags';
const GIST_FILE = 'want-to-play.json';
const NATIVE = !!window.WTP;
// Shell v2 and older drew under the system bars; pad from the web side until the shell is updated.
if (NATIVE && window.WTP.shellVersion && window.WTP.shellVersion() < 3) document.documentElement.classList.add('legacy-insets');
const LISTS = { want: 'Want to Play', her: 'For Her', played: 'Played', nottaste: 'Not My Taste' };
const MODES = ['Single', 'Co-op', 'Online Co-op', 'Local Co-op', 'PvP', 'MMO', 'VR', 'Multiplayer'];
const STATUS = { // order = sort order for "Sort: Status"
  new: { t: 'Just released', c: 'new', o: 0 }, soon: { t: 'Coming soon', c: 'soon', o: 1 },
  ea: { t: 'Early Access', c: 'ea', o: 2 }, tba: { t: 'Unreleased', c: 'tba', o: 3 },
  out: { t: 'Released', c: 'out', o: 4 }, none: { t: 'Not on Steam', c: 'none', o: 5 }, unk: { t: 'Not loaded', c: 'none', o: 6 },
};
const CAT_MODE = { 2: 'Single', 9: 'Co-op', 38: 'Online Co-op', 39: 'Local Co-op', 24: 'Local Co-op', 48: 'Local Co-op',
  49: 'PvP', 36: 'PvP', 37: 'PvP', 47: 'PvP', 20: 'MMO', 31: 'VR', 53: 'VR', 54: 'VR', 1: 'Multiplayer' };
const DAY = 864e5;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s).toLowerCase().replace(/[™®©]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
const uid = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ===== state =====
let db = load(KEY, { games: [] });
let settings = load(SET, { list: 'want', sort: 'status', filters: [], token: '', gistId: '' });
let tagNames = load(TAGS, { at: 0, map: {} });
function load(k, d) { try { return Object.assign(d, JSON.parse(localStorage[k])); } catch { return d; } }
function saveSettings() { localStorage[SET] = JSON.stringify(settings); }
function save(push = true) {
  localStorage[KEY] = JSON.stringify(db);
  pushWatch();
  if (push) scheduleSync();
}
const live = () => db.games.filter(g => !g.deleted);
const tracked = () => live().filter(g => !g.excluded); // excluded = kept (so wishlist sync won't re-add) but hidden & never refreshed
function touch(g) { g.u = Date.now(); }

// ===== networking =====
// On Android the shell proxies ./__proxy?u=... natively (no CORS). Steam has no CORS, so a desktop browser can't refresh;
// it shows the Steam data synced from the phone via the gist instead.
async function getJSON(url) {
  const r = await fetch(NATIVE ? `__proxy?u=${encodeURIComponent(url)}` : url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const steamItemsUrl = ids => 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' + encodeURIComponent(JSON.stringify({
  ids: ids.map(appid => ({ appid })), context: { language: 'english', country_code: 'US' },
  data_request: { include_release: true, include_basic_info: true, include_assets: true, include_tag_count: 12, include_reviews: true },
}));
const searchUrl = term => `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=US&l=english`;

async function ensureTags() {
  if (Date.now() - tagNames.at < 7 * DAY && Object.keys(tagNames.map).length) return;
  const d = await getJSON('https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english');
  tagNames = { at: Date.now(), map: Object.fromEntries(d.response.tags.map(t => [t.tagid, t.name])) };
  localStorage[TAGS] = JSON.stringify(tagNames);
}

// Status key — MUST stay identical to statusKey() in android RefreshWorker.kt (used for change notifications)
function statusKey(it) {
  const r = it.release || {};
  const soon = !!(r.is_coming_soon || it.is_coming_soon), ea = !!(r.is_early_access || it.is_early_access);
  const demo = (it.related_items?.demo_appid || []).length > 0;
  const base = soon ? `${ea ? 'soonEA' : 'soon'}|${r.coming_soon_display || ''}|${r.steam_release_date || ''}|${r.custom_release_date_message || ''}`
    : ea ? 'ea' : 'out';
  return base + (demo ? '|demo' : '');
}

function parseItem(it) {
  const r = it.release || {};
  const cats = [...(it.categories?.supported_player_categoryids || []), ...(it.categories?.feature_categoryids || [])];
  let modes = [...new Set(cats.map(c => CAT_MODE[c]).filter(Boolean))];
  if (modes.length > 1) modes = modes.filter(m => m !== 'Multiplayer');
  const a = it.assets || {}, fmt = a.asset_url_format;
  const img = fmt && (a.header || a.main_capsule) ? 'https://shared.akamai.steamstatic.com/store_item_assets/' + fmt.replace('${FILENAME}', a.header || a.main_capsule) : '';
  const p = it.best_purchase_option || {};
  const rev = it.reviews?.summary_filtered;
  return {
    name: it.name, img, key: statusKey(it),
    soon: !!(r.is_coming_soon || it.is_coming_soon), ea: !!(r.is_early_access || it.is_early_access),
    display: r.coming_soon_display || '', ts: (r.steam_release_date || 0) * 1000, msg: r.custom_release_date_message || '',
    eaExit: (r.release_from_early_access_date || 0) * 1000,
    demo: (it.related_items?.demo_appid || [])[0] || null,
    modes, tags: (it.tagids || []).map(t => tagNames.map[t]).filter(Boolean).slice(0, 8),
    price: it.is_free ? 'Free' : p.formatted_final_price || '', orig: p.formatted_original_price || '', disc: p.discount_pct || 0,
    reviews: rev?.review_count ? `${rev.review_score_label} (${rev.percent_positive}%)` : '',
    desc: it.basic_info?.short_description || '', dev: (it.basic_info?.developers || []).map(d => d.name).join(', '),
    fetched: Date.now(),
  };
}

let refreshing = false;
async function refresh(force = false) {
  if (refreshing || !NATIVE) return; refreshing = true; $('#btnRefresh').classList.add('spin');
  try {
    await ensureTags();
    if (settings.wishlist?.steamid && (force || Date.now() - (settings.wishlist.last || 0) > 12 * 36e5)) await syncWishlist().catch(() => { });
    const stale = tracked().filter(g => g.appid && (force || !g.steam || Date.now() - g.steam.fetched > 6 * 36e5));
    const changes = [];
    for (let i = 0; i < stale.length; i += 40) {
      const chunk = stale.slice(i, i + 40);
      const d = await getJSON(steamItemsUrl(chunk.map(g => g.appid)));
      const byId = Object.fromEntries((d.response.store_items || []).filter(x => x.success === 1).map(x => [x.appid, x]));
      for (const g of chunk) {
        const it = byId[g.appid]; if (!it) continue;
        const s = parseItem(it), old = g.steam;
        if (old && old.key !== s.key) { g.change = { from: label(old), to: label(s), at: Date.now() }; changes.push(g); }
        g.steam = s;
        if (/^Steam app \d+$/.test(g.name)) g.name = s.name;
      }
    }
    save(false); render(); syncSoon();
    if (changes.length) toast(`${changes.length} game(s) changed status`);
    refreshPatches(force).catch(() => { });
  } catch (e) { toast('Refresh failed: ' + e.message); }
  finally { refreshing = false; $('#btnRefresh').classList.remove('spin'); }
}

function pushWatch() {
  if (!NATIVE || !window.WTP.setWatch) return;
  window.WTP.setWatch(JSON.stringify(tracked().filter(g => g.appid && g.steam && g.list !== 'played' && g.list !== 'nottaste')
    .map(g => ({ appid: g.appid, name: g.name, key: g.steam.key }))));
}

// ===== status labels =====
function kind(s) {
  if (!s) return 'unk';
  if (s.soon) return s.ts && s.display !== 'text_tba' ? 'soon' : 'tba';
  if (s.ea) return 'ea';
  if (s.ts && Date.now() - s.ts < 30 * DAY) return 'new';
  return 'out';
}
const gkind = g => g.appid ? kind(g.steam) : 'none';
function rel(ts) {
  const d = Math.round((ts - Date.now()) / DAY);
  if (d === 0) return 'today'; if (d === 1) return 'tomorrow'; if (d === -1) return 'yesterday';
  const a = Math.abs(d), w = Math.round(a / 7), m = Math.round(a / 30);
  const t = a < 14 ? `${a} days` : a < 60 ? `${w} weeks` : `${m} months`;
  return d > 0 ? `in ${t}` : `${t} ago`;
}
const fmtDate = ts => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
function label(s) {
  const k = kind(s), pre = s?.soon && s.ea ? 'Early Access ' : '';
  switch (k) {
    case 'soon': {
      const dt = new Date(s.ts);
      if (s.display === 'date_month') return `${pre}${dt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
      if (s.display === 'date_quarter') return `${pre}Q${Math.floor(dt.getMonth() / 3) + 1} ${dt.getFullYear()}`;
      if (s.display === 'date_year') return `${pre}${dt.getFullYear()}`;
      return `${pre}${rel(s.ts)} · ${fmtDate(s.ts)}`;
    }
    case 'tba': return pre + (s.msg && !/^to be announced$/i.test(s.msg) ? s.msg : 'TBA');
    case 'ea': return 'Early Access';
    case 'new': return `Released ${rel(s.ts)}`;
    case 'out': return s.ts ? `Released ${new Date(s.ts).getFullYear()}` : 'Released';
    default: return STATUS[k].t;
  }
}

// ===== rendering =====
function render() {
  renderTabs(); renderFilters(); renderBanner();
  const q = norm($('#q').value);
  let games = tracked().filter(g => g.list === settings.list);
  if (q) games = games.filter(g => norm([g.name, g.notes, ...(g.steam?.tags || []), ...modesOf(g), g.steam?.dev].join(' ')).includes(q));
  for (const f of settings.filters) {
    const [t, v] = f.split(':');
    games = games.filter(g => t === 's' ? gkind(g) === v : t === 'demo' ? g.steam?.demo : t === 'fav' ? g.fav : modesOf(g).includes(v));
  }
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    added: (a, b) => b.added - a.added,
    release: (a, b) => (b.steam?.ts || 0) - (a.steam?.ts || 0),
    // soonest dated release first, then vaguer dates (month/quarter/year sort by their date too), then TBA, then out/early access
    soon: (a, b) => {
      const r = g => ({ soon: 0, tba: 1, ea: 2, new: 3, out: 4 }[gkind(g)] ?? 5), ra = r(a), rb = r(b);
      return ra - rb || (ra === 0 ? a.steam.ts - b.steam.ts : (b.steam?.ts || 0) - (a.steam?.ts || 0)) || a.name.localeCompare(b.name);
    },
    patch: (a, b) => (b.patch?.date || 0) - (a.patch?.date || 0) || a.name.localeCompare(b.name),
    status: (a, b) => STATUS[gkind(a)].o - STATUS[gkind(b)].o || (gkind(a) === 'soon' ? (a.steam.ts - b.steam.ts) : (b.steam?.ts || 0) - (a.steam?.ts || 0)) || a.name.localeCompare(b.name),
  }[settings.sort];
  games.sort(settings.favTop !== false ? (a, b) => (!!b.fav - !!a.fav) || by(a, b) : by);
  $('#list').innerHTML = games.length ? games.map(card).join('') : `<p class="empty">No games here. Tap ＋ to add one.</p>`;
}
function modesOf(g) { return g.myModes?.length ? g.myModes : (g.steam?.modes || []); }
function card(g) {
  const s = g.steam, k = gkind(g);
  return `<article class="card${g.fav ? ' fav' : ''}" data-id="${g.id}">
    <button class="star${g.fav ? ' on' : ''}" data-star="${g.id}" aria-label="Favorite">${g.fav ? '★' : '☆'}</button>
    ${s?.img ? `<img src="${esc(s.img)}" loading="lazy" alt="">` : `<div class="noimg">${esc(g.name[0] || '?')}</div>`}
    <div class="info">
      <h3>${esc(g.name)}</h3>
      <div class="row"><span class="st ${STATUS[k].c}">${esc(g.appid ? label(s) : STATUS.none.t)}</span>
        ${s?.demo ? '<span class="st demo">Demo</span>' : ''}
        ${s?.disc ? `<span class="st sale">-${s.disc}%</span>` : ''}</div>
      <div class="row modes">${modesOf(g).map(m => `<span class="mode">${esc(m)}</span>`).join('')}</div>
      ${s?.tags?.length ? `<div class="tags">${esc(s.tags.slice(0, 5).join(' · '))}</div>` : ''}
      ${g.notes ? `<div class="notes">${esc(g.notes)}</div>` : ''}
      ${g.patch && (settings.sort === 'patch' || Date.now() - g.patch.date < 30 * DAY) ? `<div class="cpatch">🛠 <b>Patched ${rel(g.patch.date)}</b>${g.patch.changes ? ` · ${g.patch.changes} changes` : ''}${g.patch.sum ? ` — ${esc(g.patch.sum)}` : ''}</div>` : ''}
    </div></article>`;
}
function renderTabs() {
  const counts = {}; for (const g of tracked()) counts[g.list] = (counts[g.list] || 0) + 1;
  $('#tabs').innerHTML = Object.entries(LISTS).map(([k, t]) =>
    `<button data-list="${k}" class="${settings.list === k ? 'on' : ''}">${t} <small>${counts[k] || 0}</small></button>`).join('');
}
function renderFilters() {
  const chips = [...['soon', 'tba', 'ea', 'new', 'out', 'none'].map(k => [`s:${k}`, STATUS[k].t]), ['fav', '★ Favorites'], ['demo', 'Has demo'],
    ...MODES.slice(0, 6).map(m => [`m:${m}`, m])];
  $('#filters').innerHTML = chips.map(([v, t]) => `<button data-f="${v}" class="${settings.filters.includes(v) ? 'on' : ''}">${t}</button>`).join('');
}
let changesOpen = false; // survives re-renders (background refreshes redraw the banner)
document.addEventListener('toggle', e => { if (e.target.matches?.('#banner details.changes')) changesOpen = e.target.open; }, true);
function renderBanner() {
  const days = settings.changeDays || 14;
  const recent = tracked().filter(g => g.change && !g.change.dismissed && Date.now() - g.change.at < days * DAY).sort((a, b) => b.change.at - a.change.at);
  let h = '';
  if (shellUpdate) h += `<div class="upd" id="updBox">App update v${shellUpdate.v} available. <button class="updbtn" data-apk="${esc(shellUpdate.url)}">${updState || 'Update'}</button></div>`;
  if (recent.length) h += `<details class="changes" ${changesOpen ? 'open' : ''}><summary>🔔 ${recent.length} status change(s) <small>(clears after ${days} days)</small></summary>${recent.map(g =>
    `<div data-id="${g.id}" class="chg"><span><b>${esc(g.name)}</b>: ${esc(g.change.from)} → <b>${esc(g.change.to)}</b> <small>${rel(g.change.at)}</small></span><button class="x" data-dismiss="${g.id}" aria-label="Clear">✕</button></div>`).join('')}
    <div class="btns"><button data-dismiss="all">Clear all</button></div></details>`;
  $('#banner').innerHTML = h;
}

// ===== sheets (detail / add / settings) =====
function openSheet(html) {
  $('#sheetBody').innerHTML = html; $('#sheetBody').scrollTop = 0;
  if ($('#sheet').classList.contains('hidden')) { $('#sheet').classList.remove('hidden'); history.pushState({ sheet: 1 }, ''); }
}
function closeSheet(fromPop) { if ($('#sheet').classList.contains('hidden')) return; $('#sheet').classList.add('hidden'); if (!fromPop) history.back(); }
window.addEventListener('popstate', () => closeSheet(true));
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

function showGame(id) {
  const g = db.games.find(x => x.id === id); if (!g) return;
  const s = g.steam, k = gkind(g);
  openSheet(`
    ${s?.img ? `<img class="hero" src="${esc(s.img)}" alt="">` : ''}
    <h2><button class="star big${g.fav ? ' on' : ''}" data-star="${g.id}" aria-label="Favorite">${g.fav ? '★' : '☆'}</button>${esc(g.name)}</h2>
    <div class="row"><span class="st ${STATUS[k].c}">${esc(g.appid ? label(s) : STATUS.none.t)}</span>
      ${s?.price ? `<span class="price">${s.disc ? `<s>${esc(s.orig)}</s> ` : ''}${esc(s.price)}</span>` : ''}</div>
    ${s?.reviews ? `<p class="muted">${esc(s.reviews)}${s.dev ? ' · ' + esc(s.dev) : ''}</p>` : ''}
    ${s?.desc ? `<p>${esc(s.desc)}</p>` : ''}
    ${s?.tags?.length ? `<p class="tags">${esc(s.tags.join(' · '))}</p>` : ''}
    ${s?.modes?.length ? `<p class="muted">Steam lists: ${esc(s.modes.join(', '))}</p>` : ''}
    <label>List</label>
    <select id="eList">${Object.entries(LISTS).map(([k, t]) => `<option value="${k}" ${g.list === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <label>My modes <small>(overrides Steam's)</small></label>
    <div class="chips" id="eModes">${MODES.map(m => `<button data-m="${m}" class="${g.myModes?.includes(m) ? 'on' : ''}">${m}</button>`).join('')}</div>
    <label>Notes</label><textarea id="eNotes" rows="3">${esc(g.notes)}</textarea>
    <label>Steam app ID or store URL ${g.appid ? '' : '<small>(link this game to Steam)</small>'}</label>
    <input id="eApp" value="${g.appid || ''}" inputmode="numeric">
    <div class="btns">
      <button class="pri" id="eSave">Save</button>
      ${g.appid ? `<button data-open="https://store.steampowered.com/app/${g.appid}">Steam page</button>` : ''}
      ${s?.demo ? `<button data-open="https://store.steampowered.com/app/${s.demo}">Demo page</button>` : ''}
      ${g.appid ? `<button id="ePatch">📝 Patches & news</button>` : ''}
      <button id="eExcl">${g.excluded ? '↩ Track again' : '🚫 Stop tracking'}</button>
      <button class="del" id="eDel">Delete</button>
    </div>`);
  $('#eModes').onclick = e => { const b = e.target.closest('button'); if (b) b.classList.toggle('on'); };
  $('#eSave').onclick = () => {
    const app = parseAppId($('#eApp').value);
    g.list = $('#eList').value; g.notes = $('#eNotes').value.trim();
    g.myModes = [...document.querySelectorAll('#eModes .on')].map(b => b.dataset.m);
    if (app !== g.appid) {
      const other = app && live().find(x => x !== g && x.appid === app);
      if (other) return toast(`${other.name} already uses that Steam ID (${LISTS[other.list]}${other.excluded ? ', excluded' : ''})`);
      g.appid = app; g.steam = null; g.change = null; g.patch = null; delete g.patchChecked;
    }
    touch(g); save(); render(); closeSheet(); if (app && !g.steam) refresh();
  };
  if ($('#ePatch')) {
    $('#ePatch').onclick = () => showPatches(g.id);
    const showLast = p => $('#ePatch')?.parentElement.insertAdjacentHTML('beforebegin', `<div class="lastpatch"><b>Last patch:</b> ${esc(p.title)} · ${rel(p.date)}${p.sum ? `<div class="psum">${esc(p.sum)}</div>` : ''}</div>`);
    if (g.patch) showLast(g.patch);
    else checkPatch(g).then(() => { if (g.patch) { save(false); render(); showLast(g.patch); } }).catch(() => { });
  }
  $('#eExcl').onclick = () => { setExcluded(g, !g.excluded); closeSheet(); toast(g.excluded ? `Stopped tracking ${g.name} (Settings → Manage tracked games to undo)` : `Tracking ${g.name} again`); };
  $('#eDel').onclick = () => { if (confirm(`Delete ${g.name}?`)) { Object.keys(g).forEach(k => k !== 'id' && k !== 'appid' && delete g[k]); g.deleted = true; touch(g); save(); render(); closeSheet(); } };
}
function parseAppId(v) { v = String(v).trim(); const m = v.match(/app\/(\d+)/) || v.match(/^(\d+)$/); return m ? +m[1] : null; }

// ===== patches & news (official Steam announcements) =====
const newsCache = {};
const isPatch = n => (n.tags || []).includes('patchnotes') || !/console|nintendo|switch|playstation|ps[45]|xbox/i.test(n.title) && /patch|hotfix|changelog|update|fixes|bug ?fix|\bv?\d+\.\d+(\.\d+)?\b/i.test(n.title);
const NEWS = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?feeds=steam_community_announcements&format=json&appid=';

// Latest patch per game: a ~4KB titles-only check; the full post is fetched (and summarized) only when it's a new patch.
async function checkPatch(g) {
  const d = await getJSON(`${NEWS}${g.appid}&count=10&maxlength=1`);
  g.patchChecked = Date.now();
  const p = (d.appnews?.newsitems || []).find(isPatch);
  if (!p) return;
  if (g.patch?.gid === p.gid && g.patch.sum != null) return;
  const full = (await getJSON(`${NEWS}${g.appid}&count=1&enddate=${p.date}&maxlength=0`)).appnews?.newsitems?.[0];
  const sm = full?.gid === p.gid ? patchSummary(full.contents, full.title) : { text: '', changes: 0 };
  g.patch = { gid: p.gid, title: p.title, date: p.date * 1000, url: p.url, sum: sm.text, changes: sm.changes };
}
let patching = false;
async function refreshPatches(force = false) {
  if (patching || !NATIVE) return; patching = true;
  try {
    const todo = tracked().filter(g => g.appid && g.list !== 'played' && g.list !== 'nottaste' && (force || !g.patchChecked || Date.now() - g.patchChecked > 12 * 36e5));
    let i = 0, dirty = 0;
    const worker = async () => { while (i < todo.length) { const g = todo[i++]; try { await checkPatch(g); } catch { } if (++dirty % 20 === 0) { save(false); render(); } } };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (dirty) { save(false); render(); }
  } finally { patching = false; }
}
async function getNews(appid) {
  const c = newsCache[appid];
  if (c && Date.now() - c.at < 30 * 6e4) return c.items;
  const d = await getJSON(`${NEWS}${appid}&count=40&maxlength=0`);
  const items = (d.appnews?.newsitems || []).map(n => ({ title: n.title, date: n.date * 1000, url: n.url, body: n.contents, patch: isPatch(n) }));
  newsCache[appid] = { at: Date.now(), items };
  return items;
}

async function showPatches(id, all = false) {
  const g = db.games.find(x => x.id === id); if (!g) return;
  openSheet(`<div class="btns" style="margin-top:0"><button id="pBack">← Back</button></div>
    <h2>${esc(g.name)}</h2>
    <div class="chips"><button id="pPatch" class="${all ? '' : 'on'}">Patches</button><button id="pAll" class="${all ? 'on' : ''}">All announcements</button></div>
    <div id="pList"><p class="muted">Loading…</p></div>`);
  $('#pBack').onclick = () => showGame(id);
  $('#pPatch').onclick = () => showPatches(id, false);
  $('#pAll').onclick = () => showPatches(id, true);
  try {
    const items = (await getNews(g.appid)).filter(n => all || n.patch);
    if (!$('#pList')) return;
    $('#pList').innerHTML = items.length ? items.map((n, i) => `<details class="news" data-i="${i}" ${i === 0 ? 'open' : ''}>
        <summary><b>${esc(n.title)}</b><span class="when">${fmtDate(n.date)} · ${rel(n.date)}</span>${n.patch ? '<span class="st patch">Patch</span>' : ''}
          ${n.patch ? (sm => sm.text ? `<span class="psum">${esc(sm.text)}</span>` : '')(patchSummary(n.body, n.title)) : ''}</summary>
        <div class="bb">${i === 0 ? bb(n.body) : ''}</div>
        <div class="btns"><button data-open="${esc(n.url)}">Open on Steam</button></div></details>`).join('')
      : `<p class="muted">${all ? 'No announcements found.' : 'No recent patch notes found. Try “All announcements”.'}</p>`;
    // render bodies lazily when expanded
    document.querySelectorAll('#pList details').forEach(d => d.addEventListener('toggle', () => {
      const box = d.querySelector('.bb'); if (d.open && !box.innerHTML) box.innerHTML = bb(items[d.dataset.i].body);
    }));
  } catch (e) {
    if ($('#pList')) $('#pList').innerHTML = `<p class="muted">${NATIVE ? 'Could not load news (' + esc(e.message) + ').' : 'Patch notes load in the Android app only.'}</p>
      <div class="btns"><button data-open="https://store.steampowered.com/news/app/${g.appid}">Open Steam news page</button></div>`;
  }
}

// 1–2 sentence summary of a Steam patch post (prototype/test: seed-tools/patchSummary.js)
function patchSummary(src, title = '') {
  const strip = s => s.replace(/\{STEAM_CLAN_IMAGE\}\S*/g, '').replace(/\[[^\]]*\]/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  const KEY = /\b(fix|add|improv|balanc|adjust|optimi[sz]|remov|rework|tweak|introduc|new|feature|content|crash|bug|nerf|buff|chang)/i;
  const FLUFF = /^(attention|reminder|remember|note|please|psa|important|disclaimer|developer note|spoiler)\b|\b(below|following|full list|read on|check out|discord|wishlist|follow us|join (our|the)|maintenance|downtime|completion time|thank you|thanks|apolog|changelog|version is|mods?\b|we.ll (share|continue|be back)|we.re back|stay tuned|leaves|autumn|weather)/i;
  const bullets = [...src.matchAll(/\[\*\]([\s\S]*?)(?=\[\*\]|\[\/\*\]|\[\/list\]|\[\/olist\]|$)/gi)].map(m => strip(m[1]));
  let blocks = src.replace(/\[(o?list)\][\s\S]*?\[\/\1\]/gi, '\n').split(/\[\/?(?:p|h[1-6]|hr|quote|table|img)[^\]]*\]|\n/i).map(strip).filter(Boolean);
  blocks = blocks.flatMap(b => b.split(/\s(?=\d+[.)]\s+[A-Z])/)); // "...vary: 1. Optimized ... 2. Fixed ..."
  blocks = blocks.filter(b => { const m = b.match(/^(?:\d+[.)]|[-•*])\s+(.*)/); if (m) bullets.push(m[1]); return !m; });
  const items = bullets.filter(b => b.length > 8 && /[a-z]{3}/.test(b) && !/^[A-Z][a-z]+ \d{1,2},? \d{4}/.test(b) && !/:$/.test(b) && !FLUFF.test(b));
  const prose = blocks.map(b => b.replace(/^(hi|hello|hey|greetings|dear|howdy|ahoy|good (morning|afternoon|evening))\b[^.!?]{0,40}?[,!.]+\s*/i, ''))
    .filter(b => b.length > 30 && /[a-z]{3}/.test(b) && b !== strip(title) && !/^(version|build|changelog|patch notes|update notes|known issues)\b[^.!?]{0,40}$/i.test(b));
  const sentences = (prose.join(' ').match(/.+?(?:[.!?]+(?=\s+["“(]?[A-Z])|[.!?]*$)/g) || []).map(s => s.trim())
    .filter(s => s.length > 20 && !/[:;]$/.test(s) && !FLUFF.test(s));
  const keyed = sentences.filter(x => KEY.test(x));
  const p2 = (keyed.length ? keyed : items.length ? [] : sentences).slice(0, 2).join(' ');
  let out = p2 ? p2 : items.length ? items.slice(0, 2).map(b => b.replace(/[.;,!]+$/, '')).join('; ') + '.' : p2;
  if (out.length > 240) out = out.slice(0, 237).replace(/\s+\S*$/, '') + '…';
  return { text: out, changes: items.length > 2 ? items.length : 0 };
}

// Steam announcement BBCode -> safe HTML (input is escaped first; only whitelisted tags are re-created)
function bb(src) {
  const http = u => /^https?:\/\//i.test(u) ? u : '';
  let s = esc(src).replace(/\{STEAM_CLAN_IMAGE\}/g, 'https://clan.akamai.steamstatic.com/images');
  const hasP = /\[p\b/i.test(s);
  s = s
    .replace(/\[img src=&quot;(.*?)&quot;[^\]]*\](?:\[\/img\])?/gi, (_, u) => http(u) ? `<img src="${u}" loading="lazy" alt="">` : '')
    .replace(/\[img(?:=[^\]]*)?\]([\s\S]*?)\[\/img\]/gi, (_, u) => http(u.trim()) ? `<img src="${u.trim()}" loading="lazy" alt="">` : '')
    .replace(/\[url=(?:&quot;)?(.*?)(?:&quot;)?\]([\s\S]*?)\[\/url\]/gi, (_, u, t) => http(u) ? `<a href="#" data-open="${u}">${t}</a>` : t)
    .replace(/\[previewyoutube=&quot;?([\w-]+)[^\]]*\]\[\/previewyoutube\]/gi, (_, id) => `<p><a href="#" data-open="https://youtu.be/${id}">▶ Watch video</a></p>`)
    .replace(/\[(\/?)(h[1-6]|b|i|u|s|p|code|table|tr|td|th)(?:\s[^\]]*)?\]/gi, '<$1$2>')
    .replace(/\[(\/?)list\]/gi, '<$1ul>').replace(/\[(\/?)olist\]/gi, '<$1ol>')
    .replace(/\[\*\]/g, '<li>').replace(/\[\/\*\]/g, '</li>')
    .replace(/\[hr\](\[\/hr\])?/gi, '<hr>')
    .replace(/\[quote(?:=[^\]]*)?\]/gi, '<blockquote>').replace(/\[\/quote\]/gi, '</blockquote>')
    .replace(/\[\/?[a-z][a-z0-9]*(?:[= ][^\]]*)?\]/gi, '');
  return hasP ? s : s.replace(/\n/g, '<br>');
}

function showAdd() {
  openSheet(`<h2>Add game</h2>
    <input id="aq" type="search" placeholder="Game name, Steam ID, or store URL" autofocus>
    <label>Add to</label>
    <select id="aList">${Object.entries(LISTS).map(([k, t]) => `<option value="${k}" ${settings.list === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <div id="ares"></div>`);
  let timer;
  $('#aq').oninput = () => { clearTimeout(timer); timer = setTimeout(doSearch, 400); };
  $('#aq').onkeydown = e => { if (e.key === 'Enter') { clearTimeout(timer); doSearch(); } };
  setTimeout(() => $('#aq').focus(), 50);
  async function doSearch() {
    const v = $('#aq').value.trim(); if (!v) return ($('#ares').innerHTML = '');
    const id = parseAppId(v);
    $('#ares').innerHTML = '<p class="muted">Searching…</p>';
    try {
      let items;
      if (id) {
        const d = await getJSON(steamItemsUrl([id]));
        items = (d.response.store_items || []).filter(x => x.success === 1).map(x => ({ id: x.appid, name: x.name }));
      } else items = (await getJSON(searchUrl(v))).items || [];
      $('#ares').innerHTML = items.map(i => {
        const have = live().find(g => g.appid === i.id);
        return `<div class="res" data-add="${i.id}" data-name="${esc(i.name)}">
          <img src="https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${i.id}/capsule_231x87.jpg" alt="" onerror="this.style.visibility='hidden'">
          <span>${esc(i.name)}</span>${have ? `<small>${have.excluded ? 'excluded' : 'in ' + LISTS[have.list]}</small>` : ''}</div>`;
      }).join('') + `<div class="res manual" data-add="" data-name="${esc(v)}"><span>＋ Add “${esc(v)}” without Steam link</span></div>`;
    } catch (e) {
      $('#ares').innerHTML = (id ? `<div class="res" data-add="${id}" data-name="Steam app ${id}"><span>＋ Add Steam app ${id} <small>(details load on your phone)</small></span></div>`
        : `<p class="muted">${NATIVE ? `Search failed (${esc(e.message)}).` : 'Name search only works in the Android app. Paste a Steam store URL or app ID instead.'}</p>`)
        + `<div class="res manual" data-add="" data-name="${esc(v)}"><span>＋ Add “${esc(v)}” without Steam link</span></div>`;
    }
  }
  $('#ares').onclick = e => {
    const r = e.target.closest('[data-add]'); if (!r) return;
    const appid = r.dataset.add ? +r.dataset.add : null;
    const have = live().find(x => appid ? x.appid === appid : !x.appid && norm(x.name) === norm(r.dataset.name));
    if (have) {
      if (have.excluded && confirm(`${have.name} is excluded. Track it again?`)) { setExcluded(have, false); have.list = $('#aList').value; touch(have); save(); render(); closeSheet(); if (appid && !have.steam) refresh(); }
      else if (!have.excluded) toast(`${have.name} is already in ${LISTS[have.list]}`);
      return;
    }
    const g = { id: uid(), appid, name: r.dataset.name, list: $('#aList').value, notes: '', myModes: [], added: Date.now() };
    touch(g); db.games.push(g); save(); settings.list = g.list; saveSettings(); render(); closeSheet(); toast(`Added ${g.name}`);
    if (g.appid) refresh();
  };
}

function showSettings() {
  const w = settings.wishlist || {}, nEx = live().filter(g => g.excluded).length;
  openSheet(`<h2>Settings</h2>
    <h3>Steam wishlist</h3>
    <p class="muted">New games on your Steam wishlist are added automatically (checked every ~12 hours and when you tap ⟳). Your Steam <b>Game details</b> privacy must be <b>Public</b>. Games you stop tracking or delete are never re-added.</p>
    <input id="wId" placeholder="Steam profile URL, custom URL name, or SteamID64" value="${esc(w.input || '')}">
    <label>Add new wishlist games to</label>
    <select id="wList">${Object.entries(LISTS).map(([k, t]) => `<option value="${k}" ${(w.list || 'want') === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <div class="btns"><button class="pri" id="wSync">${w.steamid ? 'Save & sync now' : 'Connect wishlist'}</button>${w.steamid ? '<button id="wOff">Disconnect</button>' : ''}</div>
    <p class="muted" id="wStat">${w.steamid ? `Connected (${esc(w.steamid)})${w.last ? ` · ${w.count ?? '?'} games on wishlist · checked ${rel(w.last)}` : ''}` : 'Not connected.'}</p>
    <h3>Tracking</h3>
    <div class="btns"><button id="sManage">🚫 Manage tracked games${nEx ? ` (${nEx} excluded)` : ''}</button></div>
    <h3>Sync across devices</h3>
    <p class="muted">Your list is stored on this device. To sync with another device (or a PC browser), paste a GitHub token with only the <b>gist</b> permission. Your list is saved in a secret gist on your account.</p>
    <input id="sTok" type="password" placeholder="GitHub token (ghp_… or github_pat_…)" value="${esc(settings.token)}">
    <div class="btns"><button class="pri" id="sSync">Save & sync now</button>
      <button data-open="https://github.com/settings/tokens/new?scopes=gist&description=Want%20to%20Play%20sync">Create token</button></div>
    <p class="muted">${settings.gistId ? `Synced gist: ${esc(settings.gistId)}${settings.lastSync ? ' · last sync ' + rel(settings.lastSync) : ''}` : 'Not syncing.'}</p>
    <h3>Import / export</h3>
    <input id="sUrl" placeholder="Import from URL (JSON)">
    <div class="btns"><button id="sImp">Import URL</button><button id="sExp">Export / backup</button></div>
    <textarea id="sJson" rows="3" placeholder="…or paste exported JSON here"></textarea>
    <div class="btns"><button id="sPaste">Import pasted JSON</button></div>
    <h3>Notifications</h3>
    <label>Clear status-change notifications after</label>
    <select id="sDays">${[3, 7, 14, 30, 60].map(d => `<option value="${d}" ${(settings.changeDays || 14) === d ? 'selected' : ''}>${d} days</option>`).join('')}</select>
    <h3>Favorites</h3>
    <label class="tgl"><input type="checkbox" id="sFavTop" ${settings.favTop !== false ? 'checked' : ''}> Always show favorites at the top of each list</label>
    <h3>Data</h3>
    <div class="btns"><button id="sForce">Re-fetch all from Steam</button></div>
    <p class="muted">Web app auto-updates. Shell v${NATIVE && window.WTP.shellVersion ? window.WTP.shellVersion() : '-'} · ${live().length} games ·
      <a href="#" data-open="https://github.com/${REPO}/releases/latest">releases</a></p>`);
  $('#sSync').onclick = async () => { settings.token = $('#sTok').value.trim(); saveSettings(); await sync(true); closeSheet(); };
  $('#sImp').onclick = async () => { try { importData(await (await fetch($('#sUrl').value.trim())).json()); closeSheet(); } catch (e) { toast('Import failed: ' + e.message); } };
  $('#sPaste').onclick = () => { try { importData(JSON.parse($('#sJson').value)); closeSheet(); } catch (e) { toast('Bad JSON: ' + e.message); } };
  $('#sExp').onclick = () => {
    const json = JSON.stringify({ version: 1, games: db.games }, null, 0);
    if (NATIVE && window.WTP.share) window.WTP.share(json);
    else navigator.clipboard.writeText(json).then(() => toast('Copied to clipboard'));
  };
  $('#sForce').onclick = () => { closeSheet(); refresh(true); };
  $('#sManage').onclick = () => showManage();
  $('#sDays').onchange = e => { settings.changeDays = +e.target.value; saveSettings(); render(); };
  $('#sFavTop').onchange = e => { settings.favTop = e.target.checked; saveSettings(); render(); };
  $('#wSync').onclick = async () => {
    const input = $('#wId').value.trim(); if (!input) return toast('Enter your Steam profile');
    $('#wStat').textContent = 'Connecting…';
    try {
      const steamid = await resolveSteamId(input);
      settings.wishlist = { ...settings.wishlist, input, steamid, list: $('#wList').value };
      if (settings.wishlist.steamid !== w.steamid) delete settings.wishlist.last;
      saveSettings();
      const n = await syncWishlist(true);
      closeSheet(); if (n) refresh();
    } catch (e) { $('#wStat').textContent = e.message; }
  };
  if ($('#wOff')) $('#wOff').onclick = () => { delete settings.wishlist; saveSettings(); showSettings(); toast('Wishlist disconnected (games already added stay)'); };
}

// ===== Steam wishlist =====
async function getText(url) {
  const r = await fetch(NATIVE ? `__proxy?u=${encodeURIComponent(url)}` : url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function resolveSteamId(v) {
  let m = v.match(/\b(7656\d{13})\b/); if (m) return m[1];
  if (!NATIVE) throw new Error('Custom profile names only resolve in the Android app — use your SteamID64.');
  const name = (v.match(/\/id\/([^/?#]+)/) || [, v])[1];
  if (!/^[\w-]{2,32}$/.test(name)) throw new Error('That doesn’t look like a Steam profile.');
  const html = await getText(`https://store.steampowered.com/wishlist/id/${encodeURIComponent(name)}/`);
  m = html.match(/steamid\\?"\s*:\s*\\?"(7656\d{13})/);
  if (!m) throw new Error(`No Steam profile found for “${name}”.`);
  return m[1];
}
async function syncWishlist(loud = false) {
  const w = settings.wishlist; if (!w?.steamid) return 0;
  const d = await getJSON(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${w.steamid}`);
  const items = d.response?.items;
  if (!items) { const msg = 'Wishlist is empty or private (Steam → Edit Profile → Privacy → Game details: Public).'; if (loud) throw new Error(msg); return 0; }
  const known = new Set(db.games.filter(g => g.appid).map(g => g.appid)); // includes excluded & deleted
  const fresh = items.filter(i => !known.has(i.appid)).sort((a, b) => a.priority - b.priority);
  // real names up front, so wishlist games can be matched to games on your list that aren't linked to Steam yet
  const names = {};
  for (let k = 0; k < fresh.length; k += 40) {
    try {
      const r = await getJSON(steamItemsUrl(fresh.slice(k, k + 40).map(i => i.appid)));
      for (const x of r.response.store_items || []) if (x.success === 1) names[x.appid] = x.name;
    } catch { }
  }
  const sameName = (a, b) => { const x = norm(a).replace(/ (demo|playtest)$/, ''), y = norm(b).replace(/ (demo|playtest)$/, ''); return x.length > 2 && x === y; };
  let linked = 0; const add = [];
  for (const i of fresh) {
    const nm = names[i.appid];
    const match = nm && live().find(g => !g.appid && sameName(g.name, nm));
    if (match) { match.appid = i.appid; match.steam = null; touch(match); linked++; continue; }
    add.push(i);
  }
  for (const i of add) {
    const g = { id: uid(), appid: i.appid, name: names[i.appid] || `Steam app ${i.appid}`, list: w.list || 'want', notes: '', myModes: [], added: (i.date_added * 1000) || Date.now(), src: 'wishlist' };
    touch(g); db.games.push(g);
  }
  dedupe();
  w.last = Date.now(); w.count = items.length; saveSettings();
  if (add.length || linked) { save(); render(); toast([add.length && `Added ${add.length} game(s) from your Steam wishlist`, linked && `linked ${linked} existing game(s) to Steam`].filter(Boolean).join(', ')); }
  else if (loud) toast(`Wishlist synced — all ${items.length} games already tracked or excluded`);
  return add.length + linked;
}

// One game per Steam app ID. Duplicates can appear when two devices add the same game before syncing, or an app ID is edited
// onto a game that already exists. Deterministic (same keeper on every device) so synced copies converge.
function dedupe() {
  const groups = {};
  for (const g of live()) if (g.appid) (groups[g.appid] = groups[g.appid] || []).push(g);
  let n = 0;
  for (const gs of Object.values(groups)) {
    if (gs.length < 2) continue;
    gs.sort((a, b) => (a.src === 'wishlist') - (b.src === 'wishlist') || (a.added || 0) - (b.added || 0) || (a.id < b.id ? -1 : 1));
    const [keep, ...dups] = gs;
    for (const d of dups) {
      if (d.notes && !keep.notes?.includes(d.notes)) keep.notes = [keep.notes, d.notes].filter(Boolean).join('\n');
      if (!keep.myModes?.length && d.myModes?.length) keep.myModes = d.myModes;
      if (!keep.steam && d.steam) keep.steam = d.steam;
      if (!keep.patch && d.patch) keep.patch = d.patch;
      if (d.fav) keep.fav = true;
      Object.keys(d).forEach(k => k !== 'id' && k !== 'appid' && delete d[k]); d.deleted = true; touch(d); n++;
    }
    touch(keep);
  }
  return n;
}

// ===== manage tracked / excluded games =====
function setExcluded(g, on) {
  if (on) g.excluded = true; else delete g.excluded;
  touch(g); save(); render();
}
function showManage(filter = 'all', q = '') {
  const all = live().sort((a, b) => (!!b.excluded - !!a.excluded) || a.name.localeCompare(b.name));
  const F = { all: 'All', excluded: 'Excluded', wishlist: 'From wishlist', ...LISTS };
  openSheet(`<div class="btns" style="margin-top:0"><button id="mBack">← Settings</button></div>
    <h2>Manage tracked games</h2>
    <p class="muted">Excluded games are hidden from your lists and never refreshed or notified, and wishlist sync won't add them back.</p>
    <input id="mQ" type="search" placeholder="Search…" value="${esc(q)}">
    <div class="chips" id="mF">${Object.entries(F).map(([k, t]) => `<button data-mf="${k}" class="${filter === k ? 'on' : ''}">${t}</button>`).join('')}</div>
    <div id="mList"></div>`);
  const draw = () => {
    const nq = norm($('#mQ').value);
    const rows = all.filter(g => (filter === 'all' || (filter === 'excluded' ? g.excluded : filter === 'wishlist' ? g.src === 'wishlist' : g.list === filter)) && (!nq || norm(g.name).includes(nq)));
    $('#mList').innerHTML = rows.length ? rows.map(g => `<div class="mrow ${g.excluded ? 'off' : ''}" data-mid="${g.id}">
        <span><b>${esc(g.name)}</b><small>${LISTS[g.list] || ''}${g.src === 'wishlist' ? ' · wishlist' : ''}</small></span>
        <button class="tog">${g.excluded ? 'Excluded' : 'Tracking'}</button></div>`).join('') : '<p class="muted">No games.</p>';
  };
  draw();
  $('#mQ').oninput = draw;
  $('#mBack').onclick = () => showSettings();
  $('#mF').onclick = e => { const b = e.target.closest('[data-mf]'); if (b) showManage(b.dataset.mf, $('#mQ').value); };
  $('#mList').onclick = e => {
    const row = e.target.closest('[data-mid]'); if (!row || !e.target.closest('.tog')) return;
    const g = db.games.find(x => x.id === row.dataset.mid); setExcluded(g, !g.excluded);
    row.classList.toggle('off', !!g.excluded); row.querySelector('.tog').textContent = g.excluded ? 'Excluded' : 'Tracking';
    if (!g.excluded && g.appid && !g.steam) refresh();
  };
}

function importData(d) {
  const games = Array.isArray(d) ? d : d.games || [];
  let n = 0;
  for (const g of games) {
    if (g.deleted || !g.name) continue;
    if (live().some(x => x.id === g.id || (g.appid && x.appid === g.appid) || (!g.appid && norm(x.name) === norm(g.name)))) continue;
    db.games.push({ ...g, id: g.id || uid(), myModes: (g.myModes || []).map(normMode).filter(Boolean), added: g.added || Date.now(), u: g.u || Date.now() }); n++;
  }
  dedupe(); save(); render(); toast(`Imported ${n} game(s)`); refresh();
}
function normMode(m) {
  const k = norm(m);
  return { single: 'Single', 'co op': 'Co-op', coop: 'Co-op', 'online co op': 'Online Co-op', 'split screen': 'Local Co-op', 'local co op': 'Local Co-op',
    pvp: 'PvP', mmo: 'MMO', vr: 'VR', multiplayer: 'Multiplayer' }[k] || MODES.find(x => norm(x) === k) || null;
}

// ===== gist sync =====
const gh = (path, opt = {}) => fetch('https://api.github.com' + path, { ...opt,
  headers: { Authorization: 'Bearer ' + settings.token, Accept: 'application/vnd.github+json', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } })
  .then(async r => { if (!r.ok) throw new Error(`GitHub ${r.status}`); return r.status === 204 ? null : r.json(); });
let syncTimer;
function scheduleSync() { if (settings.token) { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(), 3000); } }
const syncSoon = scheduleSync;
async function sync(loud) {
  if (!settings.token) return;
  try {
    if (!settings.gistId) {
      const list = await gh('/gists?per_page=100');
      settings.gistId = list.find(x => x.files[GIST_FILE])?.id || '';
    }
    let remote = [];
    if (settings.gistId) {
      const gist = await gh('/gists/' + settings.gistId);
      const f = gist.files[GIST_FILE];
      const txt = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
      remote = JSON.parse(txt).games || [];
    }
    // merge: newest edit (u) wins per game id; ties -> newer steam data
    const map = new Map(db.games.map(g => [g.id, g]));
    for (const r of remote) {
      const l = map.get(r.id);
      if (!l || r.u > l.u || (r.u === l.u && (r.steam?.fetched || 0) > (l.steam?.fetched || 0))) {
        if (l?.patch && (l.patch.date > (r.patch?.date || 0))) { r.patch = l.patch; r.patchChecked = l.patchChecked; } // keep newer local patch info
        map.set(r.id, r);
      }
    }
    db.games = [...map.values()];
    dedupe();
    for (const g of db.games) if (g.myModes) g.myModes = g.myModes.map(m => normMode(m) || m);
    const body = JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify({ version: 1, games: db.games }) } },
      ...(settings.gistId ? {} : { description: 'Want to Play list (app data)', public: false }) });
    const res = await gh(settings.gistId ? '/gists/' + settings.gistId : '/gists', { method: settings.gistId ? 'PATCH' : 'POST', body });
    settings.gistId = res.id; settings.lastSync = Date.now(); saveSettings();
    save(false); render();
    if (loud) toast('Synced'); if (live().some(g => g.appid && !g.steam)) refresh();
  } catch (e) { toast('Sync failed: ' + e.message); }
}

// ===== shell self-update check =====
let shellUpdate = null, updState = '';
// called by the Android shell while updating
window.onUpdateStatus = (state, pct) => {
  updState = { progress: `Downloading ${pct}%`, installing: 'Opening installer…', error: 'Failed — tap to retry', denied: 'Permission needed — tap to retry',
    permission: 'Allow “install unknown apps”, then come back' }[state] || '';
  if (state === 'error' || state === 'denied') { updState = ''; toast(state === 'error' ? 'Update download failed — tap Update to retry' : 'Update needs the “install unknown apps” permission'); }
  if (state === 'installing') setTimeout(() => { updState = ''; renderBanner(); }, 4000);
  renderBanner();
};
async function checkShell() {
  if (!NATIVE || !window.WTP.shellVersion) return;
  try {
    const r = await (await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)).json();
    const v = +String(r.tag_name).replace(/\D/g, ''), asset = r.assets?.find(a => a.name.endsWith('.apk'));
    if (v > window.WTP.shellVersion() && asset) { shellUpdate = { v, url: asset.browser_download_url }; renderBanner(); }
  } catch { }
}

// ===== misc =====
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 3000); }
function openExternal(url) { NATIVE && window.WTP.openExternal ? window.WTP.openExternal(url) : window.open(url, '_blank'); }

document.addEventListener('click', e => {
  const t = e.target;
  const open = t.closest('[data-open]'); if (open) { e.preventDefault(); return openExternal(open.dataset.open); }
  const apk = t.closest('[data-apk]');
  if (apk) {
    e.preventDefault();
    if (updState) return; // already in progress
    if (window.WTP?.installUpdate) { updState = 'Starting…'; renderBanner(); window.WTP.installUpdate(apk.dataset.apk, shellUpdate.v); }
    else openExternal(apk.dataset.apk); // shells older than v4: download via browser
    return;
  }
  const tab = t.closest('[data-list]'); if (tab) { settings.list = tab.dataset.list; saveSettings(); return render(); }
  const f = t.closest('#filters [data-f]');
  if (f) { const v = f.dataset.f; settings.filters = settings.filters.includes(v) ? settings.filters.filter(x => x !== v) : [...settings.filters, v]; saveSettings(); return render(); }
  const star = t.closest('[data-star]');
  if (star) {
    const g = db.games.find(x => x.id === star.dataset.star); if (!g) return;
    if (g.fav) delete g.fav; else g.fav = true;
    touch(g); save(); render();
    document.querySelectorAll(`[data-star="${g.id}"]`).forEach(b => { b.classList.toggle('on', !!g.fav); b.textContent = g.fav ? '★' : '☆'; });
    return toast(g.fav ? `★ ${g.name} added to favorites` : `Removed ${g.name} from favorites`);
  }
  const dis = t.closest('[data-dismiss]');
  if (dis) {
    const ids = dis.dataset.dismiss === 'all' ? [...document.querySelectorAll('#banner .chg')].map(x => x.dataset.id) : [dis.dataset.dismiss];
    for (const id of ids) { const g = db.games.find(x => x.id === id); if (g?.change) { g.change.dismissed = true; touch(g); } }
    save(); return renderBanner();
  }
  const c = t.closest('#list .card, #banner .chg'); if (c) return showGame(c.dataset.id);
});
$('#q').oninput = render;
$('#sort').value = settings.sort;
$('#sort').onchange = () => { settings.sort = $('#sort').value; saveSettings(); render(); };
$('#fab').onclick = showAdd;
$('#btnSettings').onclick = showSettings;
$('#btnRefresh').onclick = () => NATIVE ? refresh(true) : sync(true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) NATIVE ? refresh() : sync(); });

// first run: offer import if empty and a #import=URL hash is given
(async () => {
  const m = location.hash.match(/import=(.+)/);
  if (m) { history.replaceState(null, '', location.pathname); try { importData(await (await fetch(decodeURIComponent(m[1]))).json()); } catch (e) { toast('Import failed'); } }
  if (dedupe()) save(false);
  render();
  if (settings.token) await sync();
  refresh(); checkShell();
})();
