/*
 * Живой тест: KinoKino + свой прокси-воркер на Android.
 * Повторяет пользовательский сценарий «Не открывает плеер»:
 *   - адрес воркера введён БЕЗ слэша на конце и с пробелами — плагин обязан
 *     нормализовать его (иначе proxyLink склеивает «...deno.netenc2/...»);
 *   - при живом воркере на Android играем встроенным плеером Lampa
 *     (Player.runas('lampa')), ссылки — через воркер;
 *   - DASH-балансер на Android+воркер отдаёт HLS (встроенный не умеет mpd);
 *   - при мёртвом воркере — тихий откат на прямые ссылки и системный плеер.
 *
 *   node test/proxy_android.js [файл]   (по умолчанию dist/online_mod.js)
 *
 * Сеть — настоящая: API fbphdplay.top, CDN Collaps и боевой воркер
 * (адрес — в WORKER_URL, по умолчанию воркер Eugene4190).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const FILE = process.argv[2] || path.join(__dirname, '..', 'dist', 'online_mod.js');
const WORKER = process.env.WORKER_URL || 'https://festive-kestrel-8533.eugene4190.deno.net';
const DEAD_WORKER = 'https://kinokino-worker-dead-9999.deno.net';
const code = fs.readFileSync(FILE, 'utf8');
const UA = 'Mozilla/5.0 (Linux; Android 13; M2012K11AG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

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

/* ── заглушка Lampa (платформа — Android!) ─────────────────── */
const store = { online_mod_balanser: 'kinokino' };
const templates = {};
const langData = {};
const captured = { component: null, filterSort: null, filterItems: null, items: [], netCalls: [], enter: null, runas: null, playData: null, noty: '' };

function makeStorage() {
  return {
    get: (k, d) => (k in store ? store[k] : d),
    set: (k, v) => { store[k] = v; },
    field: (k) => store[k],
    cache: (k, _n, d) => (k in store ? store[k] : d),
    listener: { follow: () => {} },
  };
}

function makeItemStub(el) {
  return {
    on: (ev, fn) => { if (ev === 'hover:enter') captured.enter = fn; },
    append: () => {},
    find: () => ({ append: () => {} }),
  };
}

const LampaReal = {
  Storage: makeStorage(),
  Lang: {
    add: (data) => { for (const l in data) langData[l] = Object.assign(langData[l] || {}, data[l]); },
    translate: (key) => {
      const e = langData[key];
      if (e && typeof e === 'object') return e.ru || String(key);
      return String(key).replace(/^#\{|\}$/g, '');
    },
  },
  Platform: { is: (n) => n === 'android', any: 'android', browser: 'android' },
  Params: { trigger: () => {}, select: () => {}, update: () => {}, toggle: () => {}, value: (k) => store[k], play: () => {}, get: (k) => store[k], set: (k, v) => { store[k] = v; } },
  Template: {
    add: (k, v) => { templates[k] = v; },
    get: (k, el) => { if (k === 'online_mod' && el && el.file) { captured.items.push(el); return makeItemStub(el); } return chain(); },
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
  Favorite: { add: () => {} }, TMDB: {},
  Player: {
    play: (d) => { captured.playData = d; },
    playlist: () => {},
    runas: (v) => { captured.runas = v; },
  },
  VPN: null,
};
const Lampa = new Proxy(LampaReal, {
  get(t, p) { if (p in t) return t[p]; return (..._a) => chain(); },
});

/* ── окружение ─────────────────────────────────────────────── */
const windowStub = {
  location: { protocol: 'https:', hostname: 'lampa.mx', origin: 'https://lampa.mx', href: 'https://lampa.mx/' },
  addEventListener: () => {}, innerWidth: 1080, innerHeight: 1920, appready: true, tizen: null, webapis: null,
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
  captured.enter = null;
  captured.runas = null;
  captured.playData = null;
  captured.noty = '';
  const activity = { loader: () => {}, toggle: () => {}, render: () => chain(), url: '', activity: {} };
  const comp = new captured.component({ movie, activity, title: movie.title, page: 1, clarification: false });
  comp.activity = activity;
  comp.create();
  comp.filter({}, {});
  const got = await waitFor(() => captured.items.length > 0 || captured.noty, 40000);
  console.log(`\n── ${label}: «${movie.title}» (${balanser || 'kinokino'}) ──`);
  if (!got) { console.log('  ✘ пусто за 40 секунд. noty:', captured.noty || '—'); return null; }
  const it = captured.items[0];
  console.log('    файл:', (it.file || '').slice(0, 110) + '…');
  return it;
}

function rawGet(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': UA }, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', () => resolve({ status: 0, text: '' }))
      .on('timeout', function () { this.destroy(); resolve({ status: 0, text: '' }); });
  });
}

