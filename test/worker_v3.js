/*
 * Тест воркера kinokino_worker.js (v3): «распутывание» матрёшки ссылок.
 * Реальная сеть: берёт живой «отравленный» плейлист Коллапса (CDN-кэш отдаёт
 * сегменты уже обёрнутыми в адрес воркера — из-за этого плеер получал текст
 * плейлиста вместо видео и падал с fragLoadError) и проверяет:
 *   - вариант-плейлист через воркер содержит сегменты глубины 1;
 *   - сегмент по одинарной ссылке приезжает TS-видео;
 *   - сегмент по искусственной матрёшке x3 тоже приезжает TS-видео.
 *
 *   node test/worker_v3.js [путь к воркеру]  (по умолчанию kinokino_worker.js)
 *   WORKER_URL=https://имя.deno.net  — боевой воркер для матрёшки-теста
 */
const fs = require('fs');
const path = require('path');

const WORKER_FILE = process.argv[2] || path.join(__dirname, '..', 'kinokino_worker.js');
const LIVE = process.env.WORKER_URL || 'https://graceful-gannet-9372.eugene4190.deno.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const results = [];
const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra: extra || '' });
const b64u = (s) => encodeURIComponent(btoa(s));
const PREFIX = LIVE.replace(/\/$/, '') + '/enc2/';

function depth(u) {
  let d = 0;
  while (u.indexOf(PREFIX) === 0 && d < 9) {
    d++;
    try {
      u = atob(decodeURIComponent(u.substring(PREFIX.length).split('/')[0]));
      while (u.indexOf('param/') === 0) { const p = u.indexOf('/', 6); u = p === -1 ? '' : u.substring(p + 1); }
    } catch (e) { break; }
  }
  return d;
}

(async () => {
  // воркер — ESM-модуль Deno; грузим как .mjs
  const tmp = path.join(require('os').tmpdir(), 'worker_under_test.mjs');
  fs.copyFileSync(WORKER_FILE, tmp);
  const worker = (await import(tmp)).default;
  const call = async (url) => worker.fetch({ method: 'GET', url });

  let r = await call(LIVE.replace(/\/$/, '') + '/');
  ok('воркер отвечает на корне', r.status === 200 && /worker ok/.test(await r.text()), 'status=' + r.status);

  const api = await fetch('https://fbphdplay.top/api/players?imdb=tt1853728').then((x) => x.json());
  const iframe = api.data.find((p) => p.type === 'Collaps').iframeUrl;
  const html = await (await fetch(iframe)).text();
  const master = html.replace(/\n/g, '').match(/makePlayer\((\{.*?\})\);/)[1].match(/hls:\s*"([^"]+)"/)[1];
  const meta = 'param/User-Agent=' + encodeURIComponent(UA) + '/param/Src=' + encodeURIComponent(iframe) + '/';
  const W0 = PREFIX + b64u(meta + master) + '/master.m3u8';

  r = await call(W0);
  const mtxt = await r.text();
  ok('мастер через воркер — плейлист', mtxt.indexOf('#EXTM3U') === 0);
  const W1 = mtxt.split('\n').find((l) => l && l[0] !== '#' && l.indexOf(PREFIX) === 0).trim();

  r = await call(W1);
  const vtxt = await r.text();
  const segs = vtxt.split('\n').filter((l) => l.trim() && l[0] !== '#').map((l) => l.trim());
  const depths = segs.slice(0, 10).map(depth);
  ok('сегменты в варианте обёрнуты ровно один раз', segs.length > 0 && depths.every((d) => d === 1), 'глубины: ' + depths.join(','));

  r = await call(segs[0]);
  let body = Buffer.from(await r.arrayBuffer());
  ok('сегмент приезжает TS-видео (sync 0x47)', r.status === 200 && body.length > 1000 && body[0] === 0x47, `status=${r.status} байт=${body.length}`);

  let u = segs[0];
  for (let i = 0; i < 2; i++) u = PREFIX + b64u(meta + u) + '/seg';
  r = await call(u);
  body = Buffer.from(await r.arrayBuffer());
  ok('матрёшка x3 распутывается до TS-видео', r.status === 200 && body[0] === 0x47, `status=${r.status} байт=${body.length}`);

  console.log('');
  let failed = 0;
  results.forEach((x) => {
    console.log(`  ${x.pass ? '✔' : '✘'} ${x.name}${x.extra ? '  →  ' + x.extra : ''}`);
    if (!x.pass) failed++;
  });
  console.log(failed ? `ПРОВАЛЕНО: ${failed}` : 'ВОRKER V3: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
