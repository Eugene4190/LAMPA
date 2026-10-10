#!/usr/bin/env node
/*
 * Сборщик своей версии плагина «Онлайн Мод» для Lampa.
 *
 *   node build.js
 *
 * Что делает:
 *   1. качает свежий online_mod.js из репозитория автора (nb557/plugins);
 *   2. применяет правки из блока CONFIG ниже (разбор кода — через acorn, поэтому безопасно);
 *   3. проверяет результат (синтаксис + нет ли ссылок на удалённый код);
 *   4. кладёт готовое в dist/online_mod.js (облегчённый) и dist/online_mod.full.js (полный).
 *
 * Когда автор плагина выпустит обновление — просто запусти `node build.js` ещё раз.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const acorn = require('acorn');

/* ══════════════════════════════════════════════════════════════
   CONFIG — здесь всё, что ты хочешь поменять. Правь только этот блок.
   ══════════════════════════════════════════════════════════════ */
const CONFIG = {
  // Какие источники оставить в списке балансеров.
  // Все имена: lumex, lumex2, rezka2, kinobase, collaps, collaps-dash, cdnmovies,
  //   filmix, zetflix, fancdn, fancdn2, fanserials, videoseed, vibix, redheadsound,
  //   redheadsound-dash, cdnvideohub, anilibria, anilibria2, animelib, kodik, alloha, kinopub
  //
  // Работают БЕЗ авторизации: rezka2 (HDrezka), kodik (Kodik), cdnvideohub, anilibria2 (аниме).
  // Требуют аккаунт/токен: filmix (PRO), kinopub (подписка), fancdn, lumex.
  KEEP: ['rezka2', 'kodik', 'cdnvideohub'],

  // Балансер по умолчанию при открытии карточки.
  // Если его нет в KEEP — возьмётся первый из KEEP.
  DEFAULT_BALANSER: 'cdnvideohub',

  // Свои источники: код класса кладёшь в custom_sources.js, сюда — одну строку.
  // Пример: { name:'kinogo', title:'Kinogo', search:true, kp:false, imdb:false }
  // (фабрика подставится автоматически по имени класса из custom_sources.js)
  EXTRA_SOURCES: [
    { name: 'kinokino', title: 'KinoKino', search: false, kp: true, imdb: true },
    { name: 'kinokino_dash', title: 'KinoKino (DASH)', search: false, kp: true, imdb: true },
  ],

  // true  -> физически вырезать из файла код неиспользуемых источников (565 КБ -> ~185 КБ)
  // false -> код остаётся, источники просто скрыты из списка
  STRIP_DEAD_CODE: true,

  // Убрать из настроек Lampa пункты вырезанных источников
  CLEAN_SETTINGS: true,

  // Убрать отдельную папку «Filmix» из настроек (если filmix не нужен)
  DISABLE_FILMIX: true,

  // Пометка в названии, чтобы на ТВ было видно, что стоит твоя сборка. '' — без пометки.
  TITLE_SUFFIX: ' (my)',

  // Пометка в версии (видна в подсказке кнопки «Онлайн» на карточке фильма).
  VERSION_SUFFIX: '-my',

  // true -> показать вообще все источники, включая спрятанные автором (перекрывает KEEP)
  UNLOCK_ALL: false,

  UPSTREAM_URL: 'https://raw.githubusercontent.com/nb557/plugins/main/online_mod.js',
  UPSTREAM_FILE: 'online_mod.js',
};
/* ══════════════════════════════════════════════════════════════ */

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const say = (m) => console.log(m);

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'lampa-mod-builder' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

/* ── обход AST ───────────────────────────────────────────────── */
function walk(node, cb, parent) {
  if (!node || typeof node.type !== 'string') return;
  cb(node, parent);
  for (const k in node) {
    if (k === 'start' || k === 'end' || k === 'type' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, cb, node));
    else if (v && typeof v.type === 'string') walk(v, cb, node);
  }
}

