/*
 * Дымовой тест: запускает собранный плагин в песочнице с заглушкой Lampa
 * и проверяет, что он стартует, список балансеров правильный и мусор из настроек убран.
 *
 *   node test/smoke.js [файл]      (по умолчанию dist/online_mod.js)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = process.argv[2] || path.join(__dirname, '..', 'dist', 'online_mod.js');
const code = fs.readFileSync(FILE, 'utf8');

const results = [];
const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra: extra || '' });

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

/* ── заглушка Lampa ─────────────────────────────────────────── */
const store = {};
const templates = {};
const langData = {};
const captured = { component: null, filterSort: null, filterItems: null, activity: null, paramsSelect: [] };

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
  Lang: {
    add: (data) => { for (const l in data) langData[l] = Object.assign(langData[l] || {}, data[l]); },
    translate: (key) => {
      const l = langData.ru || {};
      if (l[key]) return typeof l[key] === 'object' ? l[key].ru : l[key];
      return String(key).replace(/^#\{|\}$/g, '');
    },
  },
  Platform: { is: (n) => n === 'webos', any: 'webos', browser: 'webos' },
  Params: {
    trigger: (k, v) => { store[k] = v; },
    select: (k, v, d) => { captured.paramsSelect.push(k); store[k] = d; },
    update: () => {},
    toggle: () => {},
    value: (k) => store[k],
    play: () => {},
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
  },
  Template: { add: (k, v) => { templates[k] = v; }, get: (k) => templates[k] || '' },
  Component: { add: (name, fn) => { if (name === 'online_mod') captured.component = fn; } },
  Filter: function () {
    return {
      set: (type, items) => { if (type === 'sort') captured.filterSort = items; if (type === 'filter') captured.filterItems = items; },
      chosen: () => {},
      render: () => chain(),
      getSelected: () => ({}),
      onSearch: null, onBack: null, onSelect: null,
    };
  },
  Scroll: function () { return { body: () => chain(), render: () => chain(), minus: () => {}, append: () => {}, position: () => {}, update: () => {}, clear: () => {}, reset: () => {}, toggle: () => {} }; },
  Explorer: function () { return { render: () => chain(), appendFiles: () => {}, appendHead: () => {}, setEmpty: () => {} }; },
  Reguest: function () {
    return {
      clear: () => {}, timeout: () => {}, native: () => {}, post: () => {},
      errorDecode: (a) => 'net-stub:' + a,
    };
  },
  Activity: { push: (o) => { captured.activity = o; }, replace: () => {}, toggle: () => {}, loader: () => {} },
  Settings: {
    main: () => ({ render: () => chain(), update: () => {} }),
    listener: { follow: () => {} },
    api: () => {},
  },
  Listener: { follow: () => {} },
  Noty: { show: () => {} },
  Controller: { collectionSet: () => {}, collectionFocus: () => {}, toggle: () => {}, enable: () => {} },
  Arrays: { decodeJson: (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } }, extend: (a, b) => Object.assign(a, b), getKeys: (o) => Object.keys(o) },
  Manifest: {},
  Utils: new Proxy({}, { get: (_t, p) => (...a) => (typeof a[0] === 'string' ? a[0] : '') }),
  Select: () => {}, Modal: () => {}, Helper: {}, Background: {}, Account: {}, Favorite: {}, Timeline: {}, TMDB: {}, Player: {}, VPN: null,
};

// всё, что не описали явно, — автоматически цепочечная заглушка
const Lampa = new Proxy(LampaReal, {
  get(t, p) {
    if (p in t) return t[p];
    return (..._a) => chain();
  },
});