const EVIL = { id: 1, title: 'Обитель зла', original_title: 'Resident Evil', number_of_seasons: 0, kinopoisk_id: 7378605, imdb_id: '' };
const INTER = { id: 2, title: 'Интерстеллар', original_title: 'Interstellar', number_of_seasons: 0, kinopoisk_id: 258687, imdb_id: 'tt0816692' };

(async () => {
  let loadError = null;
  try { vm.runInContext(code, sandbox, { filename: FILE, timeout: 15000 }); }
  catch (e) { loadError = e; }
  ok('плагин загрузился', !loadError, loadError ? loadError.message : '');
  if (loadError) { report(); process.exit(1); }

  /* ── A. живой воркер, адрес без слэша и с пробелами ── */
  store.online_mod_proxy_other = true;
  store.online_mod_proxy_other_url = '  ' + WORKER + '  '; // злой ввод пользователя
  let item = await runCard(EVIL, 'A. ЖИВОЙ ВОРКЕР (адрес без слэша)');
  ok('A: список построен', !!item);
  if (item) {
    const normalized = WORKER + '/enc2/';
    ok('A: ссылка через воркер (слэш нормализован)', (item.file || '').indexOf(normalized) === 0, (item.file || '').slice(0, 70));
    ok('A: расширение master.m3u8 сохранено', /master\.m3u8$/.test(item.file || ''), (item.file || '').slice(-30));

    // имитируем нажатие «играть»
    if (captured.enter) captured.enter({}, {});
    ok('A: на Android с воркером форсируется встроенный плеер Lampa', captured.runas === 'lampa', 'runas=' + JSON.stringify(captured.runas));
    ok('A: в плеер уехала ссылка через воркер', captured.playData && (captured.playData.url || '').indexOf(normalized) === 0, captured.playData ? (captured.playData.url || '').slice(0, 70) : 'нет play()');

    // и что эта ссылка реально играет
    const playUrl = captured.playData && captured.playData.url;
    if (playUrl) {
      const r = await rawGet(playUrl);
      ok('A: воркер отдаёт плейлист по ссылке плеера', r.status === 200 && r.text.indexOf('#EXTM3U') === 0, 'status=' + r.status);
      ok('A: плейлист переписан на воркер (сегменты не умрут)', r.text.indexOf(WORKER) !== -1 && /#EXT-X-MEDIA:TYPE=AUDIO/.test(r.text), r.text.slice(0, 60));
    } else ok('A: воркер отдаёт плейлист по ссылке плеера', false, 'нет url');
  }

  /* ── B. DASH-балансер на Android + воркер → HLS-фолбэк ── */
  item = await runCard(INTER, 'B. DASH-балансер + воркер (Android)', 'kinokino_dash');
  ok('B: список построен', !!item);
  if (item) {
    ok('B: вместо .mpd отдан HLS (встроенный плеер не умеет DASH)', /master\.m3u8/.test(item.file || '') && (item.file || '').indexOf(WORKER + '/enc2/') === 0, (item.file || '').slice(0, 90));
  }

  /* ── C. мёртвый воркер → откат на прямые ссылки ── */
  store.online_mod_proxy_other_url = DEAD_WORKER;
  item = await runCard(EVIL, 'C. МЁРТВЫЙ ВОРКЕР (откат)');
  ok('C: список построен несмотря на мёртвый воркер', !!item);
  if (item) {
    ok('C: откат на прямые ссылки (без /enc2/)', /^https:\/\/(?!kinokino-worker-dead)/.test(item.file || '') && (item.file || '').indexOf('/enc2/') === -1, (item.file || '').slice(0, 80));
    if (captured.enter) captured.enter({}, {});
    ok('C: системный плеер не форсируется во встроенный', captured.runas === '', 'runas=' + JSON.stringify(captured.runas));
  }

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
  console.log(failed ? `ПРОВАЛЕНО: ${failed}` : 'ВСЕ ПРОВЕРКИ ПРОКСИ ПРОЙДЕНЫ');
}
