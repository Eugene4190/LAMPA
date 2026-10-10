/*
 * Личный прокси-воркер для KinoKino (Kinokino.win / Collaps CDN).
 * Решает три блокировки источника:
 *   423 — CDN блокирует Origin=lampa.mx (встроенный плеер Lampa);
 *   503 — CDN блокирует User-Agent webOS-телевизоров (WebAppManager);
 *   410 — CDN ротировает токены: старые ссылки сегментов умирают прямо во время
 *         просмотра. Воркер при 410 сам перечитывает свежий embed и подставляет
 *         новые токены для того же сегмента («самолечение»).
 * Плюс отдаёт CORS (*) и переписывает все ссылки внутри плейлистов сам на себя,
 * чтобы сегменты тоже шли через прокси.
 * v3: «распутывание» матрёшки — если CDN-кэш отдаёт плейлист со ссылками уже
 * на воркер (двойная обёртка -> fragLoadError у плеера), воркер спускается
 * к исходной ссылке и больше не оборачивает собственные ссылки.
 * v5: обрывает петлю наращивания слоёв: слои снимаются ДО запроса, редиректы
 * ведутся вручную со снятием слоёв с Location; regex относительных строк не
 * трогает абсолютные URL.
 * v4: распутывает обёртки ЛЮБОГО воркера (включая удалённые — кэш CDN умеет
 * отдавать ссылки на мёртвые адреса, это 404 -> fragLoadError); самолечение
 * ссылок при ЛЮБОЙ ошибке upstream; журнал последних запросов: GET /debuglog
 * (плееру путь не мешает: нужен именно адрес .../debuglog без enc2).
 *
 * ДЕПЛОЙ (бесплатно, без копипасты): Cloudflare dashboard → Workers & Pages →
 * Create → Import from GitHub → репозиторий LAMPA (Cloudflare увидит
 * wrangler.toml и точку входа) → Deploy. Адрес вида
 * https://kinokino-xxx.workers.dev вписать в Lampa: Настройки →
 * Онлайн Мод (my) → «Использовать альтернативный прокси» + «Альтернативный
 * прокси». Обновляется сам при каждом пуше в main.
 * (Код совместим и с Deno Deploy тем же файлом: deno.com/deploy → Deploy from
 * GitHub repository → LAMPA → Entry point: kinokino_worker.js.)
 */
const LOG = []; // «чёрный ящик»: последние запросы (для удалённой диагностики)

