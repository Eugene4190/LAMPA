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
const LIVE = process.env.WORKER_URL || 'https://lampa.eugene4190.deno.net';
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
      let bb = u.substring(PREFIX.length).split('/')[0].replace(/-/g,'+').replace(/_/g,'/'); while (bb.length%4) bb+='='; u = atob(bb);
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
  const call = async (url) => worker.fetch({ method: 'GET', url, headers: { get: () => null } });

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

  /* ── v15: mono НЕ должен делать видео немым ─────────────────────────────
   * Видеосегменты Collaps не содержат аудиодорожки (в PMT только H.264+ID3),
   * звук — отдельные рендеры #EXT-X-MEDIA. Старый mono вырезал их все →
   * картинка без звука. Теперь mono обязан оставить по одной дорожке
   * (DEFAULT=YES) на группу и сохранить AUDIO="..." у вариантов. */
  r = await call(PREFIX + b64u(meta + 'param/mono=1/' + master) + '/master.m3u8');
  const mono = await r.text();
  const audioLines = mono.split('\n').filter((l) => l.indexOf('#EXT-X-MEDIA:TYPE=AUDIO') === 0);
  const groups = {};
  audioLines.forEach((l) => { const g = (l.match(/GROUP-ID="([^"]*)"/) || [, 'audio'])[1]; groups[g] = (groups[g] || 0) + 1; });
  const groupNames = Object.keys(groups);
  const fullMaster = mtxt;
  const fullAudio = fullMaster.split('\n').filter((l) => l.indexOf('#EXT-X-MEDIA:TYPE=AUDIO') === 0).length;
  ok('v15: mono оставил звук (по одной дорожке на группу)',
    r.status === 200 && audioLines.length === groupNames.length && audioLines.length > 0 && audioLines.length < fullAudio,
    `групп=${groupNames.length} дорожек=${audioLines.length} (в полном мастере ${fullAudio})`);
  ok('v15: mono оставил дорожку по умолчанию (DEFAULT=YES)',
    audioLines.length > 0 && audioLines.every((l) => l.indexOf('DEFAULT=YES') !== -1),
    audioLines.length ? audioLines[0].slice(0, 60) : 'нет дорожек');
  ok('v15: mono не сломал AUDIO="..." у вариантов',
    (mono.match(/,AUDIO="[^"]*"/g) || []).length === (fullMaster.match(/,AUDIO="[^"]*"/g) || []).length,
    `${(mono.match(/,AUDIO="[^"]*"/g) || []).length} из ${(fullMaster.match(/,AUDIO="[^"]*"/g) || []).length}`);

  /* ── v15: самолечение ЗВУКА ───────────────────────────────────────────────
   * CDN-кэш источника отдаёт мастер со stale-токенами отдельных рендеров:
   * аудиосегмент умирает 410, видео при этом идёт — картинка без звука.
   * Проверяем (а) живой аудиосегмент через воркер и (б) что убитый токен
   * аудиодорожки лечится свежим embed-ом. */
  const audioUri = (mtxt.match(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*DEFAULT=YES[^\n]*URI="([^"]+)"/) || [])[1];
  if (audioUri) {
    r = await call(audioUri);
    const atxt = await r.text();
    const aseg = (atxt.split('\n').find((l) => l.trim() && l[0] !== '#') || '').trim();
    if (aseg) {
      r = await call(aseg);
      const ab = Buffer.from(await r.arrayBuffer());
      ok('v15: аудиосегмент через воркер приезжает (будет звук)', r.status === 200 && ab.length > 10000 && ab[0] === 0x47, `status=${r.status} байт=${ab.length}`);
      const poisonedAudio = aseg.replace(/(rt=)[0-9a-f]+/, '$1' + '0'.repeat(64));
      r = await call(poisonedAudio);
      const pb = Buffer.from(await r.arrayBuffer());
      ok('v15: самолечение возвращает звук после 410 (stale-токен дорожки)', r.status === 200 && pb.length > 10000, `status=${r.status} байт=${pb.length}`);
    } else ok('v15: аудиосегмент через воркер приезжает (будет звук)', false, 'в плейлисте дорожки нет сегментов');
  } else ok('v15: аудиосегмент через воркер приезжает (будет звук)', false, 'в мастере нет DEFAULT=YES аудиодорожки');

  /* ── v15: DASH через воркер и его самолечение ────────────────────────────
   * mpd собирает адреса сегментов сам (BaseURL + $Number$), поэтому лечится
   * он иначе: перечитываем mpd и пересобираем адрес из свежего шаблона.
   * Берём тайтл, у которого в Collaps точно есть DASH («Оппенгеймер», 4664634). */
  try {
    const api2 = await fetch('https://fbphdplay.top/api/players?kinopoisk=4664634').then((x) => x.json());
    const iframe2 = api2.data.find((p) => p.type === 'Collaps').iframeUrl;
    const html2 = await (await fetch(iframe2)).text();
    const mpdSrc = html2.replace(/\n/g, '').match(/makePlayer\((\{.*?\})\);/)[1].match(/[^A-Za-z]dash:\s*"([^"]+)"/)[1];
    const meta2 = 'param/User-Agent=' + encodeURIComponent(UA) + '/param/Src=' + encodeURIComponent(iframe2) + '/';
    r = await call(PREFIX + b64u(meta2 + mpdSrc) + '/' + mpdSrc.split('/').pop().split('?')[0]);
    const mpd = await r.text();
    ok('v15: mpd через воркер отдаётся', r.status === 200 && mpd.indexOf('<MPD') !== -1, 'status=' + r.status);
    const base = (mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/) || [])[1];
    const init = ((mpd.match(/initialization="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
    ok('v15: BaseURL mpd завёрнут «папкой» /seg/', /\/enc2\/[^<]*\/seg\/$/.test(base || ''), (base || '').slice(-40));
    if (base && init) {
      r = await call(base + init);
      let bb = Buffer.from(await r.arrayBuffer());
      ok('v15: init-сегмент DASH приезжает (webm 0x1A45DFA3)', r.status === 200 && bb.length > 100 && bb[0] === 0x1a, `status=${r.status} байт=${bb.length}`);
      const poisoned = (base + init).replace(/(rt=)[0-9a-f]+/, '$1' + '0'.repeat(64));
      r = await call(poisoned);
      bb = Buffer.from(await r.arrayBuffer());
      ok('v15: самолечение DASH после 410 (перечитали mpd)', r.status === 200 && bb.length > 100 && bb[0] === 0x1a, `status=${r.status} байт=${bb.length}`);
    } else ok('v15: init-сегмент DASH приезжает (webm 0x1A45DFA3)', false, 'нет BaseURL/initialization');
  } catch (e) {
    ok('v15: mpd через воркер отдаётся', false, e.message);
  }

  let u = segs[0];
  for (let i = 0; i < 2; i++) u = PREFIX + b64u(meta + u) + '/seg';
  r = await call(u);
  body = Buffer.from(await r.arrayBuffer());
  ok('матрёшка x3 распутывается до TS-видео', r.status === 200 && body[0] === 0x47, `status=${r.status} байт=${body.length}`);

  // v4: обёртка МЁРТВОГО воркера (как в отравленном кэше CDN) распутывается до видео
  let orig = segs[0];
  while (orig.indexOf('/enc2/') !== -1) {
    let m = atob(decodeURIComponent(orig.substring(orig.indexOf('/enc2/') + 6).split('/')[0]));
    while (m.indexOf('param/') === 0) { const p = m.indexOf('/', 6); m = p === -1 ? '' : m.substring(p + 1); }
    orig = m;
  }
  const DEAD = 'https://festive-kestrel-8533.eugene4190.deno.net/';
  const poisoned = DEAD + 'enc2/' + b64u(meta + orig) + '/seg';
  r = await call(poisoned);
  body = Buffer.from(await r.arrayBuffer());
  ok('v4: ссылка на мёртвый воркер распутывается до TS-видео', r.status === 200 && body[0] === 0x47, `status=${r.status} байт=${body.length}`);

  r = await call(LIVE.replace(/\/$/, '') + '/debuglog');
  const logtxt = await r.text();
  ok('v4: журнал /debuglog отдаётся', r.status === 200 && logtxt.trim().startsWith('['), logtxt.slice(0, 30));

  console.log('');
  let failed = 0;
  results.forEach((x) => {
    console.log(`  ${x.pass ? '✔' : '✘'} ${x.name}${x.extra ? '  →  ' + x.extra : ''}`);
    if (!x.pass) failed++;
  });
  console.log(failed ? `ПРОВАЛЕНО: ${failed}` : 'ВОRKER V3: ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
