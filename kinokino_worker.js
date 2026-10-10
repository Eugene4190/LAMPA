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
 * v12: МОСТ-КОЛЬЦО: антибот источника банит эдж Cloudflare (422/424), поэтому
 *     воркеру нужен напарник на НЕ-cloudflare ребре (Deno Deploy был таким,
 *     пока его не приостановили). Мостов может быть несколько (BRIDGES):
 *     каждое развёртывание этого файла страхует остальные.
 * v12: честная диагностика: в теле 502 виден ИСХОДНЫЙ код upstream ДО моста.
 * v13: DASH по-настоящему: mpd строит адреса сегментов сам (BaseURL + шаблон
 *     $Number$). Воркер заворачивает BaseURL «папкой» (/seg/ с хвостовым
 *     слэшем), шаблоны $… оставляет СНАРУЖИ обёртки, а всё, что плеер дописал
 *     после /seg (путь сегмента, init, query), добавляет к расшифрованной
 *     ссылке. Без этого KinoKino (DASH) через прокси не играл.
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
const PLUGIN_URL = 'https://cdn.jsdelivr.net/gh/Eugene4190/LAMPA@84112042db7fdd33085d2225c0ed69af66936953/online_mod.full.js';

/* v12: мост-кольцо. Антибот источника (interkh.com) банит эдж Cloudflare
 * кодами 422/424, но пропускает другие ребра (Deno Deploy, Netlify Edge…).
 * Перечисли ВСЕ свои развёртывания этого файла, кроме cloudflare-ного:
 * каждое умеет тянуть upstream само и страхует остальные.
 * Пустые строки игнорируются; свой адрес исключается автоматически. */