function parse(src) {
  return acorn.parse(src, { ecmaVersion: 'latest' });
}

/* ── применяем список правок (диапазоны) к тексту ────────────── */
function applyEdits(src, edits) {
  return edits
    .sort((a, b) => b.start - a.start)
    .reduce((acc, e) => acc.slice(0, e.start) + (e.text || '') + acc.slice(e.end), src);
}

/* ── главная правка ─────────────────────────────────────────── */
function patch(src, opts) {
  const ast = parse(src);
  const iife = ast.body[0].expression.callee; // (function(){ ... })()
  const body = iife.body.body;
  const edits = [];
  const removedFns = [];

  const fnByName = {};
  body.forEach((n) => { if (n.type === 'FunctionDeclaration' && n.id) fnByName[n.id.name] = n; });

  const keep = CONFIG.UNLOCK_ALL ? null : CONFIG.KEEP.slice();
  const ALL_SOURCES = ['lumex', 'lumex2', 'rezka2', 'kinobase', 'collaps', 'collaps-dash', 'cdnmovies', 'filmix',
    'zetflix', 'fancdn', 'fancdn2', 'fanserials', 'videoseed', 'vibix', 'redheadsound', 'redheadsound-dash',
    'cdnvideohub', 'anilibria', 'anilibria2', 'animelib', 'kodik', 'alloha', 'kinopub'];

  /* --- 1. находим реестр источников ---
   * До сборки автора 10.10.2026 это был `var all_sources = [ {...}, ... ]`.
   * Теперь автор собирает его из реестра: `var Balancers = [...]` +
   * `all_sources = Balancers.map(...)`. Ищем оба варианта — build.js должен
   * переживать обновление апстрима без правок. */
  let allSourcesArr = null;
  let registryName = '';
  walk(iife, (n) => {
    if (n.type === 'VariableDeclarator' && n.init && n.init.type === 'ArrayExpression' &&
        (n.id.name === 'all_sources' || n.id.name === 'Balancers')) {
      allSourcesArr = n.init;
      registryName = n.id.name;
    }
  });
  if (!allSourcesArr) throw new Error('Не найден реестр источников (all_sources/Balancers) — структура файла автора изменилась');

  const entryName = (el) => {
    if (!el || el.type !== 'ObjectExpression') return null;
    const p = el.properties.find((pr) => pr.key && (pr.key.name === 'name' || pr.key.value === 'name'));
    return p && p.value && p.value.value;
  };
  // в новом реестре один класс может обслуживать два источника
  // (collaps -> «Collaps» и «Collaps (DASH)») — такие классы удалять нельзя
  const entryModule = (el) => {
    if (!el || el.type !== 'ObjectExpression') return null;
    const p = el.properties.find((pr) => pr.key && (pr.key.name === 'module' || pr.key.value === 'module'));
    return p && p.value && p.value.name;
  };
  const registryNames = allSourcesArr.elements.map(entryName).filter(Boolean);
  const removedNames = keep
    ? Array.from(new Set(registryNames.concat(ALL_SOURCES))).filter((n) => !keep.includes(n))
    : [];

  // --- 2. STRIP: пересобираем all_sources только из нужных + удаляем классы ---
  if (opts.strip && keep) {
    const keptEls = allSourcesArr.elements.filter((el) => keep.includes(entryName(el)));
    const usedModules = {};
    keptEls.forEach((el) => { const m = entryModule(el); if (m) usedModules[m] = true; });
    const NL = src.includes('\r\n') ? '\r\n' : '\n';
    const rebuilt = '[' + NL + keptEls.map((el) => '        ' + src.slice(el.start, el.end)).join(',' + NL) + NL + '      ]';
    edits.push({ start: allSourcesArr.start, end: allSourcesArr.end, text: rebuilt });

    removedNames.forEach((name) => {
      const fn = fnByName[name];
      if (fn && !usedModules[name]) {
        edits.push({ start: fn.start, end: fn.end, text: '/* МОИ ПРАВКИ: источник «' + name + '» удалён */' });
        removedFns.push(name);
        /* v15: в сборках автора от 10.10.2026 класс источника обрастает
         * статикой уже ПОСЛЕ объявления (lumex.initSettings = ...,
         * lumex.hideSettings = ...). Если вырезать только функцию, плагин
         * падает при загрузке с «lumex is not defined» — убираем и статику. */
        body.forEach((n) => {
          if (n.type !== 'ExpressionStatement') return;
          const a = n.expression;
          if (!a || a.type !== 'AssignmentExpression') return;
          if (!a.left || a.left.type !== 'MemberExpression') return;
          if (!a.left.object || a.left.object.type !== 'Identifier' || a.left.object.name !== name) return;
          edits.push({ start: n.start, end: n.end, text: '/* МОИ ПРАВКИ: ' + name + '.' + ((a.left.property && (a.left.property.name || a.left.property.value)) || '?') + ' удалён */' });
        });
      }
    });

    // --- 3. чистим настройки от пунктов удалённых источников ---
    if (CONFIG.CLEAN_SETTINGS) {
      const prefixes = [];
      removedNames.forEach((n) => { prefixes.push('online_mod_proxy_' + n); prefixes.push('online_mod_' + n + '_'); });
      const isRemovedKey = (k) => prefixes.some((p) => k === p || k.startsWith(p));
      const initSettings = fnByName['initSettings'];
      if (initSettings) {
        walk(initSettings, (n) => {
          if (n.type !== 'ExpressionStatement') return;
          const a = n.expression;
          if (!a || a.type !== 'AssignmentExpression' || a.operator !== '+=') return;
          if (a.left.type !== 'Identifier' || a.left.name !== 'template') return;
          if (a.right.type !== 'Literal' || typeof a.right.value !== 'string') return;
          const keys = (a.right.value.match(/data-name="([a-z0-9_]+)"/g) || []).map((s) => s.slice(11, -1));
          if (keys.length && keys.every(isRemovedKey)) {
            edits.push({ start: n.start, end: n.end, text: '/* МОИ ПРАВКИ: настройка ' + keys.join(', ') + ' удалена */' });
          }
        });
      }
    }
  }

  let out = applyEdits(src, edits);

  /* --- 4. текстовые вставки (якоря стабильны) --- */
  const NL = out.includes('\r\n') ? '\r\n' : '\n';
  const verMatch = out.match(/var mod_version = '([^']+)'/);
  const upstreamVersion = verMatch ? verMatch[1] : '?';

  const anchorCrlf = "(function () {\r\n    'use strict';\r\n";
  const anchorLf = "(function () {\n    'use strict';\n";
  const useAnchor = out.includes(anchorCrlf) ? anchorCrlf : anchorLf;
  if (!out.includes(useAnchor)) throw new Error('Не найден якорь начала плагина');

  // свои источники из custom_sources.js
  const customFile = path.join(ROOT, 'custom_sources.js');
  const customCode = fs.existsSync(customFile)
    ? fs.readFileSync(customFile, 'utf8').replace(/\r\n/g, '\n').trim()
    : '';
  const extraNames = CONFIG.EXTRA_SOURCES.map((s) => s.name);
  const factories = extraNames
    .map((n) => '        ' + JSON.stringify(n) + ': function (component, object) { return new ' + n + '(component, object); }')
    .join(',' + NL);

  const header = [
    '',
    '    /* ================================================================',
    '     *  МОИ ПРАВКИ — собрано build.js ' + new Date().toISOString().slice(0, 10),
    '     *  версия автора: ' + upstreamVersion + (opts.strip ? ' | лишние источники вырезаны' : ''),
    '     *  Блок можно править руками прямо здесь, он в самом верху файла.',
    '     * ================================================================ */',
    '    var MY_KEEP_SOURCES = ' + JSON.stringify(keep || '__ALL__') + ';',
    '    var MY_DEFAULT_BALANSER = ' + JSON.stringify(CONFIG.DEFAULT_BALANSER) + ';',
    '    var MY_UNLOCK_ALL = ' + (CONFIG.UNLOCK_ALL ? 'true' : 'false') + ';',
    '    var MY_EXTRA_SOURCES = ' + JSON.stringify(CONFIG.EXTRA_SOURCES) + ';',
    '    var _MY_EXTRA_FACTORY = {' + (factories ? NL + factories + NL + '    ' : '') + '};',
    '',
    customCode ? '    /* ---- МОИ ИСТОЧНИКИ (custom_sources.js) ---- */' : '',
    customCode,
    customCode ? '    /* ---- конец моих источников ---- */' : '',
    '    /* ================================================================ */',
    '',
  ].filter((l) => l !== undefined).join(NL);

  out = out.replace(useAnchor, () => useAnchor + header);

  // дефолтный балансер
  if (!out.includes("var default_balanser = 'cdnvideohub';")) throw new Error('Не найден default_balanser');
  out = out.replace("var default_balanser = 'cdnvideohub';", "var default_balanser = MY_DEFAULT_BALANSER || 'cdnvideohub';");

  // рантайм-фильтр (страховка: даже в полной сборке список урезается)
  const filterAnchor = 'var obj_filter_sources = all_sources.filter(function (s) {';
  if (!out.includes(filterAnchor)) throw new Error('Не найден obj_filter_sources');
  const filterCode = [
    '/* МОИ ПРАВКИ: оставляем только нужные источники */',
    '      if (MY_UNLOCK_ALL) {',
    '        all_sources.forEach(function (s) { s.disabled = false; });',
    '      } else if (MY_KEEP_SOURCES !== "__ALL__") {',
    '        all_sources = all_sources.filter(function (s) {',
    '          return MY_KEEP_SOURCES.indexOf(s.name) !== -1;',
    '        });',
    '      }',
    '      for (var _mi = 0; _mi < MY_EXTRA_SOURCES.length; _mi++) {',
    '        var _mx = MY_EXTRA_SOURCES[_mi];',
    '        if (_mx && _mx.name && typeof _MY_EXTRA_FACTORY[_mx.name] === "function") {',
    '          all_sources.push({',
    '            name: _mx.name,',
    '            title: _mx.title || _mx.name,',
    '            source: _MY_EXTRA_FACTORY[_mx.name](this, object),',
    '            search: !!_mx.search,',
    '            kp: !!_mx.kp,',
    '            imdb: !!_mx.imdb',
    '          });',
    '        }',
    '      }',
    '      if (all_sources.length && all_sources.map(function (s) { return s.name; }).indexOf(default_balanser) === -1) {',
    '        default_balanser = all_sources[0].name;',
    '      }',
    '      /* конец моих правок */',
    '      ',
  ].join(NL);
  out = out.replace(filterAnchor, filterCode + filterAnchor);

  // подпись в названии
  if (CONFIG.TITLE_SUFFIX) {
    const suffix = CONFIG.TITLE_SUFFIX.replace(/'/g, "\\'");
    const blockRe = /(online_mod_title_full:\s*\{)([\s\S]*?)(\r?\n\s*\},)/;
    const m = out.match(blockRe);
    if (m) {
      const body = m[2].replace(/((?:ru|uk|be|en|zh):\s*')([^']*)(')/g, (_s, a, val, c) => a + val + suffix + c);
      out = out.replace(blockRe, m[1] + body + m[3]);
    }
  }

  // метка версии
  if (CONFIG.VERSION_SUFFIX) {
    out = out.replace(/var mod_version = '([^']*)';/, (m0, v) => "var mod_version = '" + v + CONFIG.VERSION_SUFFIX + "';");
  }

  // Filmix
  const filmixKept = keep === null || keep.includes('filmix');
  if (CONFIG.DISABLE_FILMIX && !filmixKept) {
    out = out.replace(/^(\s*)initFilmix\(\);/m, '$1/* МОИ ПРАВКИ: Filmix отключён */');
  }

  return { code: out, upstreamVersion, removedNames, removedFns, strip: !!opts.strip };
}