export default {
  async fetch(request) {
    try {
      return await handle(request);
    } catch (e) {
      return new Response('internal: ' + (e && e.message || e), { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
  },
};

async function handle(request) {
    const ACAO = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: ACAO });

    const url = new URL(request.url);
    const self = url.origin;
    let api = url.href.substring(self.length + 1);
    if (api === 'debuglog') {
      return new Response(JSON.stringify(LOG, null, 1), { headers: ACAO });
    }
    if (!api.startsWith('enc2/')) {
      return new Response('kinokino worker ok', { headers: ACAO });
    }

    // v7: плееры (VLC, Mi Video, WebView/hls.js) перед запросом могут пере- или
    // докодировать %XX в ссылке (%2B -> %252B и т.п.) — раньше воркер падал с 500.
    // Терпимо снимаем слои кодирования, понимаем base64url (-_) и стандартный
    // base64 (+/), на мусоре отвечаем 400 вместо краха.
    const segAll = api.substring(5);
    const tryB64 = (x) => {
      try {
        let b = x.replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const c = atob(b);
        return c && (c.indexOf('://') !== -1 || c.indexOf('param/') === 0) ? c : null;
      } catch (e) { return null; }
    };
    const decodeMeta = (x) => {
      let s = x;
      for (let i = 0; i < 4; i++) {
        const m = tryB64(s.indexOf('%') !== -1 ? decodeURIComponent(s) : s) ||
                  (s.indexOf('%') !== -1 ? tryB64(s) : null);
        if (m) return m;
        try { s = decodeURIComponent(s); } catch (e) { break; }
      }
      return null;
    };
    const head = segAll.split('/')[0];
    const meta = decodeMeta(head) ||
                 (segAll.lastIndexOf('/') > 0 ? decodeMeta(segAll.substring(0, segAll.lastIndexOf('/'))) : null) ||
                 decodeMeta(segAll);
    if (!meta) return new Response('bad link', { status: 400, headers: ACAO });
    const params = {};
    let rest = meta;
    while (rest.indexOf('param/') === 0) {
      const p = rest.indexOf('/', 6);
      const kv = rest.substring(6, p === -1 ? rest.length : p);
      const eq = kv.indexOf('=');
      if (eq > 0) params[kv.substring(0, eq)] = decodeURIComponent(kv.substring(eq + 1));
      rest = p === -1 ? '' : rest.substring(p + 1);
    }
    let link = rest;
    if (!link) return new Response('bad link', { status: 400, headers: ACAO });

    // «Распутывание» матрёшки ЛЮБОГО воркера (v4): CDN-кэш источника умеет
    // отдавать плейлисты, в которые закешированы обёрнутые ссылки — в том числе
    // на УДАЛЁННЫЕ воркеры (festive-kestrel и т.п.). Такая ссылка даёт 404/502
    // и fragLoadError у плеера. Спускаемся к исходной ссылке по всем слоям,
    // чей хост содержит /enc2/.
    const selfPrefix = self + '/enc2/';
    const ANY_ENC = /^https?:\/\/[^/]+\/enc2\//;
    const unwrapOne = (u) => {
      try {
        let m = atob(decodeURIComponent(u.substring(u.indexOf('/enc2/') + 6).split('/')[0]));
        while (m.indexOf('param/') === 0) {
          const p = m.indexOf('/', 6);
          m = p === -1 ? '' : m.substring(p + 1);
        }
        return m || u;
      } catch (e) { return u; }
    };
    const unwrap = (u) => {
      for (let g = 0; g < 24 && ANY_ENC.test(u); g++) {
        const inner = unwrapOne(u);
        if (inner === u) break;
        u = inner;
      }
      return u;
    };
    link = unwrap(link);

    const UA = params['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const wrap = (u) => {
      const clean = unwrap(u); // снимает и наши, и чужие/мёртвые обёртки
      if (clean.indexOf(selfPrefix) === 0) return clean;
      let m = 'param/User-Agent=' + encodeURIComponent(UA) + '/';
      if (params.Src) m += 'param/Src=' + encodeURIComponent(params.Src) + '/';
      return self + '/enc2/' + encodeURIComponent(btoa(m + clean)) + '/seg';
    };
    const upstream = async (u, ref) => {
      // v5: CDN-эджи умеют редиректить/кешировать обёрнутые ответы — получается
      // петля наращивания слоёв. Поэтому: сняли все слои ДО запроса и редиректы
      // ведём руками, снимая слои с каждого Location.
      let cur = unwrap(u);
      for (let hop = 0; hop < 6; hop++) {
        const t = new URL(cur);
        const r = await fetch(cur, {
          headers: { 'User-Agent': UA, 'Referer': ref || (t.origin + '/'), 'Accept': '*/*' },
          redirect: 'manual',
        });
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers.get('location');
          try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) {}
          if (!loc) return r;
          cur = unwrap(new URL(loc, cur).href);
          continue;
        }
        return r;
      }
      const t2 = new URL(cur);
      return fetch(cur, {
        headers: { 'User-Agent': UA, 'Referer': ref || (t2.origin + '/'), 'Accept': '*/*' },
        redirect: 'follow',
      });
    };
    const serve = async (res, ofLink) => {
      const ct = res.headers.get('content-type') || 'application/octet-stream';
      if (/mpegurl|mpd|text|json/i.test(ct)) {
        let text = await res.text();
        const base = ofLink.substring(0, ofLink.lastIndexOf('/') + 1);
        const abs = (u) => (u.indexOf('http') === 0 ? u : base + u);
        // абсолютные ссылки -> через воркер
        text = text.replace(/https?:\/\/[^\s"',\\)]+/g, (u) => wrap(u));
        // относительные строки сегментов (не комментарии) -> через воркер
        text = text.replace(/^((?!#)[^\s:]+)$/gm, (u) => wrap(abs(u.trim())));
        // относительные URI= (ключи, аудио-плейлисты) -> через воркер
        text = text.replace(/URI="((?!http|data:)[^"]+)"/g, (m0, u) => 'URI="' + wrap(abs(u)) + '"');
        return new Response(text, { headers: Object.assign({ 'Content-Type': ct, 'Cache-Control': 'no-store' }, ACAO) });
      }
      return new Response(res.body, {
        status: res.status,
        headers: Object.assign({ 'Content-Type': ct, 'Cache-Control': 'public, max-age=300' }, ACAO),
      });
    };

    // 1) обычный запрос
    let res = await upstream(link);

    // 2) «самолечение»: любая ошибка (410/403/404/423/5xx) -> свежий embed ->
    //    свежие токены для того же сегмента
    if (res.status >= 400 && params.Src) {
      try {
        const emb = await upstream(params.Src, 'https://fixtyflux.cfd/');
        const html = await emb.text();
        const mm = html.replace(/\n/g, '').match(/makePlayer\((\{.*?\})\);/);
        const hls = mm && mm[1].match(/hls:\s*"([^"]+)"/);
        if (hls) {
          const mr = await upstream(hls[1]);
          const mtxt = await mr.text();
          const vm = mtxt.match(/#EXT-X-STREAM-INF:[^\n]*\n(https?:\/\/[^\n]+)/);
          if (vm) {
            const vr = await upstream(vm[1]);
            const vtxt = await vr.text();
            const want = '/' + link.split('/').slice(-2).join('/').split('?')[0];
            const lines = vtxt.split('\n').filter((l) => l.trim() && l[0] !== '#');
            for (const l of lines) {
              const cand = l.indexOf('http') === 0 ? l : vm[1].substring(0, vm[1].lastIndexOf('/') + 1) + l;
              if (cand.split('?')[0].endsWith(want)) {
                res = await upstream(cand);
                break;
              }
            }
          }
        }
      } catch (e) { /* остаёмся на исходном ответе */ }
    }

    LOG.push({
      t: new Date().toISOString().substring(11, 19),
      u: link.substring(0, 70),
      s: res.status,
      o: (request.headers.get('origin') || '').substring(0, 24),
    });
    if (LOG.length > 80) LOG.shift();

    if (res.status >= 400) {
      return new Response('upstream ' + res.status, { status: 502, headers: ACAO });
    }
    return serve(res, link);
  }
