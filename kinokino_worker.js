/*
 * Личный прокси-воркер для KinoKino (Cloudflare Workers, бесплатный тариф).
 * Зачем: CDN Collaps (interkh.com) блокирует запросы с Origin=lampa.mx (423)
 * и User-Agent webOS-телевизоров (503). Воркер убирает эти заголовки и
 * проксирует потоки целиком (включая сегменты HLS/DASH — он переписывает
 * ссылки внутри плейлистов сам на себя).
 *
 * Деплой (10 минут): cloudflare.com → Workers & Pages → Create → Hello World →
 * заменить код на этот → Deploy. Затем скопировать адрес вида
 * https://имя.имя-аккаунта.workers.dev и вписать в Lampa:
 * Настройки → Онлайн Мод (my) → «свой прокси» + адрес воркера.
 */
export default {
  async fetch(request) {
    const ACAO = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: ACAO });

    const url = new URL(request.url);
    let api = url.href.substring(url.origin.length + 1);
    if (!api.startsWith('enc2/')) return new Response('kinokino worker ok', { headers: ACAO });

    let dec = atob(decodeURIComponent(api.substring(5).split('/')[0]));
    let ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const m = dec.match(/^param\/User-Agent=([^/]*)\//);
    if (m) { ua = decodeURIComponent(m[1]); dec = dec.substring(m[0].length); }

    const target = new URL(dec);
    const res = await fetch(dec, {
      headers: { 'User-Agent': ua, 'Referer': target.origin + '/', 'Accept': '*/*' },
      redirect: 'follow',
    });

    const ct = res.headers.get('content-type') || 'application/octet-stream';
    if (/mpegurl|mpd|text|json/i.test(ct)) {
      let text = await res.text();
      const self = url.origin;
      text = text.replace(/https?:\/\/[^\s"',\\)]+/g, (u) =>
        self + '/enc2/' + encodeURIComponent(btoa('param/User-Agent=' + ua + '/' + u)) + '/seg');
      return new Response(text, { headers: Object.assign({ 'Content-Type': ct }, ACAO) });
    }
    return new Response(res.body, { headers: Object.assign({ 'Content-Type': ct }, ACAO) });
  },
};