const BRIDGES = [
  'https://lampa.eugene4190.deno.net/',  // приостановлен (billing/usage) — оживёт, сам подхватится
  '', // ← сюда можно вписать адрес второго напарника: 'https://ИМЯ.netlify.app/'
].filter(Boolean);

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
    const CLIENT_RANGE = request.headers.get('range');
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
    /* v16: короткая ссылка на плагин: https://lampa-bridge.netlify.app/p */
    if (api === 'p' || api === 'p/' || api === 'plugin') {
      return new Response(null, {
        status: 302,
        headers: Object.assign({ Location: PLUGIN_URL, 'Cache-Control': 'no-store' }, ACAO),
      });
    }
    if (!api.startsWith('enc2/')) {
      return new Response('kinokino worker ok', { headers: ACAO });
    }

    // v11: Range/Content-Length/Content-Range/Accept-Ranges сквозь воркер —
    // нативные плееры ТВ (webOS «Фото и видео») без них не стартуют HLS.
    // v10: ретрай upstream + heal перебирает все варианты/кандидаты сегмента.
    // v9: mono-режим (param/mono=1) — одно потоковое HLS с вшитой дорожкой
    //     для нативных плееров, не умеющих многоголосый HLS Collapsа.
    // v8: мост Cloudflare->Deno (антибот банит эдж CF кодами 422/424, а сети
    //     РБ/БР не видят deno.net; мост соединяет оба плеча).
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

    // v13: DASH-хвост. Плееры (webOS, dash.js) строят адреса сегментов сами:
    // BaseURL + initialization/media из SegmentTemplate. Всё, что пришло
    // после /seg (путь сегмента, init, query), дописываем к расшифрованной
    // ссылке — иначе воркер отдавал бы «папку» вместо сегмента.
    let suffix = '';
    const iSeg = segAll.indexOf('/seg');
    if (iSeg !== -1) suffix = segAll.substring(iSeg + 4);
    if (suffix) {
      try { suffix = decodeURIComponent(suffix); } catch (e) {}
      if (suffix[0] !== '/') suffix = '/' + suffix;
      if (link.endsWith('/') && suffix[0] === '/') suffix = suffix.substring(1);
      link += suffix;
    }

    const DOLLAR = String.fromCharCode(36); // '$' без литерала (безопасно для heredoc/редактур)
    const UA = params['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const wrap = (u) => {
      let clean = unwrap(u); // снимает и наши, и чужие/мёртвые обёртки
      // v13: DASH-шаблоны ($Number$, $Time$…) оставляем СНАРУЖИ обёртки: плеер
      // подставит номера сам, а воркер добавит хвост к расшифрованной ссылке
      let tpl = '';
      const d = clean.indexOf(DOLLAR);
      if (d !== -1) { tpl = clean.substring(d); clean = clean.substring(0, d); }
      const tplTail = (t) => (t ? (t[0] === '/' ? t : '/' + t) : '');
      if (clean.indexOf(selfPrefix) === 0) {
        return clean + (clean.endsWith('/') ? '' : '/seg') + tplTail(tpl);
      }
      let m = 'param/User-Agent=' + encodeURIComponent(UA) + '/';
      if (params.Src) m += 'param/Src=' + encodeURIComponent(params.Src) + '/';
      // v13: BaseURL-«папки» (заканчиваются на /) заворачиваем с хвостовым
      // слэшем после /seg — тогда относительные initialization/media из mpd
      // разрешаются ВНУТРЬ нашей обёртки, а не мимо неё
      const tail = clean.endsWith('/') ? '/seg/' : '/seg';
      return self + '/enc2/' + encodeURIComponent(btoa(m + clean)) + tail + tplTail(tpl);
    };
    const upstream = async (u, ref) => {
      // v10: ретрай через секунду — эджи источника отвечают 410/503 точечно
      let r0;
      try { r0 = await upstreamOnce(u, ref); } catch (e) { r0 = null; }
      if (r0 && r0.status < 400) return r0;
      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r1 = await upstreamOnce(u, ref);
        if (!r0) return r1;
        if (r1.status < 400) return r1;
        return r0;
      } catch (e) { return r0 || new Response('upstream 0', { status: 502 }); }
    };

    // v5: CDN-эджи умеют редиректить/кешировать обёрнутые ответы — получается
    // петля наращивания слоёв. Поэтому: сняли все слои ДО запроса и редиректы
    // ведём руками, снимая слои с каждого Location.
    const upstreamOnce = async (u, ref) => {
      let cur = unwrap(u);
      for (let hop = 0; hop < 6; hop++) {
        const t = new URL(cur);
        const hdrs = { 'User-Agent': UA, 'Referer': ref || (t.origin + '/'), 'Accept': '*/*' };
        // v11: нативные плееры (webOS, ТВ, VLC) шлют Range — пропускаем наверх
        if (CLIENT_RANGE) hdrs['Range'] = CLIENT_RANGE;
        const r = await fetch(cur, {
          headers: hdrs,
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
    // v8-мост: антибот источника банит эдж Cloudflare (422/424), но пропускает
    // другие ребра (Deno, Netlify). v12: мостов несколько — пробуем по очереди.
    const bridge = async (apiPath) => {
      let last = null;
      for (const b of BRIDGES) {
        const bbase = b.endsWith('/') ? b : b + '/';
        if (bbase === self + '/') continue; // себя не мостуем
        try {
          const r = await fetch(bbase + apiPath, {
            headers: { 'User-Agent': UA, 'Accept': '*/*' },
          });
          if (r.status < 400) return r;
          last = r;
        } catch (e) { last = e; }
      }
      if (last && last instanceof Response) return last;
      throw last || new Error('no bridge configured');
    };

    const serve = async (res, ofLink, bridged) => {
      const ct = res.headers.get('content-type') || 'application/octet-stream';
      if (/mpegurl|m3u8|mpd|dash|xml|text|json/i.test(ct)) { // v13: dash+xml раньше пролетал мимо
        let text = await res.text();
        if (bridged) {
          for (const b of BRIDGES) {
            const bbase = b.endsWith('/') ? b : b + '/';
            text = text.split(bbase).join(self + '/');
          }
        }
        /* v15 mono: БЕЗ немого режима. Замерено на «Оппенгеймере» (kp 4664634):
         * видеосегменты Collaps идут вообще без аудиодорожки (в PMT только
         * H.264 0x1b, ID3 0x15 и приватный 0xd6 — 1.9 МБ видео на 11.6 с и ни
         * одного аудио-PID), звук лежит 9 отдельными рендерами AAC в
         * #EXT-X-MEDIA. Старый mono вырезал их все → КАРТИНКА БЕЗ ЗВУКА
         * (ровно то, что слышал пользователь на телефоне). Теперь mono оставляет
         * ОДНУ дорожку на группу (DEFAULT=YES, иначе первую): плеер, не умеющий
         * переключать переводы, всё равно слышит звук, а лишних рендеров нет. */
        if (params.mono === '1') {
          const lns = text.split('\n');
          const groups = {};
          lns.forEach((l) => {
            if (l.indexOf('#EXT-X-MEDIA:TYPE=AUDIO') !== 0) return;
            const gm = l.match(/GROUP-ID="([^"]*)"/);
            const g = gm ? gm[1] : 'audio';
            if (!groups[g]) groups[g] = [];
            groups[g].push(l);
          });
          const keep = {};
          Object.keys(groups).forEach((g) => {
            const arr = groups[g];
            const def = arr.filter((l) => l.indexOf('DEFAULT=YES') !== -1);
            keep[def.length ? def[0] : arr[0]] = true;
          });
          text = lns.filter((l) => l.indexOf('#EXT-X-MEDIA:TYPE=AUDIO') !== 0 || keep[l]).join('\n');
        }
        const base = ofLink.substring(0, ofLink.lastIndexOf('/') + 1);
        const abs = (u) => (u.indexOf('http') === 0 ? u : base + u);
        // абсолютные ссылки -> через воркер
        text = text.replace(/https?:\/\/[^\s"',\\)<>]+/g, (u) => wrap(u));
        // v13: строчные/URI-правки — только HLS; относительные initialization и
        // media из mpd плеер разрешает сам против обёрнутого BaseURL (+ хвост v13)
        if (/mpegurl|m3u8/i.test(ct + ofLink)) {
          text = text.replace(/^((?!#)[^\s:]+)$/gm, (u) => wrap(abs(u.trim())));
          text = text.replace(/URI="((?!http|data:)[^"]+)"/g, (m0, u) => 'URI="' + wrap(abs(u)) + '"');
        }
        return new Response(text, { headers: Object.assign({ 'Content-Type': ct, 'Cache-Control': 'no-store' }, ACAO) });
      }
      const bh = { 'Content-Type': ct, 'Cache-Control': 'public, max-age=300', 'Accept-Ranges': 'bytes' };
      const cl = res.headers.get('content-length');
      if (cl) bh['Content-Length'] = cl;
      const cr = res.headers.get('content-range');
      if (cr) bh['Content-Range'] = cr;
      return new Response(res.body, {
        status: res.status,
        headers: Object.assign(bh, ACAO),
      });
    };

    // 1) обычный запрос
    let res = await upstream(link);
    let via = '';
    const origStatus = res.status; // v12: ИСХОДНЫЙ код до мостов (для диагностики)

    // 1.5) антибот банит наш эдж -> уходим мостом через Deno
    if (res.status === 422 || res.status === 424) {
      try { res = await bridge(api); via = 'bridge'; } catch (e) {}
    }

    /* 2) «самолечение»: любая ошибка (410/403/404/423/5xx) -> свежий embed ->
     *    свежие токены для того же сегмента.
     * v15: лечим и ЗВУК. CDN-кэш источника отдаёт мастер со stale-токенами
     * отдельных рендеров, поэтому аудиосегмент (-aN.ts) умирает с 410, а видео
     * продолжает идти — плеер показывает картинку БЕЗ ЗВУКА (на живом тесте
     * ровно так и вышло). Старое лечение перебирало только видеоварианты
     * (#EXT-X-STREAM-INF), где аудиосегментов нет в принципе. Теперь:
     *   - по имени сегмента определяем семью (-vN видео / -aN аудио) и номер,
     *     сначала перечитываем СВОЙ плейлист (index-aN.m3u8 / index-vN.m3u8);
     *   - для DASH (.webm/.m4s) перечитываем mpd и пересобираем адрес сегмента
     *     из свежего SegmentTemplate ($Number$/init) + свежего BaseURL. */
    if (res.status >= 400 && params.Src) {
      try {
        const emb = await upstream(params.Src, 'https://fixtyflux.cfd/');
        const html = await emb.text();
        const mm = html.replace(/\n/g, '').match(/makePlayer\((\{.*?\})\);/);
        const pbody = mm ? mm[1] : '';
        const want = '/' + link.split('/').slice(-2).join('/').split('?')[0];
        const fam = (want.match(/-([av])\d+\.\w+$/i) || [])[1] || '';
        const famIdx = want.match(/-([av])(\d+)\.\w+$/i);

        const scanPlaylist = async (purl) => {
          const pr = await upstream(purl);
          if (pr.status >= 400) return;
          const ptxt = await pr.text();
          const lines = ptxt.split('\n').filter((l) => l.trim() && l[0] !== '#');
          for (const l of lines) {
            const t = l.trim();
            const cand = t.indexOf('http') === 0 ? t : purl.substring(0, purl.lastIndexOf('/') + 1) + t;
            if (cand.split('?')[0].endsWith(want)) {
              const rr = await upstream(cand);
              if (rr.status < 400) { res = rr; return; }
            }
          }
        };
        const scanAll = async (urls) => {
          for (const u of urls) {
            if (res.status < 400) return;
            try { await scanPlaylist(u); } catch (e) { /* следующий */ }
          }
        };
        // точный плейлист своей семьи (index-a5.m3u8 для seg-3-a5.ts) — первым
        const pickFamily = (urls) => {
          if (famIdx) {
            const exact = urls.filter((u) => u.indexOf('index-' + famIdx[1] + famIdx[2] + '.') !== -1);
            if (exact.length) return exact;
          }
          return urls;
        };

        const hls = pbody.match(/hls:\s*"([^"]+)"/);
        const dashm = pbody.match(/[^A-Za-z]dash:\s*"([^"]+)"/) || pbody.match(/dasha:\s*"([^"]+)"/);

        if (dashm && /\.(webm|m4s|mp4)$/i.test(want)) {
          const dr = await upstream(dashm[1]);
          const dtxt = dr.status < 400 ? await dr.text() : '';
          if (dtxt) {
            const bases = [...dtxt.matchAll(/<BaseURL>([^<]+)<\/BaseURL>/g)].map((x) => x[1]);
            const rel = want.replace(/^\//, '');                    // '4.1268217-0/12.webm'
            const dir = rel.indexOf('/') !== -1 ? rel.substring(0, rel.lastIndexOf('/') + 1) : '';
            const fname = rel.substring(rel.lastIndexOf('/') + 1);   // '12.webm' | 'init.webm'
            const num = fname.split('.')[0];
            const isInit = /^init\./i.test(fname);
            const tpls = [...dtxt.matchAll(/<SegmentTemplate[^>]*>/g)].map((x) => x[0]);
            for (const tp of tpls) {
              if (res.status < 400) break;
              const ini = (tp.match(/initialization="([^"]+)"/) || [])[1] || '';
              const med = (tp.match(/media="([^"]+)"/) || [])[1] || '';
              let cand = '';
              if (isInit) {
                if (ini.split('?')[0] === rel) cand = ini;
              } else if (med && med.split('?')[0].indexOf(dir) === 0) {
                cand = med.split(DOLLAR + 'Number' + DOLLAR).join(num);
                if (cand.split('?')[0] !== rel) cand = '';
              }
              if (!cand) continue;
              for (const b of bases) {
                const full = b.replace(/\/$/, '') + '/' + cand.replace(/&amp;/g, '&');
                const rr = await upstream(full);
                if (rr.status < 400) { res = rr; break; }
              }
            }
          }
        } else if (hls) {
          const mr = await upstream(hls[1]);
          const mtxt = mr.status < 400 ? await mr.text() : '';
          const videos = (mtxt.match(/#EXT-X-STREAM-INF:[^\n]*\n(https?:\/\/[^\n]+)/g) || []).map((x) => x.split('\n')[1].trim());
          const audios = [...mtxt.matchAll(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="(https?:\/\/[^"]+)"/g)].map((x) => x[1]);
          const others = [...mtxt.matchAll(/#EXT-X-MEDIA:[^\n]*URI="(https?:\/\/[^"]+)"/g)]
            .map((x) => x[1]).filter((u) => audios.indexOf(u) === -1);
          const order = fam === 'a'
            ? [pickFamily(audios), videos, audios, others]
            : fam === 'v'
              ? [pickFamily(videos), audios, videos, others]
              : [videos, audios, others];
          for (const group of order) {
            if (res.status < 400) break;
            await scanAll(group);
          }
        }
      } catch (e) { /* остаёмся на исходном ответе */ }
    }

    // 2.5) всё ещё ошибка — последний шанс: мост
    if (res.status >= 400) {
      try { res = await bridge(api); via = via || 'bridge-last'; } catch (e) {}
    }

    LOG.push({
      v: via,
      t: new Date().toISOString().substring(11, 19),
      u: link.substring(0, 70),
      s: res.status,
      o: (request.headers.get('origin') || '').substring(0, 24),
      up: origStatus, // v12: исходный код upstream до мостов
    });
    if (LOG.length > 80) LOG.shift();

    if (res.status >= 400) {
      let head = '';
      try { head = ((await res.clone().text()) || '').replace(/\s+/g, ' ').substring(0, 140); } catch (e) {}
      const chain = origStatus + (via ? ' -> ' + res.status + ' via ' + via : '');
      return new Response('upstream ' + chain + ' | ' + head, { status: 502, headers: ACAO });
    }
    return serve(res, link, via !== '');
  }