/* ── самопроверка результата ─────────────────────────────────── */
function verify(code, removedFns) {
  const ast = parse(code); // бросит исключение при синтаксической ошибке
  const used = new Set();
  walk(ast, (n) => {
    if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.callee.type === 'Identifier') used.add(n.callee.name);
  });
  const dangling = removedFns.filter((f) => used.has(f));
  return { ok: dangling.length === 0, dangling };
}

/* ── запуск ──────────────────────────────────────────────────── */
(async () => {
  let src;
  try {
    say('↓ качаю исходник автора...');
    src = await download(CONFIG.UPSTREAM_URL);
    fs.writeFileSync(path.join(ROOT, CONFIG.UPSTREAM_FILE), src);
  } catch (e) {
    say('! скачать не удалось (' + e.message + ') — беру локальный ' + CONFIG.UPSTREAM_FILE);
    src = fs.readFileSync(path.join(ROOT, CONFIG.UPSTREAM_FILE), 'utf8');
  }
  say('  исходник: ' + Math.round(src.length / 1024) + ' КБ');

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

  // полная сборка (без вырезания кода)
  const full = patch(src, { strip: false });
  const vFull = verify(full.code, []);
  if (!vFull.ok) throw new Error('полная сборка не прошла проверку: ' + vFull.dangling.join(', '));
  fs.writeFileSync(path.join(DIST, 'online_mod.full.js'), full.code);

  // облегчённая сборка
  let published = 'online_mod.full.js';
  if (CONFIG.STRIP_DEAD_CODE) {
    const lite = patch(src, { strip: true });
    let v;
    try { v = verify(lite.code, lite.removedFns); }
    catch (err) { say('✖ облегчённая сборка сломала синтаксис: ' + err.message); v = { ok: false, dangling: [] }; }
    if (v.ok) {
      fs.writeFileSync(path.join(DIST, 'online_mod.js'), lite.code);
      published = 'online_mod.js';
      say('✂ вырезано источников: ' + lite.removedFns.length);
    } else {
      say('✖ найдены ссылки на удалённый код: ' + v.dangling.join(', '));
      say('  -> публикую полную сборку вместо облегчённой');
      fs.copyFileSync(path.join(DIST, 'online_mod.full.js'), path.join(DIST, 'online_mod.js'));
    }
  } else {
    fs.copyFileSync(path.join(DIST, 'online_mod.full.js'), path.join(DIST, 'online_mod.js'));
  }

  say('');
  say('Версия автора:       ' + full.upstreamVersion);
  say('Оставлены:           ' + (CONFIG.UNLOCK_ALL ? 'ВСЕ' : CONFIG.KEEP.join(', ')));
  say('По умолчанию:        ' + CONFIG.DEFAULT_BALANSER);
  if (CONFIG.EXTRA_SOURCES.length) say('Свои источники:      ' + CONFIG.EXTRA_SOURCES.map((s) => s.title || s.name).join(', '));
  say('');
  ['online_mod.js', 'online_mod.full.js'].forEach((f) => {
    const p = path.join(DIST, f);
    if (fs.existsSync(p)) say('dist/' + f.padEnd(20) + Math.round(fs.statSync(p).size / 1024) + ' КБ' + (f === published ? '   ← ЭТОТ публикуем' : ''));
  });
  say('');
  say('Проверки пройдены: синтаксис ✔, висячих ссылок нет ✔');
})().catch((e) => { console.error('ОШИБКА СБОРКИ:', e.message); process.exit(1); });
