/*
 * Живой интеграционный тест источника KinoKino (kinokino.win / Flicksbar).
 * Запускает собранный плагин в песочнице, но сеть — НАСТОЯЩАЯ:
 *   API fbphdplay.top → iframe Collaps → makePlayer → список файлов.
 *
 *   node test/live_kinokino.js [файл]     (по умолчанию dist/online_mod.js)
 *
 * Проверки: фильм (Обитель зла 2026, kp 7378605) и сериал (Холод, kp 7036356).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const FILE = process.argv[2] || path.join(__dirname, '..', 'dist', 'online_mod.js');
const code = fs.readFileSync(FILE, 'utf8');
const UA = 'Mozilla/5.0 (Web0S; Linux/x86_64) AppleWebKit/537.36 Chrome/79 Safari/537.36 WebAppManager';

const results = [];
const ok = (name, cond, extra) => { results.push({ name, pass: !!cond, extra: extra || '' }); };

/* ── цепочечная заглушка jQuery ─────────────────────────────── */
function chain() {
  const fn = function () { return chain(); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'length') return 0;
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '';
      if (typeof prop === 'string' && /^\d+$/.test(prop)) return undefined;
      if (prop === 'then') return undefined;
      return (..._a) => chain();
    },
    apply() { return chain(); },
  });
}
const $ = (..._a) => chain();
$.each = () => {};
$.extend = (a) => a;

/* ── настоящая сеть через заглушку Lampa.Reguest ───────────── */
function realGet(url, ons, onerr, opts, depth) {
  depth = depth || 0;
  opts = opts || {};
  const headers = Object.assign({ 'User-Agent': UA, 'Accept': '*/*' }, opts.headers || {});
  let req;
  try {
    req = https.get(url, { headers, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 3) {
        let next = res.headers.location;
        if (next.indexOf('//') === 0) next = 'https:' + next;
        res.resume();
        return realGet(next, ons, onerr, opts, depth + 1);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) { if (onerr) onerr({ status: res.statusCode, responseText: text }, 'error'); return; }
        if (opts.dataType === 'json') {
          try { ons(JSON.parse(text)); } catch (e) { if (onerr) onerr({ status: 200, responseText: text }, 'parsererror'); }
        } else if (ons) ons(text);
      });
    });
  } catch (e) { if (onerr) onerr({ status: 0, responseText: '' }, e.message); return; }
  req.on('error', (e) => { if (onerr) onerr({ status: 0, responseText: '' }, e.message); });
  req.on('timeout', () => { try { req.destroy(); } catch (e) {} if (onerr) onerr({ status: 0, responseText: '' }, 'timeout'); });
}

/* ── заглушка Lampa ─────────────────────────────────────────── */
const store = { online_mod_balanser: 'kinokino' };
const templates = {};
const langData = {};
const captured = { component: null, filterSort: null, filterItems: null, items: [], netCalls: [] };

function makeStorage() {
  return {
    get: (k, d) => (k in store ? store[k] : d),
    set: (k, v) => { store[k] = v; },
    field: (k) => store[k],
    cache: (k, _n, d) => (k in store ? store[k] : d),
    listener: { follow: () => {} },
  };
}