/* ── окружение ─────────────────────────────────────────────── */
const windowStub = {
  location: { protocol: 'https:', hostname: 'lampa.mx', origin: 'https://lampa.mx', href: 'https://lampa.mx/' },
  addEventListener: () => {}, innerWidth: 1920, innerHeight: 1080, appready: true,
  tizen: null, webapis: null,
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
sandbox.document = new Proxy({ createElement: () => chain(), body: chain(), head: chain(), addEventListener: () => {} }, {
  get: (t, p) => (p in t ? t[p] : (..._a) => chain()),
});
sandbox.navigator = { userAgent: 'Mozilla/5.0 (Web0S; Linux/x86_64) AppleWebKit/537.36 Chrome/79 Safari/537.36 WebAppManager' };
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

/* ── запуск ────────────────────────────────────────────────── */
let loadError = null;
try { vm.runInContext(code, sandbox, { filename: FILE }); }
catch (e) { loadError = e; }
ok('плагин загрузился без ошибок', !loadError, loadError ? loadError.message : '');

if (!loadError) {
  ok('компонент online_mod зарегистрирован', typeof captured.component === 'function');
  ok('вкладка настроек «Онлайн Мод» создана', !!templates['settings_online_mod']);
  const TITLES = { lumex:'Lumex', lumex2:'Lumex (Ads)', rezka2:'HDrezka', kinobase:'Kinobase', collaps:'Collaps',
    'collaps-dash':'Collaps (DASH)', cdnmovies:'CDNMovies', filmix:'Filmix', zetflix:'Zetflix', fancdn:'FanCDN',
    fancdn2:'FanCDN (ID)', fanserials:'FanSerials', videoseed:'VideoSeed', vibix:'Vibix', redheadsound:'RedHeadSound',
    'redheadsound-dash':'RedHeadSound (DASH)', cdnvideohub:'CDNVideoHub', anilibria:'AniLibria', anilibria2:'AniLibria.top',
    animelib:'AnimeLib', kodik:'Kodik', alloha:'Alloha', kinopub:'KinoPub' };
  const expected = process.env.EXPECTED ? process.env.EXPECTED.split(',').map(x=>x.trim()).filter(Boolean) : null;
  ok('вкладка Filmix ' + (expected && expected.includes('Filmix') ? 'создана' : 'НЕ создана'),
     expected && expected.includes('Filmix') ? !!templates['settings_filmix'] : !templates['settings_filmix']);

  // название с пометкой
  const titleEntry = langData['online_mod_title_full'];
  const title = titleEntry && titleEntry.ru;
  ok('название помечено как своя сборка', title && /\(my\)/.test(title), title || 'нет перевода');

  // запускаем компонент на карточке фильма
  const movie = { id: 603, title: 'Матрица', original_title: 'The Matrix', number_of_seasons: 0, kinopoisk_id: 301, imdb_id: 'tt0133093' };
  const activity = { loader: () => {}, toggle: () => {}, render: () => chain(), url: '', activity: {} };
  let createError = null;
  try {
    const comp = new captured.component({ movie, activity, title: movie.title, page: 1, clarification: false });
    comp.activity = activity;   // в реальной Lampa это проставляет Activity.push()
    comp.create();
    comp.filter({}, {});        // строит меню фильтров, в т.ч. список балансеров
  } catch (e) { createError = e; }
  ok('карточка фильма открывается без ошибок', !createError, createError ? (createError.message + ' | ' + (createError.stack || '').split('\n')[1]) : '');

  const sort = (captured.filterSort || []).map((s) => s.title);
  const exp = expected || ['HDrezka', 'CDNVideoHub', 'Kodik', 'KinoKino'];
  ok('список балансеров = ' + exp.join(' + '), JSON.stringify(sort) === JSON.stringify(exp), 'получено: ' + (sort.join(', ') || '—'));

  // настройки: не осталось пунктов удалённых источников
  const tpl = templates['settings_online_mod'] || '';
  const isLite = !/full/.test(FILE);
  const visible = sort.length ? sort : (expected || []);
  const junk = Object.keys(TITLES)
    .filter((n) => !visible.includes(TITLES[n]))
    .filter((n) => new RegExp('online_mod_(proxy_)?' + n + '["\\\\]').test(tpl));
  ok('в настройках нет мусора от удалённых источников', !isLite || junk.length === 0,
     junk.length ? (isLite ? 'осталось: ' + junk.join(', ') : 'полная сборка, чистка настроек выключена') : '');
  if (!expected || expected.includes('Kodik')) ok('настройка прокси Kodik на месте', /online_mod_proxy_kodik/.test(tpl));
  if (!expected || expected.includes('HDrezka')) ok('настройки HDrezka на месте', /online_mod_rezka2_mirror/.test(tpl));
}

/* ── отчёт ─────────────────────────────────────────────────── */
console.log('');
console.log('Тест: ' + path.relative(process.cwd(), FILE) + '  (' + Math.round(code.length / 1024) + ' КБ)');
console.log('─'.repeat(60));
let failed = 0;
results.forEach((r) => {
  console.log((r.pass ? '  ✔ ' : '  ✘ ') + r.name + (r.extra ? '  →  ' + r.extra : ''));
  if (!r.pass) failed++;
});
console.log('─'.repeat(60));
console.log(failed ? `ПРОВАЛЕНО: ${failed}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
process.exit(failed ? 1 : 0);
