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
 * v4: распутывает обёртки ЛЮБОГО воркера (включая удалённые — кэш CDN умеет
 * отдавать ссылки на мёртвые адреса, это 404 -> fragLoadError); самолечение
 * ссылок при ЛЮБОЙ ошибке upstream; журнал последних запросов: GET /debuglog
 * (плееру путь не мешает: нужен именно адрес .../debuglog без enc2).
 *
 * ДЕПЛОЙ (10 минут, бесплатно): deno.com/deploy → Sign in with GitHub →
 * New Project → Deploy from GitHub repository → выбрать LAMPA →
 * Entry point: kinokino_worker.js → Deploy. Скопировать адрес вида
 * https://имя-xxx.deno.dev/ и вписать в Lampa: Настройки → Онлайн Мод (my) →
 * «Использовать альтернативный прокси» + адрес в поле «Альтернативный прокси».
 * (Работает и на Cloudflare Workers тем же кодом, если захочется.)
 */
const LOG = []; // «чёрный ящик»: последние запросы (для удалённой диагностики)

export default {
  async fetch(request) {
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

    let meta = atob(decodeURIComponent(api.substring(5).split('/')[0]));
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
      for (let g = 0; g < 8 && ANY_ENC.test(u); g++) {
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
      const t = new URL(u);
      return fetch(u, {
        headers: { 'User-Agent': UA, 'Referer': ref || (t.origin + '/'), 'Accept': '*/*' },
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
        text = text.replace(/^((?!#)[^\s:][^\s]*)$/gm, (u) => wrap(abs(u.trim())));
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
  },
};