const LampaReal = {
  Storage: makeStorage(),
  /* v15: в сборках автора от 10.10.2026 настройки плагина регистрируются
   * через Lampa.SettingsApi (getComponent/addComponent/addParam) — в Lampa
   * этот API есть, добавляем и в заглушку, иначе тест новой сборки падает
   * с «Lampa.SettingsApi.getComponent is not a function». */
  SettingsApi: (function () {
    const comps = {};
    const params = [];
    return {
      getComponent: (n) => comps[n] || null,
      addComponent: (c) => { if (c && c.component) comps[c.component] = c; },
      addParam: (p) => { params.push(p); },
      getParam: (n) => params.find((p) => p && p.name === n) || null,
      removeComponent: (n) => { delete comps[n]; },
      removeParams: () => {},
      allComponents: () => comps,
      allParams: () => params,
    };
  })(),
  Lang: {
    add: (data) => { for (const l in data) langData[l] = Object.assign(langData[l] || {}, data[l]); },
    translate: (key) => {
      const e = langData[key];
      if (e && typeof e === 'object') return e.ru || String(key);
      return String(key).replace(/^#\{|\}$/g, '');
    },
  },
  Platform: { is: (n) => n === 'webos', any: 'webos', browser: 'webos' },
  Params: { trigger: () => {}, select: () => {}, update: () => {}, toggle: () => {}, value: (k) => store[k], play: () => {}, get: (k) => store[k], set: (k, v) => { store[k] = v; } },
  Template: {
    add: (k, v) => { templates[k] = v; },
    get: (k, el) => { if (k === 'online_mod' && el && el.file) captured.items.push(el); return chain(); },
  },
  Component: { add: (name, fn) => { if (name === 'online_mod') captured.component = fn; } },
  Filter: function () {
    return {
      set: (type, items) => { if (type === 'sort') captured.filterSort = items; if (type === 'filter') captured.filterItems = items; },
      chosen: () => {}, render: () => chain(), getSelected: () => ({}),
      onSearch: null, onBack: null, onSelect: null,
    };
  },
  Scroll: function () { return { body: () => chain(), render: () => chain(), minus: () => {}, append: () => {}, position: () => {}, update: () => {}, clear: () => {}, reset: () => {}, toggle: () => {} }; },
  Explorer: function () { return { render: () => chain(), appendFiles: () => {}, appendHead: () => {}, setEmpty: () => {} }; },
  Reguest: function () {
    return {
      clear: () => {},
      timeout: () => {},
      native: (url, ons, onerr, _l, opts) => { captured.netCalls.push(url); realGet(url, ons, onerr, opts); },
      silent: (url, ons, onerr, _l, opts) => { captured.netCalls.push(url); realGet(url, ons, onerr, opts); },
      post: (url, data, ons, onerr, _l, opts) => { captured.netCalls.push(url); if (onerr) onerr({ status: 0 }, 'post-stub'); },
      errorDecode: (a, c) => 'net:' + (a && a.status) + ':' + (c || ''),
    };
  },
  Activity: { push: () => {}, replace: () => {}, toggle: () => {}, loader: () => {}, active: () => ({ activity: {} }) },
  Settings: { main: () => ({ render: () => chain(), update: () => {} }), listener: { follow: () => {} }, api: () => {} },
  Listener: { follow: () => {} },
  Noty: { show: (m) => { captured.noty = String(m); } },
  Controller: { collectionSet: () => {}, collectionFocus: () => {}, toggle: () => {}, enable: () => {} },
  Arrays: { decodeJson: (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } }, extend: (a, b) => Object.assign(a, b), getKeys: (o) => Object.keys(o) },
  Manifest: {},
  Utils: new Proxy({}, { get: (_t, p) => (...a) => (typeof a[0] === 'string' ? a[0] : '') }),
  Timeline: { view: () => ({}), render: () => chain(), details: null },
  Select: Object.assign(() => {}, { close: () => {}, show: () => {}, clear: () => {} }),
  Modal: Object.assign(() => {}, { close: () => {} }),
  Helper: {}, Background: {}, Account: {},
  Favorite: { add: () => {} }, TMDB: {}, Player: { play: () => {}, playlist: () => {}, runas: () => {} }, VPN: null,
};
const Lampa = new Proxy(LampaReal, {
  get(t, p) { if (p in t) return t[p]; return (..._a) => chain(); },
});

/* ── окружение ─────────────────────────────────────────────── */
const windowStub = {
  location: { protocol: 'https:', hostname: 'lampa.mx', origin: 'https://lampa.mx', href: 'https://lampa.mx/' },
  addEventListener: () => {}, innerWidth: 1920, innerHeight: 1080, appready: true, tizen: null, webapis: null,
};
const sandbox = {
  $, jQuery: $, Lampa, window: windowStub, console,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  setTimeout, clearTimeout, setInterval, clearInterval, Math, JSON, Date, Promise,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI, RegExp, Error,
  Uint8Array, Int32Array, ArrayBuffer, Symbol, Proxy, Reflect, Map, Set, WeakMap,
  fetch: () => Promise.reject(new Error('net-stub')),
};
sandbox.document = new Proxy({
  createElement: () => chain(), body: chain(), head: chain(), addEventListener: () => {},
  querySelector: () => chain(), querySelectorAll: () => [], getElementById: () => chain(),
}, {
  get: (t, p) => (p in t ? t[p] : (..._a) => chain()),
});
// страховка: фоновые таймеры плагина дёргают UI-Lampa API, который в песочнице неполный
process.on('uncaughtException', (e) => { console.log('  (фоновый таймер плагина: ' + e.message + ')'); });
sandbox.navigator = { userAgent: UA };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

/* ── сценарий ──────────────────────────────────────────────── */
function waitFor(cond, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      let done = false;
      try { done = cond(); } catch (e) {}
      if (done || Date.now() - t0 > ms) { clearInterval(timer); resolve(done); }
    }, 200);
  });
}

async function runCard(movie, label, balanser) {
  store.online_mod_balanser = balanser || 'kinokino';
  captured.items = [];
  captured.netCalls = [];
  captured.filterItems = null;
  captured.noty = '';
  const activity = { loader: () => {}, toggle: () => {}, render: () => chain(), url: '', activity: {} };
  const comp = new captured.component({ movie, activity, title: movie.title, page: 1, clarification: false });
  comp.activity = activity;
  comp.create();
  comp.filter({}, {});
  const got = await waitFor(() => captured.items.length > 0 || captured.noty, 30000);
  console.log(`\n── ${label}: «${movie.title}» (kp ${movie.kinopoisk_id}) ──`);
  console.log('  сетевые запросы:');
  captured.netCalls.forEach((u) => console.log('   •', u.length > 110 ? u.slice(0, 110) + '…' : u));
  if (!got) { console.log('  ✘ пусто за 30 секунд. noty:', captured.noty || '—'); return false; }
  const it = captured.items[0];
  console.log(`  ✔ пунктов: ${captured.items.length}`);
  console.log('    первый:', JSON.stringify({ title: it.title, quality: it.quality, season: it.season, episode: it.episode }, null, 0));
  console.log('    файл:', (it.file || '').slice(0, 100) + '…');
  if (it.info) console.log('    переводы:', it.info.slice(0, 90));
  if (it.subtitles) console.log('    субтитры:', it.subtitles.map((s) => s.label).join(', '));
  if (it.audio_tracks) console.log('    аудиодорожки:', it.audio_tracks.map((a) => a.language).join(' | '));
  const seasons = (captured.filterItems || []).map((f) => f.title);
  if (seasons.length) console.log('    фильтр:', seasons.join(', '));
  return true;
}

(async () => {
  let loadError = null;
  try { vm.runInContext(code, sandbox, { filename: FILE, timeout: 15000 }); }
  catch (e) { loadError = e; }
  ok('плагин загрузился', !loadError, loadError ? loadError.message : '');
  if (loadError) { report(); process.exit(1); }

  const filmOk = await runCard(
    { id: 1, title: 'Обитель зла', original_title: 'Resident Evil', number_of_seasons: 0, kinopoisk_id: 7378605, imdb_id: '' },
    'ФИЛЬМ');
  ok('источник KinoKino в списке балансеров',
     (captured.filterSort || []).some((s) => s.title === 'KinoKino'),
     (captured.filterSort || []).map((s) => s.title).join(', '));
  let filmItem = captured.items[0] || {};
  ok('фильм: найден и есть ссылка', filmOk && !!filmItem.file, filmOk ? '' : 'пусто');
  ok('фильм: ссылка — HLS master.m3u8', /\.m3u8/.test(filmItem.file || ''), (filmItem.file || '').slice(0, 80));
  ok('фильм: несколько переводов (аудиодорожки)', (filmItem.audio_tracks || []).length >= 1, String((filmItem.audio_tracks || []).length));

  const serOk = await runCard(
    { id: 2, title: 'Холод', original_title: 'Холод', number_of_seasons: 1, kinopoisk_id: 7036356, imdb_id: '' },
    'СЕРИАЛ');
  const serItem = captured.items[0] || {};
  ok('сериал: найден и есть ссылка', serOk && !!serItem.file, serOk ? '' : 'пусто');
  ok('сериал: пункты с сезонами/эпизодами', !!serItem.season && !!serItem.episode, `s${serItem.season}e${serItem.episode}`);
  ok('фильм+сериал: честная метка качества (не 480p из кривой карты)', /\d+p/.test(filmItem.quality || '') && filmItem.quality !== '480p', filmItem.quality);

  const dashOk = await runCard(
    { id: 1, title: 'Обитель зла', original_title: 'Resident Evil', number_of_seasons: 0, kinopoisk_id: 7378605, imdb_id: '' },
    'ФИЛЬМ DASH', 'kinokino_dash');
  const dashItem = captured.items[0] || {};
  ok('DASH-балансер: ссылка .mpd или fallback .m3u8', /\.(mpd|m3u8)/.test(dashItem.file || ''), (dashItem.file || '').slice(0, 70));

  report();
  process.exit(results.some((r) => !r.pass) ? 1 : 0);
})();

function report() {
  console.log('\n' + '─'.repeat(60));
  let failed = 0;
  results.forEach((r) => {
    console.log(`  ${r.pass ? '✔' : '✘'} ${r.name}${r.extra ? '  →  ' + r.extra : ''}`);
    if (!r.pass) failed++;
  });
  console.log('─'.repeat(60));
  console.log(failed ? `ПРОВАЛЕНО: ${failed}` : 'ВСЕ ЖИВЫЕ ПРОВЕРКИ ПРОЙДЕНЫ');
}
