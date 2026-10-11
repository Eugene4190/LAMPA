//20.09.2026 - Fix

(function () {
    'use strict';

    /* ================================================================
     *  МОИ ПРАВКИ — собрано build.js 2026-10-11 (v15)
     *  версия автора: 20.09.2026 | лишние источники вырезаны
     *  Блок можно править руками прямо здесь, он в самом верху файла.
     * ================================================================ */
    var MY_KEEP_SOURCES = ["rezka2","kodik","cdnvideohub"];
    var MY_DEFAULT_BALANSER = "cdnvideohub";
    var MY_UNLOCK_ALL = false;
    var MY_EXTRA_SOURCES = [{"name":"kinokino","title":"KinoKino","search":false,"kp":true,"imdb":true},{"name":"kinokino_dash","title":"KinoKino (DASH)","search":false,"kp":true,"imdb":true}];
    var _MY_EXTRA_FACTORY = {
        "kinokino": function (component, object) { return new kinokino(component, object); },
        "kinokino_dash": function (component, object) { return new kinokino_dash(component, object); }
    };

    /* ---- МОИ ИСТОЧНИКИ (custom_sources.js) ---- */
// СВОИ ИСТОЧНИКИ. Код отсюда автоматически вставляется внутрь плагина при сборке.
// Добавил класс ниже -> пропиши его в build.js: CONFIG.EXTRA_SOURCES.
// Шаблон класса и описание контракта — в README.md, раздел «Свой источник».

/*
 * KinoKino — источник по мотивам сайта kinokino.win (Flicksbar). Два балансера:
 *   KinoKino         — HLS (играет везде),
 *   KinoKino (DASH)  — DASH 1080p (где он есть; на старых ТВ может не потянуть).
 *
 * Как работает:
 *   1. Запрашивает API сайта: https://fbphdplay.top/api/players?kinopoisk={kp_id}
 *      (или ?imdb={imdb_id}). API открытое, отдаёт Access-Control-Allow-Origin: * —
 *      с телевизора работает напрямую, прокси не нужен.
 *   2. Из ответа берёт iframe плеера Collaps (тип "Collaps", поле iframeUrl)
 *      и скачивает его HTML: там вызов makePlayer({...}) с файлами.
 *   3. Если через сайт не вышло — запасные зеркала Collaps напрямую по ID:
 *      api.ortified.ws/embed/kp/{id} и api.kinogram.best/embed/kp/{id}.
 *   4. Качество подписывается ЧЕСТНО: один раз скачивается master.m3u8 (или .mpd
 *      для DASH) и берётся максимальная реальная высота кадра (у Collaps в JSON
 *      лежит кривая карта qualityByWidth, она занижает качество).
 *   5. Переводы у Collaps — это аудиодорожки ВНУТРИ одного потока (master
 *      multi-audio), поэтому список = одна строка на фильм, а перевод
 *      переключается в плеере кнопкой аудиодорожек. Субтитры RU/EN/UK — там же.
 *   6. Сериалы: фильтр сезонов, серии списком.
 *   7. Свой прокси (Настройки → Онлайн Мод (my) → «Использовать альтернативный
 *      прокси» + «Альтернативный прокси» = адрес воркера kinokino_worker.js):
 *        - адрес нормализуется (пробелы/протокол/слэш на конце — можно вводить
 *          как угодно, «...deno.net» и «...deno.net/» равнозначны);
 *        - все потоки идут через воркер (обходит 423 по Origin lampa.mx,
 *          503 на UA телевизоров, сам оживляет умершие от ротации ссылки);
 *        - на телефоне/в браузере/ПК при живом воркере играем встроенным
 *          плеером Lampa: hls.js для m3u8 и dash.js для mpd — только они
 *          умеют многоголосый поток Collapsа (звук + переключение переводов);
 *        - если воркер не отвечает плейлистом — тихий откат на прямые ссылки;
 *        - DASH-балансер на телефоне отдаёт честный mpd (1080p+, VP9+Opus),
 *          а не 720p HLS: встроенный плеер Lampa поднимает dash.js (MSE).
 *          На webOS/Tizen mpd уходит системному плееру, а при «только Opus»
 *          в mpd — откат на HLS встроенным плеером (иначе видео без звука).
 *
 * Поиск только по ID КиноПоиска/IMDB (по названию API сайта не умеет) —
 * поэтому в CONFIG.EXTRA_SOURCES стоит search:false, kp:true, imdb:true.
 */
function kinokino(component, object) {
  createKinokino.call(this, component, object, false);
}

function kinokino_dash(component, object) {
  createKinokino.call(this, component, object, true);
}

function createKinokino(component, _object, prefer_dash) {
  var network = new Lampa.Reguest();
  var extract = {};
  var object = _object;
  var select_title = '';
  var detected_height = 0;
  var detected_bitrate = 0; // v15: максимум из mpd, кбит/с (для старта dash.js)
  var prefer_http = Lampa.Storage.field('online_mod_prefer_http') === true;

  var API = 'https://fbphdplay.top/api/players';
  var MIRRORS = ['https://api.ortified.ws/embed/', 'https://api.kinogram.best/embed/'];

  var user_agent = Utils.baseUserAgent();
  var prox = component.proxy('collaps');
  var prox_enc = '';

  // свой прокси (Настройки → Онлайн Мод (my) → «Альтернативный прокси»): нужен на webOS/Tizen,
  // где CDN Collaps отдаёт 503 на User-Agent телевизора — воркер подменит UA.
  // Нормализуем ввод пользователя: пробелы, протокол, ОБЯЗАТЕЛЬНЫЙ слэш на конце
  // (proxyLink склеивает proxy + 'enc2/...' — без слэша получается битый хост
  // вида «...deno.netenc2/...» и плеер не открывается)
  var DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  var stream_prox = '';

  if (Lampa.Storage.field('online_mod_proxy_other') === true) {
    stream_prox = (Lampa.Storage.field('online_mod_proxy_other_url') + '').replace(/^\s+|\s+$/g, '');
    if (stream_prox.indexOf('//') === 0) stream_prox = 'https:' + stream_prox;
    else if (stream_prox && stream_prox.indexOf('://') === -1) stream_prox = 'https://' + stream_prox;
    if (stream_prox && stream_prox.charAt(stream_prox.length - 1) !== '/') stream_prox += '/';
  }

  var last_embed = '';

  /* ── v15: КТО играет поток (от этого зависят и звук, и качество) ──────────
   *
   * Измерено на «Оппенгеймере» (kp 4664634), Collaps:
   *   HLS  = 1280x720/640x360, видеосегменты БЕЗ звука (в PMT только H.264
   *          0x1b + ID3 0x15 + приватный 0xd6), звук — 9 отдельных
   *          аудиодорожек AAC в #EXT-X-MEDIA;
   *   DASH = 1920x1080/720/486, VP9 (поле dash) или AV1 (поле dasha) + Opus,
   *          9 дорожек (аудио в DASH у Collaps всегда Opus).
   *
   * Вывод: старый mono-режим («выкинуть #EXT-X-MEDIA, дорожка вшита в видео»)
   * давал КАРТИНКУ БЕЗ ЗВУКА — вшивать там нечего. Именно это и было на
   * телефоне. Многоголосый поток умеют только hls.js и dash.js, а они есть во
   * встроенном плеере Lampa на любой современной платформе (vender/hls/hls.js,
   * vender/dash/dash.js; в Player.url() на .mpd поднимается dashjs).
   * Поэтому играем так:
   *   телефон/браузер/ПК → встроенный плеер Lampa:
   *        KinoKino       = HLS 720p, AAC, переводы переключаются;
   *        KinoKino(DASH) = mpd 1080p+ (VP9+Opus) — то же, что показывает сайт;
   *   webOS/Tizen         → DASH системным плеером (если аудио не только Opus),
   *                         HLS-откат — встроенным (системный многоголосый не тянет);
   *   orsay / нет воркера  → как раньше (системный/внешний плеер).
   * mono больше не запрашиваем: воркер v15 в этом режиме оставляет дорожку по
   * умолчанию, а не вырезает звук целиком (страховка для старых сборок). */
  var tv_native = Lampa.Platform.is('webos') || Lampa.Platform.is('tizen');
  var no_mse = Lampa.Platform.is('orsay');
  var use_mono = false;

  function streamEnc(mono) {
    var e = stream_prox ? 'param/User-Agent=' + encodeURIComponent(DESKTOP_UA) + '/' : '';
    if (e && last_embed) e += 'param/Src=' + encodeURIComponent(last_embed) + '/';
    if (mono) e += 'param/mono=1/';
    return e;
  }

  // v7: свои ссылки на воркер кодируем base64url (алфавит без %, + и /):
  // плееры (VLC, Mi Video, WebView/hls.js) перед запросом перекодируют %XX
  // по-своему и ломали ссылку (воркер падал с 500 -> fragLoadError/0:00).
  // В base64url перекодировать нечего — ссылка доезжает нетронутой.
  function b64url(s) {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function streamName(link) {
    var posEnd = link.lastIndexOf('?');
    var posStart = link.lastIndexOf('://');
    if (posEnd === -1 || posEnd <= posStart) posEnd = link.length;
    var name = link.substring(posStart + 3, posEnd);
    posStart = name.lastIndexOf('/');
    name = posStart !== -1 ? name.substring(posStart + 1) : '';
    return name.replace(/\.(php|asp|aspx|jsp|jspx|cgi|pl|py|rb|env|ini|conf|config|htaccess|htpasswd|git|yml|yaml|sql)$/, '.txt') || 'seg';
  }

  function proxUrl(link, mono) {
    if (!link) return link;
    // v16: воркер уже сам заворачивает абсолютные URL внутри JSON-ответов —
    // не заворачиваем повторно
    if (stream_prox && link.indexOf(stream_prox) === 0) return link;
    if (!stream_prox) {
      // без прокси mono всё равно полезен нативным плеерам: отдаём прямую
      // ссылку, а моно-плейлист попросить не у кого — оставим как есть
      return link;
    }
    return stream_prox + 'enc2/' + b64url(streamEnc(mono) + link) + '/' + streamName(link);
  }

  if (prox) {
    prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
  }

  /* ── v16: CDNVideoHub (VK Video CDN) — те самые 4K-копии, что играет сайт ──
   * API открытое: plapi.cdnvideohub.com/api/v1/player/sv/
   *   playlist?pub=12&aggr=kp&id=<kp>  -> список озвучек с vkId
   *   video/<vkId>                     -> sources: progressive-MP4 на каждую
   *   ступень (4K/2K/1440p/.../144p, звук вшит: AAC/AC3) + HLS-мастер.
   * Токены VK привязаны к IP клиента (srcIp=... в URL), поэтому и API, и
   * сегменты ходят ОДНИМ плечом через наш воркер: IP воркера и есть srcIp.
   * Origin CDN здесь не проверяет (в отличие от копий Alloha).
   * Зачем: сайт kinokino берёт 4K именно отсюда, а не из Collaps; теперь эти
   * же копии лежат в том же балансере KinoKino отдельными пунктами по озвучкам. */
  var VK_API = 'https://plapi.cdnvideohub.com/api/v1/player/sv/';

  /* v16.1: VK-потоки ходят НАПРЯМУЮ, без воркера — и это не лень, а физика:
   * токен VK привязан к IP клиента (srcIp=...), а медиазапросы с заголовком
   * Origin CDN отклоняет (400). Поэтому: API вызываем с устройства (plapi
   * зеркалит Origin в ACAO — CORS открыт), MP4 играем тегом video/нативным
   * плеером без Origin (200, Accept-Ranges: bytes, Range 206). Через воркер
   * это не повторить: у эджа другой IP, чем у токена. */
  /* v16.2: на телефоне/в браузере встроенный плеер шлёт заголовок Origin, а VK
   * CDN такие запросы отбивает (400) — системные плееры ТВ Origin не шлют,
   * потому на ТВ эти же ссылки играют напрямую. Значит: ТВ/orsay — напрямую,
   * телефон/браузер — через воркер, который на каждый запрос сам перевыпускает
   * токен под свой IP (param/vk + param/q), обходя привязку srcIp. */
  function vkWrapUrl(url, label, vkId) {
    if (!url) return url;
    if (!stream_prox) return url;
    if (url.indexOf(stream_prox) === 0) return url;
    return stream_prox + 'enc2/' + b64url(
      'param/User-Agent=' + encodeURIComponent(DESKTOP_UA) +
      '/param/vk=' + vkId +
      '/param/q=' + encodeURIComponent(label) +
      '/' + url
    ) + '/video.mp4';
  }

  function vkQualityMap(sources, vkId, wrapped) {
    var map = [];
    var push = function (label, q, url) {
      if (url) map.push({ label: label, quality: q, file: wrapped ? vkWrapUrl(url, label, vkId) : url });
    };
    /* подписи 2k/4k у CDNVideoHub перепутаны местами (как и у автора плагина) */
    push('4K', 2160, sources.mpeg2kUrl);
    push('2K', 1440, sources.mpeg4kUrl);
    push('1440p', 1440, sources.mpegQhdUrl);
    push('1080p', 1080, sources.mpegFullHdUrl);
    push('720p', 720, sources.mpegHighUrl);
    push('480p', 480, sources.mpegMediumUrl);
    push('360p', 360, sources.mpegLowUrl);
    push('240p', 240, sources.mpegLowestUrl);
    push('144p', 144, sources.mpegTinyUrl);
    /* HLS-мастер VK не трогаем: hls.js ходит XHR-ом с Origin, а VK такие
     * запросы отбивает (400). Лестницы MP4 хватает на все случаи. */
    return map;
  }

  function vkPlaylist(onDone) {
    if (!last_id || isNaN(+last_id)) {
      onDone([]);
      return;
    }
    var d = new Lampa.Reguest();
    d.timeout(10000);
    // plapi зеркалит Origin в ACAO — список озвучек тянем напрямую всегда
    d.native(VK_API + 'playlist?pub=12&aggr=kp&id=' + last_id, function (json) {
      var out = [];
      if (json && json.items && json.items.forEach) {
        json.items.forEach(function (it) {
          if (it && it.vkId) out.push(it);
        });
      }
      onDone(out);
    }, function () {
      onDone([]);
    }, false, {
      dataType: 'json'
    });
  }

  function vkStream(data_id, wrapped, onDone) {
    var d = new Lampa.Reguest();
    d.timeout(10000);
    // список ступеней — напрямую (CORS открыт); важны не URL-токены из него,
    // а сам факт ступеней: воркер перевыпустит токен под свой IP сам
    d.native(VK_API + 'video/' + data_id, function (json) {
      onDone(json && json.sources ? vkQualityMap(json.sources, data_id, wrapped) : []);
    }, function () {
      onDone([]);
    }, false, {
      dataType: 'json'
    });
  }

  /* пункты VK-копий: одна озвучка = один пункт, внутри — меню качества до 4K */
  function vkMovieItems(vk) {
    var is_serial = extract.playlist && extract.playlist.seasons && extract.playlist.seasons.length;
    if (!vk || !vk.length || is_serial) return []; // сериалы — следующим заходом
    return vk.map(function (it) {
      var voice = it.voiceStudio || it.voiceType || 'VK';
      return {
        title: voice,
        quality: '144p ~ 4K',
        info: ' / VK 4K / id: ' + it.vkId,
        kind: 'vk',
        data_id: '' + it.vkId,
        subtitles: false,
        audio_tracks: false
      };
    });
  }

  function vkPlay(element, options) {
    component.loading(true);
    var wrapped = !!stream_prox && !tv_native && !no_mse;
    vkStream(element.data_id, wrapped, function (map) {
      component.loading(false);
      if (!map.length) {
        Lampa.Noty.show('KinoKino: VK-поток не получен (токен или озвучка недоступны)');
        return;
      }
      var quality = {};
      map.forEach(function (m) { quality[m.label] = m.file; });
      var first = {
        url: component.getDefaultQuality(quality, map[0].file),
        quality: component.renameQualityMap(quality),
        timeline: element.timeline,
        title: select_title + ' / ' + element.title,
        subtitles: false
      };
      // MP4 со вшитым звуком играет кто угодно: на ТВ системным плеером,
      // на телефоне/в браузере — встроенным (тег video, без Origin)
      if (options && options.runas) Lampa.Player.runas(options.runas);
      else if (Lampa.Player.runas) {
        if (tv_native) Lampa.Player.runas(Lampa.Platform.is('tizen') ? 'tizen' : 'webos');
        else if (!stream_prox && Lampa.Platform.is('android')) Lampa.Player.runas('android');
        else if (no_mse) Lampa.Player.runas('');
        else Lampa.Player.runas('lampa');
      }
      Lampa.Player.play(first);
      Lampa.Player.playlist([first]);
    });
  }

  // Заголовки для прямого (не через прокси) воспроизведения на Android.
  // Через воркер они не нужны: воркер сам подставляет UA/Referer, а встроенный
  // плеер браузера такие заголовки выставить всё равно не может.
  function makePlayHeaders() {
    return !prox && !stream_prox && Lampa.Platform.is('android') ? {
      'User-Agent': user_agent,
      'Origin': 'https://api.nextembed.ws',
      'Referer': 'https://api.nextembed.ws/'
    } : {};
  }

  var play_headers = makePlayHeaders();
  var filter_items = {};
  var last_id = '';
  var choice = {
    season: 0,
    voice: 0
  };

  function fixUrl(url, add) {
    url = url || '';

    if (url && add) {
      url += atob('JnZw');
    }

    return component.fixLinkProtocol(url, prefer_http, true);
  }

  /* v15: mpd теперь есть кому играть и на телефоне — встроенный плеер Lampa
   * поднимает dash.js (MSE: VP9+Opus), поэтому DASH-балансер на Android больше
   * не уходит в 720p HLS, а честно отдаёт mpd (1080p+, где есть — 4K).
   * Откат на HLS остаётся только там, где mpd физически некому играть:
   * без воркера (прямые ссылки в браузере режут CORS/423) и на orsay (нет MSE). */
  function dashActive() {
    if (!prefer_dash || no_mse) return false;
    return !!stream_prox || tv_native;
  }

  function pickFile(src) {
    if (!src) return '';
    // v15: сначала dash (VP9) — его декодируют и телефоны, и ТВ; dasha (AV1)
    // на большинстве устройств считается программно и тормозит/греет батарею
    return (dashActive() && (src.dash || src.dasha)) || src.hls || '';
  }

  /* ── честная метка качества: смотрим реальный мастер-плейлист ── */
  function probeQuality(url, onDone, force_hls) {
    if (!url) {
      onDone(0, true);
      return;
    }

    network.clear();
    network.timeout(force_hls ? 8000 : (dashActive() ? 15000 : 8000));
    network.native(proxUrl(url, use_mono), function (str) {
      var h = 0;
      var re = (force_hls || !dashActive()) ? /RESOLUTION=\d+x(\d+)/g : /height="(\d+)"/g;
      var m;
      str = str || '';

      while ((m = re.exec(str))) {
        var v = parseInt(m[1]);
        if (v > h) h = v;
      }

      // v15: заодно запоминаем максимальный битрейт потока (кбит/с) — он нужен,
      // чтобы dash.js во встроенном плеере стартовал не с 486p (см. seedDashBitrate)
      if (dashActive() && !force_hls) {
        var rb = /bandwidth="(\d+)"/g;
        var b;
        detected_bitrate = 0;
        while ((b = rb.exec(str))) {
          var kb = Math.round(parseInt(b[1]) / 1000);
          if (kb > detected_bitrate) detected_bitrate = kb;
        }
      }

      // ok = ответ вообще похож на плейлист (если через прокси приехала чушь —
      // воркер мёртв/не тот, и прокси надо сбросить до прямых ссылок)
      var ok = !stream_prox || str.indexOf('#EXTM3U') !== -1 || str.indexOf('<MPD') !== -1 || str.indexOf('MPD') !== -1;
      onDone(h, ok);
    }, function () {
      onDone(0, !stream_prox);
    }, false, {
      dataType: 'text',
      headers: play_headers
    });
  }

  /* ── v14: какое аудио лежит в DASH (LG webOS не декодирует Opus → видео без звука) ── */
  function pickHls(src) {
    if (!src) return '';
    return src.hls || '';
  }

  function probeDashAudio(url, onDone) {
    if (!url) {
      onDone('', 0);
      return;
    }
    var d = new Lampa.Reguest();
    d.timeout(8000);
    d.native(proxUrl(url, false), function (str) {
      str = str || '';
      var codecs = [];
      var re = /<AdaptationSet[^>]*contentType="audio"[^>]*>[\s\S]{0,400}?codecs="([^"]+)"/g;
      var m;
      while ((m = re.exec(str))) if (codecs.indexOf(m[1]) === -1) codecs.push(m[1]);
      onDone(codecs.join(','), 0);
    }, function () {
      onDone('', 0);
    }, false, {
      dataType: 'text',
      headers: play_headers
    });
  }

  /* ── v15.2: dash.js может отсутствовать в конкретной сборке Lampa ────────
   * Lampa поднимает dashjs из vender/dash/dash.js (а при запуске с file:// —
   * с GitHub). Мод-сборки и старые APK могут его не возить, тогда mpd играть
   * нечем и оставалось бы только 720p HLS. Догружаем dash.js с CDN один раз
   * и только когда он реально понадобился; не загрузился — HLS со звуком. */
  var dashjs_loading = false;
  var dashjs_waiters = [];

  function ensureDashJs(onDone) {
    if (typeof dashjs !== 'undefined') {
      onDone(true);
      return;
    }

    dashjs_waiters.push(onDone);
    if (dashjs_loading) return;
    dashjs_loading = true;

    var done = function (ok) {
      var w = dashjs_waiters.splice(0, dashjs_waiters.length);
      for (var i = 0; i < w.length; i++) w[i](ok);
    };
    var urls = [
      'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js',
      'https://unpkg.com/dashjs@4.7.4/dist/dash.all.min.js',
      'https://cdn.jsdelivr.net/gh/yumata/Lampa@main/vender/dash/dash.js'
    ];
    var i = 0;
    var next = function () {
      if (typeof dashjs !== 'undefined') { done(true); return; }
      if (i >= urls.length) { done(false); return; }
      try {
        var sc = document.createElement('script');
        sc.src = urls[i++];
        sc.onload = function () { done(typeof dashjs !== 'undefined'); };
        sc.onerror = function () { next(); };
        (document.head || document.documentElement).appendChild(sc);
      } catch (e) { done(false); }
    };
    setTimeout(function () {
      if (dashjs_loading) { dashjs_loading = false; done(typeof dashjs !== 'undefined'); }
    }, 12000);
    next();
  }

  function qualityLabel(fallback) {
    if (detected_height) return detected_height + 'p';
    return '360p ~ ' + fallback;
  }

  /* ── v15: старт dash.js с нормального качества ────────────────────────────
   * Встроенный плеер Lampa поднимает dash.js и сразу выключает ему ABR
   * (autoSwitchBitrate = false), а стартовое качество dash.js берёт из
   * localStorage['dashjs_video_bitrate'] (свежесть — 6 минут), иначе из
   * дефолта 1000 кбит/с. У Collaps лестница такая: 486p ≈ 2.6 Мбит/с,
   * 720p ≈ 6.4, 1080p ≈ 12.3 — то есть с дефолтом телефон всегда начинал бы
   * с 486p и (при выключенном ABR) так бы и остался.
   * Поэтому перед стартом mpd кладём туда максимум из этого же mpd, НО только
   * если пользователь не выбирал качество сам в последние 5 минут — его выбор
   * всегда важнее нашего дефолта. */
  function seedDashBitrate(kbps) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage || !kbps) return;
      var key = 'dashjs_video_bitrate';
      var raw = localStorage.getItem(key);
      var fresh = false;

      if (raw) {
        var saved = JSON.parse(raw);
        fresh = saved && !isNaN(parseFloat(saved.bitrate)) && Date.now() - parseInt(saved.timestamp, 10) < 300000;
      }

      if (!fresh) localStorage.setItem(key, JSON.stringify({
        bitrate: kbps,
        timestamp: Date.now()
      }));
    } catch (e) {}
  }

  /* ── шаг 1: API сайта (ищем iframe плеера Collaps) ───────────── */
  function apiSearch(kinopoisk_id, onDone) {
    var q = (+kinopoisk_id ? 'kinopoisk=' : 'imdb=') + kinopoisk_id;
    network.clear();
    network.timeout(10000);
    network.native(API + '?' + q, function (json) {
      var iframe = '';

      if (json && json.data && json.data.length) {
        for (var i = 0; i < json.data.length; i++) {
          var p = json.data[i];
          if (p && p.type === 'Collaps' && p.iframeUrl) {
            iframe = p.iframeUrl;
            break;
          }
        }
      }

      onDone(iframe);
    }, function () {
      onDone('');
    }, false, {
      dataType: 'json'
    });
  }

  /* ── шаг 2: качаем embed-ы по очереди, пока не найдётся makePlayer ── */
  function fetchEmbeds(urls, i, onEmpty, attempt) {
    if (!urls || i >= urls.length) {
      onEmpty();
      return;
    }

    network.clear();
    network.timeout(10000);
    network.native(component.proxyLink(urls[i], prox, prox_enc, 'enc2t'), function (str) {
      if (str && str.indexOf('makePlayer(') !== -1) {
        last_embed = urls[i];
        parse(str, attempt);
      } else fetchEmbeds(urls, i + 1, onEmpty, attempt);
    }, function () {
      fetchEmbeds(urls, i + 1, onEmpty, attempt);
    }, false, {
      dataType: 'text',
      headers: play_headers
    });
  }

  function searchBy(kinopoisk_id, onEmpty, attempt) {
    apiSearch(kinopoisk_id, function (iframe) {
      var urls = [];
      if (iframe) urls.push(iframe);

      var api = (+kinopoisk_id ? 'kp/' : 'imdb/') + kinopoisk_id;

      for (var m = 0; m < MIRRORS.length; m++) {
        urls.push(MIRRORS[m] + api);
      }

      fetchEmbeds(urls, 0, onEmpty, attempt || 1);
    });
  }

  /* ── разбор embed-а: makePlayer({...}); ──────────────────────── */
  function parse(str, attempt) {
    component.loading(false);
    str = (str || '').replace(/\n/g, '');
    var find = str.match(/makePlayer\(({.*?})\);/);
    var json;

    try {
      json = find && (0, eval)('"use strict"; (' + find[1] + ');');
    } catch (e) {}

    if (json && (json.playlist || json.source)) {
      extract = json;
      detected_height = 0;

      if (extract.playlist && extract.playlist.seasons) {
        extract.playlist.seasons.sort(function (a, b) {
          return a.season - b.season;
        });
      }

      // CDN источника ротировает токены: часть ссылок периодически отдаёт 410.
      // Проверяем цепочку мастер->вариант->сегмент и, если мертва, тихо
      // перечитываем embed (свежие токены) до 3 раз, прежде чем показать список.
      validateSegments(function (alive) {
        if (alive || (attempt || 1) >= 3) {
          var probe_url = '';
          var probe_hls = '';

          if (extract.source) {
            probe_url = pickFile(extract.source);
            probe_hls = pickHls(extract.source);
          } else if (extract.playlist && extract.playlist.seasons.length && extract.playlist.seasons[0].episodes && extract.playlist.seasons[0].episodes.length) {
            probe_url = pickFile(extract.playlist.seasons[0].episodes[0]);
            probe_hls = pickHls(extract.playlist.seasons[0].episodes[0]);
          }

          var finalize = function (h) {
            detected_height = h;
            filter();
            // v16: один балансер = Collaps + VK 4K-копии сайта
            vkPlaylist(function (vk) {
              append(filtred().concat(vkMovieItems(vk)));
            });
          };

          probeQuality(probe_url, function (h, prox_ok) {
            if (!prox_ok && stream_prox) {
              /* v15.2: один медленный или битый mpd не должен отключать воркер
               * на всей карточке (иначе DASH и звук уезжали в прямые ссылки).
               * Сначала спрашиваем воркер про HLS-мастер: мёртв он действительно,
               * только если и мастер не пришёл. Воркер жив — перечитываем mpd
               * ещё раз (мог просто не уложиться в таймаут мобильной сети). */
              probeQuality(probe_hls || probe_url, function (h2, prox_ok2) {
                if (!prox_ok2) {
                  stream_prox = '';
                  play_headers = makePlayHeaders();
                  probeQuality(probe_url, function (h3) {
                    finalize(h3);
                  });
                } else {
                  probeQuality(probe_url, function (h3, prox_ok3) {
                    finalize(prox_ok3 && h3 ? h3 : (h || h2 || h3));
                  });
                }
              }, true);
            } else finalize(h);
          });
        } else {
          searchBy(last_id, function () {
            filter();
            append(filtred());
          }, (attempt || 1) + 1);
        }
      });
    } else component.emptyForQuery(select_title);
  }

  function statusOnce(url, cb) {
    network.clear();
    network.timeout(8000);
    network.native(url, function (str) {
      cb(str && str.length ? 200 : 0, str || '');
    }, function (a) {
      cb(a && a.status ? a.status : 0, '');
    }, false, {
      dataType: 'text',
      headers: play_headers
    });
  }

  function validateSegments(cb) {
    var first = extract.source || (extract.playlist && extract.playlist.seasons[0] && extract.playlist.seasons[0].episodes[0]) || null;
    var master_url = first ? pickFile(first) : '';

    if (!master_url) {
      cb(true);
      return;
    }

    statusOnce(master_url, function (st, mtxt) {
      if (st !== 200 || !mtxt) {
        cb(false);
        return;
      }

      var m = mtxt.match(/#EXT-X-STREAM-INF:[^\n]*\n(https?:\/\/[^\n]+)/);
      var variant_url = m ? m[1] : master_url;
      statusOnce(variant_url, function (st2, vtxt) {
        if (st2 !== 200 || !vtxt) {
          cb(false);
          return;
        }

        var lines = vtxt.split('\n').filter(function (l) {
          return l.trim() && l.charAt(0) !== '#';
        });
        var seg_url = lines[0] || '';

        if (seg_url.indexOf('http') !== 0) {
          var base = variant_url.substring(0, variant_url.lastIndexOf('/') + 1);
          seg_url = base + seg_url;
        }

        if (!seg_url) {
          cb(true);
          return;
        }

        statusOnce(seg_url, function (st3) {
          cb(st3 === 200);
        });
      });
    });
  }

  /* ── фильтр сезонов ──────────────────────────────────────────── */
  function filter() {
    filter_items = {
      season: [],
      voice: []
    };

    if (extract.playlist && extract.playlist.seasons) {
      extract.playlist.seasons.forEach(function (season) {
        filter_items.season.push(Lampa.Lang.translate('torrent_serial_season') + ' ' + season.season);
      });
    }

    if (!filter_items.season[choice.season]) choice.season = 0;
    component.filter(filter_items, choice);
  }

  /* ── список файлов ───────────────────────────────────────────── */
  function audioNames(audio) {
    var names = audio && audio.names || [];
    var infos = names.map(function (name, index) {
      var order = audio.order && audio.order[index];
      return {
        name: name,
        order: order != null ? order : 1000
      };
    });
    infos.sort(function (a, b) {
      return a.order - b.order;
    });
    return infos.map(function (a) {
      return a.name;
    }).filter(function (name) {
      return name && name !== 'delete';
    });
  }

  function filtred() {
    var filtred = [];
    var fallback = dashActive() ? '1080p' : '720p';

    if (extract.playlist) {
      extract.playlist.seasons.forEach(function (season, i) {
        if (i == choice.season) {
          season.episodes.forEach(function (episode) {
            var names = audioNames(episode.audio);
            var tracks = names.map(function (name) {
              return {
                language: name
              };
            });
            var file = fixUrl(pickFile(episode), true);
            var alt = proxUrl(fixUrl(pickHls(episode), true), use_mono);
            filtred.push({
              title: episode.title,
              quality: qualityLabel(fallback),
              info: names.length ? ' / ' + component.uniqueNamesShortText(names, 80) : '',
              season: season.season,
              episode: parseInt(episode.episode),
              file: proxUrl(file, use_mono),
              alt_file: alt,
              subtitles: episode.cc ? episode.cc.map(function (c) {
                var url = fixUrl(c.url || '');
                return {
                  label: c.name,
                  url: component.processSubs(proxUrl(url, false))
                };
              }) : false,
              audio_tracks: tracks.length ? tracks : false
            });
          });
        }
      });
    } else if (extract.source) {
      var names = audioNames(extract.source.audio);
      var tracks = names.map(function (name) {
        return {
          language: name
        };
      });
      var file = fixUrl(pickFile(extract.source), true);
      var alt = proxUrl(fixUrl(pickHls(extract.source), true), use_mono);
      filtred.push({
        title: extract.title || select_title,
        quality: qualityLabel(fallback),
        info: names.length ? ' / ' + component.uniqueNamesShortText(names, 80) : '',
        file: proxUrl(file, use_mono),
        alt_file: alt,
        subtitles: extract.source.cc ? extract.source.cc.map(function (c) {
          var url = fixUrl(c.url || '');
          return {
            label: c.name,
            url: component.processSubs(proxUrl(url, false))
          };
        }) : false,
        audio_tracks: tracks.length ? tracks : false
      });
    }

    return filtred;
  }

  /* ── показать файлы ──────────────────────────────────────────── */
  function append(items) {
    component.reset();
    var viewed = Lampa.Storage.cache('online_view', 5000, []);
    items.forEach(function (element) {
      var hash = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title].join('') : object.movie.original_title);
      var view = Lampa.Timeline.view(hash);
      var item = Lampa.Template.get('online_mod', element);
      var hash_file = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title, element.title].join('') : object.movie.original_title + 'kinokino');
      element.timeline = view;
      item.append(Lampa.Timeline.render(view));

      if (Lampa.Timeline.details) {
        item.find('.online__quality').append(Lampa.Timeline.details(view, ' / '));
      }

      if (viewed.indexOf(hash_file) !== -1) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
      item.on('hover:enter', function (event, options) {
        if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);

        if (element.kind === 'vk') {
          vkPlay(element, options);
          return;
        }

        if (element.file) {
          var do_play = function (alt_on) {
          var playlist = [];
          var play_file = function (el) { return alt_on && el.alt_file ? el.alt_file : el.file; };
          // v15: что именно сейчас уйдёт в плеер — mpd (DASH) или m3u8 (HLS),
          // и кто будет играть: системный плеер ТВ (только mpd) или встроенный
          var url_now = play_file(element) || '';
          var mpd_now = /\.mpd/i.test(url_now);
          var native_dash = mpd_now && tv_native && !no_mse;

          /* v15: mpd во встроенном плеере играет dash.js (Lampa возит его в
           * vender/dash/dash.js, а при запуске с file:// подгружает с GitHub).
           * Если в этой Lampa dash.js не подгрузился, mpd не сыграет никто —
           * чёрный экран. Тихо уходим на HLS-версию того же потока: там 720p,
           * зато гарантированно со звуком и озвучками. */
          if (!alt_on && mpd_now && !native_dash && element.alt_file && typeof dashjs === 'undefined') {
            ensureDashJs(function (ok) {
              if (ok) {
                do_play(false); // dash.js доехал — играем честный mpd
              } else {
                Lampa.Noty.show('KinoKino: dash.js не загрузился — включаю HLS со звуком (до 720p)');
                do_play(true);
              }
            });
            return;
          }

          var first = {
            url: component.getDefaultQuality(null, play_file(element)),
            subtitles: element.subtitles,
            translate: {
              tracks: element.audio_tracks
            },
            timeline: element.timeline,
            title: element.season ? element.title : select_title + (element.title == select_title ? '' : ' / ' + element.title),
            headers: play_headers,
            // сегменты едут через воркер (лишний хоп) — даём hls.js встроенного
            // плеера запас по таймаутам, чтобы не было fragLoadError на мобильной сети
            hls_manifest_timeout: 20000,
            hls_retry_timeout: 60000
          };

          if (element.season) {
            items.forEach(function (elem) {
              playlist.push({
                url: component.getDefaultQuality(null, play_file(elem)),
                subtitles: elem.subtitles,
                translate: {
                  tracks: elem.audio_tracks
                },
                timeline: elem.timeline,
                title: elem.title,
                headers: play_headers,
                hls_manifest_timeout: 20000,
                hls_retry_timeout: 60000
              });
            });
          } else {
            playlist.push(first);
          }

          if (playlist.length > 1) first.playlist = playlist;

          // v10-диагностика: прямо на устройстве проверяем цепочку
          // мастер -> вариант -> первый сегмент ТОЙ же ссылкой, что уйдёт в
          // плеер, и показываем код в уведомлении:
          // DIAG [W воркер|D напрямую][P mpd|H m3u8][N системный плеер|I встроенный]
          //      ok/master/vari/seg + статус или килобайты
          (function () {
            try {
              var mark = (stream_prox ? 'W' : 'D') + (mpd_now ? 'P' : 'H') + (native_dash ? 'N' : 'I') + ' ' + (detected_height || '?') + 'p';
              var pick = function (txt) {
                var ls = (txt || '').split('\n');
                for (var i = 0; i < ls.length; i++) {
                  var t = ls[i].trim();
                  if (t && t.charAt(0) !== '#') return t;
                }
                return '';
              };
              var d1 = new Lampa.Reguest();
              d1.timeout(12000);
              d1.native(first.url, function (mtxt) {
                // v15.2: у DASH нет «мастер -> вариант»: адреса сегментов mpd
                // строит сам (BaseURL + $Number$). Раньше DIAG на mpd писал
                // «master?» и пугал пользователя. Для mpd считаем репрезентации
                // и аудио-кодек — этого для диагностики хватает.
                if ((mtxt || '').indexOf('<MPD') !== -1) {
                  var reps = (mtxt.match(/<Representation/g) || []).length;
                  var aud = (mtxt.match(/contentType="audio"/g) || []).length;
                  Lampa.Noty.show('DIAG ' + mark + ' mpd ok rep=' + reps + ' aud=' + aud + (/codecs="opus"/.test(mtxt) ? ' opus' : ' aac'));
                  return;
                }
                var vurl = pick(mtxt);
                if (vurl.indexOf('http') !== 0) vurl = '';
                if (!vurl) {
                  Lampa.Noty.show('DIAG ' + mark + ' master?');
                  return;
                }
                var d2 = new Lampa.Reguest();
                d2.timeout(12000);
                d2.native(vurl, function (vtxt) {
                  var surl = pick(vtxt);
                  if (surl && surl.indexOf('http') !== 0) surl = vurl.substring(0, vurl.lastIndexOf('/') + 1) + surl;
                  if (!surl) {
                    Lampa.Noty.show('DIAG ' + mark + ' vari?');
                    return;
                  }
                  var d3 = new Lampa.Reguest();
                  d3.timeout(15000);
                  d3.native(surl, function (s) {
                    Lampa.Noty.show('DIAG ' + mark + ' ok ' + (((s || '').length / 1024) | 0) + 'kb');
                  }, function (e3) {
                    Lampa.Noty.show('DIAG ' + mark + ' seg ' + (e3 && e3.status || 0));
                  }, false, {
                    dataType: 'text',
                    headers: play_headers
                  });
                }, function (e2) {
                  Lampa.Noty.show('DIAG ' + mark + ' vari ' + (e2 && e2.status || 0));
                }, false, {
                  dataType: 'text',
                  headers: play_headers
                });
              }, function (e1) {
                Lampa.Noty.show('DIAG ' + mark + ' master ' + (e1 && e1.status || 0));
              }, false, {
                dataType: 'text',
                headers: play_headers
              });
            } catch (e) {}
          })();

          // Выбор плеера (v15):
          //  - пользователь сам выбрал в контекстном меню — уважаем (options.runas);
          //  - mpd на webOS/Tizen — системный плеер (там hardware-декод VP9/HEVC,
          //    встроенный браузер ТВ слабее);
          //  - всё остальное — встроенный плеер Lampa: только он (hls.js/dash.js)
          //    умеет многоголосый поток Collapsа, то есть ЗВУК + переключение
          //    переводов; на телефоне он же поднимает dash.js и играет mpd
          //    (1080p+, VP9+Opus) вместо 720p HLS;
          //  - без воркера на телефоне прямые ссылки встроенным не достать
          //    (CORS/423 Origin lampa.mx) — там по-старому системный плеер;
          //  - orsay (старые Samsung, без MSE) — как настроено в Lampa.
          if (options && options.runas) Lampa.Player.runas(options.runas);
          else if (Lampa.Player.runas) {
            if (native_dash) Lampa.Player.runas(Lampa.Platform.is('tizen') ? 'tizen' : 'webos');
            else if (!stream_prox && Lampa.Platform.is('android')) Lampa.Player.runas('android');
            else if (no_mse) Lampa.Player.runas('');
            else Lampa.Player.runas('lampa');
          }
          // v15: mpd во встроенном плеере — заранее кладём dash.js стартовый
          // битрейт, иначе он начнёт с 486p и (ABR выключен) так и останется
          if (mpd_now && !native_dash) seedDashBitrate(detected_bitrate || 20000);

          Lampa.Player.play(first);
          Lampa.Player.playlist(playlist);
          };
          // v14: на webOS/Tizen перед стартом DASH смотрим аудио-кодеки mpd:
          // только Opus → системный плеер LG озвучить не сможет → играем HLS
          // (звук есть, честно до 720p) и объясняем это уведомлением
          if (prefer_dash && dashActive() && element.alt_file && tv_native) {
            probeDashAudio(element.file, function (codecs) {
              var has_bad = codecs && codecs.split(',').some(function (c) { return c.indexOf('opus') !== -1; });
              var has_good = codecs && /mp4a|ac-3|ec-3/.test(codecs);
              var opus_only = !!has_bad && !has_good;
              if (opus_only) Lampa.Noty.show('KinoKino: DASH на LG без звука (Opus) — включаю HLS со звуком');
              do_play(opus_only);
            });
          } else {
            do_play(false);
          }

          if (viewed.indexOf(hash_file) == -1) {
            viewed.push(hash_file);
            item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
            Lampa.Storage.set('online_view', viewed);
          }
        } else Lampa.Noty.show(Lampa.Lang.translate('online_mod_nolink'));
      });
      component.append(item);
      component.contextmenu({
        item: item,
        view: view,
        viewed: viewed,
        hash_file: hash_file,
        file: function file(call) {
          call({
            file: element.file
          });
        }
      });
    });
    component.start(true);
  }

  /* ── внешний интерфейс (вызывает компонент плагина) ──────────── */
  this.search = function (_object, kinopoisk_id) {
    object = _object;
    select_title = object.search || object.movie.title;
    last_id = kinopoisk_id;
    searchBy(kinopoisk_id, function () {
      if (!object.clarification && object.movie.imdb_id && kinopoisk_id != object.movie.imdb_id) {
        searchBy(object.movie.imdb_id, function () {
          component.emptyForQuery(select_title);
        });
      } else component.emptyForQuery(select_title);
    });
  };

  this.extendChoice = function (saved) {
    Lampa.Arrays.extend(choice, saved, true);
  };

  this.reset = function () {
    component.reset();
    choice = {
      season: 0,
      voice: 0
    };
    filter();
    append(filtred());
    component.saveChoice(choice);
  };

  this.filter = function (type, a, b) {
    choice[a.stype] = b.index;
    component.reset();
    filter();
    append(filtred());
    component.saveChoice(choice);
  };

  this.destroy = function () {
    network.clear();
    extract = null;
  };
}
    /* ---- конец моих источников ---- */
    /* ================================================================ */

    function startsWith(str, searchString) {
      return str.lastIndexOf(searchString, 0) === 0;
    }

    function endsWith(str, searchString) {
      var start = str.length - searchString.length;
      if (start < 0) return false;
      return str.indexOf(searchString, start) === start;
    }

    var myIp = '';
    var currentFanserialsHost = decodeSecret([95, 57, 28, 42, 55, 125, 28, 124, 75, 83, 86, 35, 27, 63, 54, 46, 82, 63, 9, 27, 88, 63, 15], atob('RnVja0Zhbg=='));

    function salt(input) {
      var str = (input || '') + '';
      var hash = 0;

      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        hash = (hash << 5) - hash + c;
        hash = hash & hash;
      }

      var result = '';

      for (var _i = 0, j = 32 - 3; j >= 0; _i += 3, j -= 3) {
        var x = ((hash >>> _i & 7) << 3) + (hash >>> j & 7);
        result += String.fromCharCode(x < 26 ? 97 + x : x < 52 ? 39 + x : x - 4);
      }

      return result;
    }

    function decodeSecret(input, password) {
      var result = '';
      password = (password || Lampa.Storage.get('online_mod_secret_password', '')) + '';

      if (input && password) {
        var hash = salt('123456789' + password);

        while (hash.length < input.length) {
          hash += hash;
        }

        var i = 0;

        while (i < input.length) {
          result += String.fromCharCode(input[i] ^ hash.charCodeAt(i));
          i++;
        }
      }

      return result;
    }

    function checkDebug() {
      var res = false;
      var origin = window.location.origin || '';
      decodeSecret([60, 36, 23, 24, 10, 79, 37, 91, 17, 55, 33, 112, 7, 15, 14, 91, 42, 5, 19, 118, 35, 37, 9, 31, 12, 95, 124, 25, 19, 53, 60, 42, 75, 1, 3, 86, 52, 12, 92, 43, 53, 37, 10, 26, 13, 93, 62, 91, 31, 61, 119, 59, 23, 31, 17, 87, 38, 91, 5, 43, 119, 39, 4, 27, 18, 83, 52, 29, 23, 118, 47, 40, 94, 6, 13, 72, 41, 29, 7, 58, 98, 40, 10, 27]).split(';').forEach(function (s) {
        res |= endsWith(origin, s);
      });
      return !res;
    }

    function isDebug() {
      return decodeSecret([40, 46, 7, 3, 5]) === 'debug' && checkDebug();
    }

    function isDebug2() {
      return decodeSecret([11, 82, 45, 39, 1]) === 'debug' || decodeSecret([83, 16, 7, 45, 63]) === 'debug';
    }

    function isDebug3() {
      var res = false;
      var origin = window.location.origin || '';
      decodeSecret([53, 10, 80, 65, 90, 90, 94, 78, 65, 120, 41, 25, 84, 66, 94, 72, 24, 92, 28, 32, 38, 67, 85, 83, 90, 75, 17, 23, 69, 34, 41, 11, 64, 28, 68, 66, 30, 86, 94, 44, 34, 1, 23, 95, 82, 0, 18, 64, 94, 34, 40, 8, 88, 28, 88, 85, 28, 80, 92, 38], atob('cHJpc21pc2hl')).split(';').forEach(function (s) {
        res |= endsWith(origin, s);
      });
      return res;
    }

    function rezka2Host() {
      return 'https://rezka.ag';
    }

    function rezka2Mirror() {
      var url = Lampa.Storage.get('online_mod_rezka2_mirror', '') + '';
      if (!url) return 'https://kvk.zone';
      if (url.indexOf('://') == -1) url = 'https://' + url;
      if (url.charAt(url.length - 1) === '/') url = url.substring(0, url.length - 1);
      return url;
    }

    function kinobaseMirror() {
      var url = Lampa.Storage.get('online_mod_kinobase_mirror', '') + '';
      if (!url) return 'https://kinobase.org';
      if (url.indexOf('://') == -1) url = 'https://' + url;
      if (url.charAt(url.length - 1) === '/') url = url.substring(0, url.length - 1);
      return url;
    }

    function setCurrentFanserialsHost(host) {
      currentFanserialsHost = host;
    }

    function getCurrentFanserialsHost() {
      return currentFanserialsHost;
    }

    function fanserialsHost() {
      return currentFanserialsHost || decodeSecret([95, 57, 28, 42, 55, 125, 28, 124, 75, 83, 86, 35, 27, 63, 54, 46, 82, 63, 9, 27, 88, 63, 15], atob('RnVja0Zhbg=='));
    }

    function fancdnHost() {
      return fanserialsHost();
    }

    function filmixHost$1() {
      return 'https://filmix.gg';
    }

    function filmixAppHost() {
      return 'http://filmixapp.cyou';
    }

    function filmixToken(dev_id, token) {
      return '?user_dev_id=' + dev_id + '&user_dev_name=Xiaomi&user_dev_token=' + token + '&user_dev_vendor=Xiaomi&user_dev_os=14&user_dev_apk=2.2.0&app_lang=ru-rRU';
    }

    function filmixUserAgent() {
      return 'okhttp/3.10.0';
    }

    function baseUserAgent() {
      return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
    }

    function vcdnToken() {
      return atob('YXBpX3Rva2VuPQ==') + (isDebug() ? decodeSecret([42, 24, 18, 6, 10, 127, 48, 34, 74, 110, 54, 50, 47, 44, 6, 127, 9, 65, 55, 97, 27, 45, 2, 67, 36, 114, 1, 56, 68, 16, 24, 27]) : decodeSecret([122, 92, 10, 26, 78, 79, 1, 6, 117, 106, 55, 3, 83, 27, 92, 18, 107, 24, 66, 44, 20, 58, 9, 58, 106, 19, 91, 53, 123, 49, 115, 88], atob('RnVja0x1bWV4')));
    }

    function setMyIp(ip) {
      myIp = ip;
    }

    function getMyIp() {
      return myIp;
    }

    function checkMyIp$1(network, onComplite) {
      var ip = getMyIp();

      if (ip) {
        onComplite();
        return;
      }

      network.clear();
      network.timeout(10000);
      network.silent('https://api.ipify.org/?format=json', function (json) {
        if (json.ip) setMyIp(json.ip);
        onComplite();
      }, function (a, c) {
        network.clear();
        network.timeout(10000);
        network.silent(proxy('ip') + 'jsonip', function (json) {
          if (json.ip) setMyIp(json.ip);
          onComplite();
        }, function (a, c) {
          onComplite();
        });
      });
    }

    function proxy(name) {
      var ip = getMyIp() || '';
      var param_ip = Lampa.Storage.field('online_mod_proxy_find_ip') === true ? 'ip' + ip + '/' : '';
      var proxy1 = new Date().getHours() % 2 ? 'https://cors.nb557.workers.dev/' : 'https://cors.fx666.workers.dev/';
      var proxy2 = proxy1;
      var proxy3 = 'https://cors.nb557.deno.net/';
      var proxy_secret = '';
      var proxy_secret_ip = '';

      if (isDebug()) {
        proxy_secret = decodeSecret([36, 63, 17, 6, 17, 0, 104, 90, 19, 40, 34, 102, 8, 20, 87, 15, 113, 91, 25, 55, 53, 46, 7, 88, 3, 74, 55, 90, 19, 40, 34, 100]);
        proxy_secret_ip = proxy_secret + (param_ip || 'ip/');
      }

      var proxy_other = Lampa.Storage.field('online_mod_proxy_other') === true;
      var proxy_other_url = proxy_other ? Lampa.Storage.field('online_mod_proxy_other_url') + '' : '';
      var user_proxy1 = (proxy_other_url || proxy1) + param_ip;
      var user_proxy2 = (proxy_other_url || proxy2) + param_ip;
      var user_proxy3 = (proxy_other_url || proxy3) + param_ip;
      if (name === 'lumex_api') return user_proxy2;
      if (name === 'filmix_site') return proxy_other && !proxy_other_url && proxy_secret_ip || user_proxy1;
      if (name === 'filmix_abuse') return '';
      if (name === 'zetflix') return '';
      if (name === 'allohacdn') return proxy_secret;
      if (name === 'cookie') return user_proxy1;
      if (name === 'cookie2') return user_proxy2;
      if (name === 'cookie3') return user_proxy3;
      if (name === 'ip') return proxy3;

      if (Lampa.Storage.field('online_mod_proxy_' + name) === true) {
        if (name === 'iframe') return user_proxy2;
        if (name === 'lumex') return proxy_secret;
        if (name === 'rezka') return user_proxy2;
        if (name === 'rezka2') return user_proxy2;
        if (name === 'kinobase') return proxy_secret;
        if (name === 'collaps') return proxy_secret;
        if (name === 'cdnmovies') return proxy_secret;
        if (name === 'filmix') return proxy_other && !proxy_other_url && proxy_secret_ip || user_proxy1;
        if (name === 'videodb') return user_proxy2;
        if (name === 'fancdn') return proxy_secret_ip;
        if (name === 'fancdn2') return proxy_secret_ip;
        if (name === 'fanserials') return user_proxy1;
        if (name === 'fanserials_cdn') return proxy_secret;
        if (name === 'videoseed') return proxy_secret;
        if (name === 'vibix') return proxy_secret;
        if (name === 'redheadsound') return user_proxy2;
        if (name === 'cdnvideohub') return proxy_secret;
        if (name === 'anilibria') return user_proxy2;
        if (name === 'anilibria2') return user_proxy1;
        if (name === 'animelib') return proxy_secret;
        if (name === 'kodik') return user_proxy1;
        if (name === 'kinopub') return user_proxy2;
      }

      return '';
    }

    function parseURL(link) {
      var url = {
        href: link,
        protocol: '',
        host: '',
        origin: '',
        pathname: '',
        search: '',
        hash: ''
      };
      var pos = link.indexOf('#');

      if (pos !== -1) {
        url.hash = link.substring(pos);
        link = link.substring(0, pos);
      }

      pos = link.indexOf('?');

      if (pos !== -1) {
        url.search = link.substring(pos);
        link = link.substring(0, pos);
      }

      pos = link.indexOf(':');
      var path_pos = link.indexOf('/');

      if (pos !== -1 && (path_pos === -1 || path_pos > pos)) {
        url.protocol = link.substring(0, pos + 1);
        link = link.substring(pos + 1);
      }

      if (startsWith(link, '//')) {
        pos = link.indexOf('/', 2);

        if (pos !== -1) {
          url.host = link.substring(2, pos);
          link = link.substring(pos);
        } else {
          url.host = link.substring(2);
          link = '/';
        }

        url.origin = url.protocol + '//' + url.host;
      }

      url.pathname = link;
      return url;
    }

    function fixLink(link, referrer) {
      if (link) {
        if (!referrer || link.indexOf('://') !== -1) return link;
        var url = parseURL(referrer);
        if (startsWith(link, '//')) return url.protocol + link;
        if (startsWith(link, '/')) return url.origin + link;
        if (startsWith(link, '?')) return url.origin + url.pathname + link;
        if (startsWith(link, '#')) return url.origin + url.pathname + url.search + link;
        var base = url.origin + url.pathname;
        base = base.substring(0, base.lastIndexOf('/') + 1);
        return base + link;
      }

      return link;
    }

    function fixLinkProtocol(link, prefer_http, replace_protocol) {
      if (link) {
        if (startsWith(link, '//')) {
          return (prefer_http ? 'http:' : 'https:') + link;
        } else if (prefer_http && replace_protocol) {
          return link.replace('https://', 'http://');
        } else if (!prefer_http && replace_protocol === 'full') {
          return link.replace('http://', 'https://');
        }
      }

      return link;
    }

    function proxyLink(link, proxy, proxy_enc, enc) {
      if (link && proxy) {
        if (proxy_enc == null) proxy_enc = '';
        if (enc == null) enc = 'enc';

        if (enc === 'enc') {
          var pos = link.indexOf('/');
          if (pos !== -1 && link.charAt(pos + 1) === '/') pos++;
          var part1 = pos !== -1 ? link.substring(0, pos + 1) : '';
          var part2 = pos !== -1 ? link.substring(pos + 1) : link;
          return proxy + 'enc/' + encodeURIComponent(btoa(proxy_enc + part1)) + '/' + part2;
        }

        if (enc === 'enc1') {
          var _pos = link.lastIndexOf('/');

          var _part = _pos !== -1 ? link.substring(0, _pos + 1) : '';

          var _part2 = _pos !== -1 ? link.substring(_pos + 1) : link;

          return proxy + 'enc1/' + encodeURIComponent(btoa(proxy_enc + _part)) + '/' + _part2;
        }

        if (enc === 'enc2' || enc === 'enc2t') {
          var posEnd = link.lastIndexOf('?');
          var posStart = link.lastIndexOf('://');
          if (posEnd === -1 || posEnd <= posStart) posEnd = link.length;
          if (posStart === -1) posStart = -3;
          var name = link.substring(posStart + 3, posEnd);
          posStart = name.lastIndexOf('/');
          name = posStart !== -1 ? name.substring(posStart + 1) : '';
          name = name.replace(/\.(php|asp|aspx|jsp|jspx|cgi|pl|py|rb|env|ini|conf|config|htaccess|htpasswd|git|yml|yaml|sql)$/, '.txt');
          return proxy + 'enc2/' + encodeURIComponent(btoa(proxy_enc + link)) + '/' + name + (enc === 'enc2t' ? '?jacred.test' : '');
        }

        return proxy + proxy_enc + link;
      }

      return link;
    }

    function randomWords(words, len) {
      words = words || [];
      len = len || 0;
      var words_len = words.length;
      if (!words_len) return '';
      var str = '';

      for (var i = 0; i < len; i++) {
        str += words[Math.floor(Math.random() * words_len)];
      }

      return str;
    }

    function randomChars(chars, len) {
      return randomWords((chars || '').split(''), len);
    }

    function randomHex(len) {
      return randomChars('0123456789abcdef', len);
    }

    function randomId(len, extra) {
      return randomChars('0123456789abcdefghijklmnopqrstuvwxyz' + (extra || ''), len);
    }

    function randomId2(len, extra) {
      return randomChars('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ' + (extra || ''), len);
    }

    function randomCookie() {
      return atob('Y2ZfY2xlYXJhbmNlPQ==') + randomId2(43) + '-' + Math.floor(Date.now() / 1000) + atob('LTEuMi4xLjEt') + randomId2(299, '_.');
    }

    function checkAndroidVersion(needVersion) {
      if (typeof AndroidJS !== 'undefined') {
        try {
          var current = AndroidJS.appVersion().split('-');
          var versionCode = current.pop();

          if (parseInt(versionCode, 10) >= needVersion) {
            return true;
          }
        } catch (e) {}
      }

      return false;
    }

    var Utils = {
      decodeSecret: decodeSecret,
      isDebug: isDebug,
      isDebug2: isDebug2,
      isDebug3: isDebug3,
      rezka2Host: rezka2Host,
      rezka2Mirror: rezka2Mirror,
      kinobaseMirror: kinobaseMirror,
      setCurrentFanserialsHost: setCurrentFanserialsHost,
      getCurrentFanserialsHost: getCurrentFanserialsHost,
      fanserialsHost: fanserialsHost,
      fancdnHost: fancdnHost,
      filmixHost: filmixHost$1,
      filmixAppHost: filmixAppHost,
      filmixToken: filmixToken,
      filmixUserAgent: filmixUserAgent,
      baseUserAgent: baseUserAgent,
      vcdnToken: vcdnToken,
      setMyIp: setMyIp,
      getMyIp: getMyIp,
      checkMyIp: checkMyIp$1,
      proxy: proxy,
      parseURL: parseURL,
      fixLink: fixLink,
      fixLinkProtocol: fixLinkProtocol,
      proxyLink: proxyLink,
      randomWords: randomWords,
      randomChars: randomChars,
      randomHex: randomHex,
      randomId: randomId,
      randomId2: randomId2,
      randomCookie: randomCookie,
      checkAndroidVersion: checkAndroidVersion
    };

    var network$1 = new Lampa.Reguest();
    var cache = {};
    var total_cnt = 0;
    var proxy_cnt = 0;
    var good_cnt = 0;
    var CACHE_SIZE = 100;
    var CACHE_TIME = 1000 * 60 * 60;

    function get(method, oncomplite, onerror) {
      var use_proxy = total_cnt >= 10 && good_cnt > total_cnt / 2;
      if (!use_proxy) total_cnt++;
      var kp_prox = 'https://cors.kp556.workers.dev/';
      var url = 'https://kinopoiskapiunofficial.tech/';
      url += method;
      network$1.timeout(15000);
      network$1.silent((use_proxy ? kp_prox : '') + url, function (json) {
        oncomplite(json);
      }, function (a, c) {
        use_proxy = !use_proxy && (proxy_cnt < 10 || good_cnt > proxy_cnt / 2);

        if (use_proxy && (a.status == 429 || a.status == 451 || a.status == 0 && a.statusText !== 'timeout')) {
          proxy_cnt++;
          network$1.timeout(15000);
          network$1.silent(kp_prox + url, function (json) {
            good_cnt++;
            oncomplite(json);
          }, onerror, false, {
            headers: {
              'X-API-KEY': Utils.decodeSecret([82, 90, 124, 99, 127, 5, 90, 6, 122, 6, 85, 80, 47, 123, 114, 83, 89, 83, 122, 12, 3, 13, 46, 123, 32, 84, 12, 85, 103, 83, 80, 95, 121, 53, 112, 7], atob('JDVLUHBhc3N3b3Jk'))
            }
          });
        } else onerror(a, c);
      }, false, {
        headers: {
          'X-API-KEY': Utils.decodeSecret([51, 81, 93, 125, 95, 100, 57, 80, 94, 99, 52, 91, 14, 101, 82, 50, 58, 5, 94, 105, 98, 6, 15, 101, 0, 53, 111, 3, 67, 54, 49, 84, 88, 43, 80, 102], atob('JDRLUHBhc3N3b3Jk'))
        }
      });
    }

    function getComplite(method, oncomplite) {
      get(method, oncomplite, function () {
        oncomplite(null);
      });
    }

    function getCompliteIf(condition, method, oncomplite) {
      if (condition) getComplite(method, oncomplite);else {
        setTimeout(function () {
          oncomplite(null);
        }, 10);
      }
    }

    function getCache(key) {
      var res = cache[key];

      if (res) {
        var cache_timestamp = new Date().getTime() - CACHE_TIME;
        if (res.timestamp > cache_timestamp) return res.value;

        for (var ID in cache) {
          var node = cache[ID];
          if (!(node && node.timestamp > cache_timestamp)) delete cache[ID];
        }
      }

      return null;
    }

    function setCache(key, value) {
      var timestamp = new Date().getTime();
      var size = Object.keys(cache).length;

      if (size >= CACHE_SIZE) {
        var cache_timestamp = timestamp - CACHE_TIME;

        for (var ID in cache) {
          var node = cache[ID];
          if (!(node && node.timestamp > cache_timestamp)) delete cache[ID];
        }

        size = Object.keys(cache).length;

        if (size >= CACHE_SIZE) {
          var timestamps = [];

          for (var _ID in cache) {
            var _node = cache[_ID];
            timestamps.push(_node && _node.timestamp || 0);
          }

          timestamps.sort(function (a, b) {
            return a - b;
          });
          cache_timestamp = timestamps[Math.floor(timestamps.length / 2)];

          for (var _ID2 in cache) {
            var _node2 = cache[_ID2];
            if (!(_node2 && _node2.timestamp > cache_timestamp)) delete cache[_ID2];
          }
        }
      }

      cache[key] = {
        timestamp: timestamp,
        value: value
      };
    }

    function getFromCache(method, oncomplite, onerror) {
      var json = getCache(method);

      if (json) {
        setTimeout(function () {
          oncomplite(json, true);
        }, 10);
      } else get(method, oncomplite, onerror);
    }

    function clear() {
      network$1.clear();
    }

    var KP = {
      get: get,
      getComplite: getComplite,
      getCompliteIf: getCompliteIf,
      getCache: getCache,
      setCache: setCache,
      getFromCache: getFromCache,
      clear: clear
    };

    /* МОИ ПРАВКИ: источник «lumex» удалён */

    /* МОИ ПРАВКИ: источник «lumex2» удалён */

    function rezka2(component, _object) {
      var network = new Lampa.Reguest();
      var extract = {};
      var object = _object;
      var select_title = '';
      var prefer_http = Lampa.Storage.field('online_mod_prefer_http') === true;
      var prefer_mp4 = Lampa.Storage.field('online_mod_prefer_mp4') === true;
      var proxy_mirror = Lampa.Storage.field('online_mod_proxy_rezka2_mirror') === true;
      var prox = component.proxy('rezka2');
      var host = prox && !proxy_mirror ? Utils.rezka2Host() : Utils.rezka2Mirror();
      var ref = host + '/';
      var logged_in = !(prox || Lampa.Platform.is('android'));
      var user_agent = Utils.baseUserAgent();
      var headers = Lampa.Platform.is('android') ? {
        'Origin': host,
        'Referer': ref,
        'User-Agent': user_agent
      } : {};
      var prox_enc = '';

      if (prox) {
        prox_enc += 'param/Origin=' + encodeURIComponent(host) + '/';
        prox_enc += 'param/Referer=' + encodeURIComponent(ref) + '/';
        prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
      }

      var cookie = Lampa.Storage.get('online_mod_rezka2_cookie', '') + '';
      if (cookie.indexOf('PHPSESSID=') == -1) cookie = 'PHPSESSID=' + Utils.randomId(26) + (cookie ? '; ' + cookie : '');

      if (cookie) {
        if (Lampa.Platform.is('android')) {
          headers.Cookie = cookie;
        }

        if (prox) {
          prox_enc += 'param/Cookie=' + encodeURIComponent(cookie) + '/';
        }
      }

      var embed = ref;
      var filter_items = {};
      var choice = {
        season: 0,
        voice: 0,
        voice_name: '',
        season_id: ''
      };
      var error_message = '';

      function checkErrorForm(str) {
        var login_form = str.match(/<form id="check-form" class="check-form" method="post" action="\/ajax\/login\/">/);

        if (login_form) {
          error_message = Lampa.Lang.translate('online_mod_authorization_required') + ' HDrezka';
          return;
        }

        var error_form = str.match(/(<div class="error-code">[^<]*<div>[^<]*<\/div>[^<]*<\/div>)\s*(<div class="error-title">[^<]*<\/div>)/);

        if (error_form) {
          error_message = ($(error_form[1]).text().trim() || '') + ':\n' + ($(error_form[2]).text().trim() || '');
          return;
        }

        var verify_form = str.match(/<span>MIRROR<\/span>.*<button type="submit" onclick="\$\.cookie(\([^)]*\))/);

        if (verify_form) {
          error_message = Lampa.Lang.translate('online_mod_unsupported_mirror') + ' HDrezka';
          return;
        }

        var anubis_form = str.match(/<script id="anubis_challenge"/);

        if (anubis_form) {
          error_message = Lampa.Lang.translate('online_mod_unsupported_mirror') + ' HDrezka';
          return;
        }

        if (startsWith(str, 'Fatal error:')) {
          error_message = str;
          return;
        }
      }
      /**
       * Поиск
       * @param {Object} _object
       */


      this.search = function (_object, kinopoisk_id, data) {
        var _this = this;

        object = _object;
        select_title = object.search || object.movie.title;
        if (this.wait_similars && data && data[0].is_similars) return getPage(data[0].link);
        error_message = '';
        var search_date = object.search_date || !object.clarification && (object.movie.release_date || object.movie.first_air_date || object.movie.last_air_date) || '0000';
        var search_year = parseInt((search_date + '').slice(0, 4));
        var orig_titles = [];

        if (object.movie.alternative_titles && object.movie.alternative_titles.results) {
          orig_titles = object.movie.alternative_titles.results.map(function (t) {
            return t.title;
          });
        }

        if (object.movie.original_title) orig_titles.push(object.movie.original_title);
        if (object.movie.original_name) orig_titles.push(object.movie.original_name);
        var url = embed + 'engine/ajax/search.php';
        var more_url = embed + 'search/?do=search&subaction=search';

        var query_more = function query_more(query, page, data, callback) {
          var url = more_url + '&q=' + encodeURIComponent(query) + '&page=' + encodeURIComponent(page);
          network.clear();
          network.timeout(10000);
          network["native"](component.proxyLink(url, prox, prox_enc, prox_enc, 'enc2t'), function (str) {
            str = (str || '').replace(/\n/g, '');
            checkErrorForm(str);
            var links = str.match(/<div class="b-content__inline_item-link">\s*<a [^>]*>[^<]*<\/a>\s*<div>[^<]*<\/div>\s*<\/div>/g);
            var have_more = !!str.match(/<a [^>]*>\s*<span class="b-navigation__next\b/);

            if (links && links.length) {
              var items = links.map(function (l) {
                var li = $(l);
                var link = $('a', li);
                var info_div = $('div', li);
                var titl = link.text().trim() || '';
                var info = info_div.text().trim() || '';
                var orig_title = '';
                var year;
                var found = info.match(/^(\d{4})\b/);

                if (found) {
                  year = parseInt(found[1]);
                }

                return {
                  year: year,
                  title: titl,
                  orig_title: orig_title,
                  link: link.attr('href') || ''
                };
              });
              data = data.concat(items);
            }

            if (callback) callback(data, have_more);
          }, function (a, c) {
            component.empty(network.errorDecode(a, c));
          }, false, {
            dataType: 'text',
            withCredentials: logged_in,
            headers: headers
          });
        };

        var search_more = function search_more(params) {
          var items = params.items || [];
          var query = params.query || '';
          var page = params.page || 1;
          query_more(query, page, items, function (items, have_more) {
            if (items && items.length) {
              _this.wait_similars = true;
              items.forEach(function (c) {
                c.is_similars = true;
              });

              if (have_more) {
                component.similars(items, search_more, {
                  items: [],
                  query: query,
                  page: page + 1
                });
              } else {
                component.similars(items);
              }

              component.loading(false);
            } else if (error_message) component.empty(error_message);else component.emptyForQuery(select_title);
          });
        };

        var display = function display(links, have_more, query) {
          if (links && links.length && links.forEach) {
            var is_sure = false;
            var items = links.map(function (l) {
              var li = $(l);
              var link = $('a', li);
              var enty = $('.enty', link);
              var rating = $('.rating', link);
              var titl = enty.text().trim() || '';
              enty.remove();
              rating.remove();
              var alt_titl = link.text().trim() || '';
              var orig_title = '';
              var year;
              var found = alt_titl.match(/\((.*,\s*)?\b(\d{4})(\s*-\s*[\d.]*)?\)$/);

              if (found) {
                if (found[1]) {
                  var found_alt = found[1].match(/^([^а-яА-ЯёЁ]+),/);
                  if (found_alt) orig_title = found_alt[1].trim();
                }

                year = parseInt(found[2]);
              }

              return {
                year: year,
                title: titl,
                orig_title: orig_title,
                link: link.attr('href') || ''
              };
            });
            var cards = items;

            if (cards.length) {
              if (orig_titles.length) {
                var tmp = cards.filter(function (c) {
                  return component.containsAnyTitle([c.orig_title, c.title], orig_titles);
                });

                if (tmp.length) {
                  cards = tmp;
                  is_sure = true;
                }
              }

              if (select_title) {
                var _tmp = cards.filter(function (c) {
                  return component.containsAnyTitle([c.title, c.orig_title], [select_title]);
                });

                if (_tmp.length) {
                  cards = _tmp;
                  is_sure = true;
                }
              }

              if (cards.length > 1 && search_year) {
                var _tmp2 = cards.filter(function (c) {
                  return c.year == search_year;
                });

                if (!_tmp2.length) _tmp2 = cards.filter(function (c) {
                  return c.year && c.year > search_year - 2 && c.year < search_year + 2;
                });
                if (_tmp2.length) cards = _tmp2;
              }
            }

            if (cards.length == 1 && is_sure) {
              if (search_year && cards[0].year) {
                is_sure = cards[0].year > search_year - 2 && cards[0].year < search_year + 2;
              }

              if (is_sure) {
                is_sure = false;

                if (orig_titles.length) {
                  is_sure |= component.equalAnyTitle([cards[0].orig_title, cards[0].title], orig_titles);
                }

                if (select_title) {
                  is_sure |= component.equalAnyTitle([cards[0].title, cards[0].orig_title], [select_title]);
                }
              }
            }

            if (cards.length == 1 && is_sure) getPage(cards[0].link);else if (items.length) {
              _this.wait_similars = true;
              items.forEach(function (c) {
                c.is_similars = true;
              });

              if (have_more) {
                component.similars(items, search_more, {
                  items: [],
                  query: query,
                  page: 1
                });
              } else {
                component.similars(items);
              }

              component.loading(false);
            } else component.emptyForQuery(select_title);
          } else if (error_message) component.empty(error_message);else component.emptyForQuery(select_title);
        };

        var query_search = function query_search(query, data, callback) {
          var postdata = 'q=' + encodeURIComponent(query);
          network.clear();
          network.timeout(10000);
          network["native"](component.proxyLink(url, prox, prox_enc, 'enc2t'), function (str) {
            str = (str || '').replace(/\n/g, '');
            checkErrorForm(str);
            var links = str.match(/<li><a href=.*?<\/li>/g);
            var have_more = str.indexOf('<a class="b-search__live_all"') !== -1;
            if (links && links.length) data = data.concat(links);
            if (callback) callback(data, have_more, query);
          }, function (a, c) {
            if (prox && a.status == 403 && (!a.responseText || a.responseText.indexOf('<div>105</div>') !== -1)) {
              Lampa.Storage.set('online_mod_proxy_rezka2', 'false');
            }

            if (a.status == 403 && a.responseText) {
              var str = (a.responseText || '').replace(/\n/g, '');
              checkErrorForm(str);
            }

            if (error_message) component.empty(error_message);else component.empty(network.errorDecode(a, c));
          }, postdata, {
            dataType: 'text',
            withCredentials: logged_in,
            headers: headers
          });
        };

        var query_title_search = function query_title_search() {
          query_search(component.cleanTitle(select_title), [], function (data, have_more, query) {
            if (data && data.length && data.forEach) display(data, have_more, query);else display([]);
          });
        };

        query_title_search();
      };

      this.extendChoice = function (saved) {
        Lampa.Arrays.extend(choice, saved, true);
      };
      /**
       * Сброс фильтра
       */


      this.reset = function () {
        component.reset();
        choice = {
          season: 0,
          voice: 0,
          voice_name: '',
          season_id: ''
        };
        component.loading(true);
        getEpisodes(success);
        component.saveChoice(choice);
      };
      /**
       * Применить фильтр
       * @param {*} type
       * @param {*} a
       * @param {*} b
       */


      this.filter = function (type, a, b) {
        choice[a.stype] = b.index;
        if (a.stype == 'voice') choice.voice_name = filter_items.voice[b.index];
        if (a.stype == 'season') choice.season_id = filter_items.season_id[b.index];
        component.reset();
        component.loading(true);
        getEpisodes(success);
        component.saveChoice(choice);
        setTimeout(component.closeFilter, 10);
      };
      /**
       * Уничтожить
       */


      this.destroy = function () {
        network.clear();
        extract = null;
      };

      function getPage(url) {
        url = component.fixLink(url, ref);
        network.clear();
        network.timeout(10000);
        network["native"](component.proxyLink(url, prox, prox_enc, 'enc2t'), function (str) {
          extractData(str);

          if (extract.film_id) {
            getEpisodes(success);
          } else if (error_message) component.empty(error_message);else component.emptyForQuery(select_title);
        }, function (a, c) {
          component.empty(network.errorDecode(a, c));
        }, false, {
          dataType: 'text',
          withCredentials: logged_in,
          headers: headers
        });
      }

      function success() {
        component.loading(false);
        filter();
        append(filtred());
      }
      /**
       * Получить данные о фильме
       * @param {String} str
       */


      function extractData(str) {
        extract.voice = [];
        extract.season = [];
        extract.episode = [];
        extract.voice_data = {};
        extract.is_series = false;
        extract.film_id = '';
        extract.favs = '';
        str = (str || '').replace(/\n/g, '');
        checkErrorForm(str);
        var translation = str.match(/<h2>В переводе<\/h2>:<\/td>\s*(<td>.*?<\/td>)/);
        var cdnSeries = str.match(/\.initCDNSeriesEvents\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/);
        var cdnMovie = str.match(/\.initCDNMoviesEvents\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/);
        var devVoiceName;

        if (translation) {
          devVoiceName = $(translation[1]).text().trim();
        }

        if (!devVoiceName) devVoiceName = 'Оригинал';
        var defVoice, defSeason, defEpisode;

        if (cdnSeries) {
          extract.is_series = true;
          extract.film_id = cdnSeries[1];
          defVoice = {
            name: devVoiceName,
            id: cdnSeries[2]
          };
          defSeason = {
            name: 'Сезон ' + cdnSeries[3],
            id: cdnSeries[3]
          };
          defEpisode = {
            name: 'Серия ' + cdnSeries[4],
            season_id: cdnSeries[3],
            episode_id: cdnSeries[4]
          };
        } else if (cdnMovie) {
          extract.film_id = cdnMovie[1];
          defVoice = {
            name: devVoiceName,
            id: cdnMovie[2],
            is_camrip: cdnMovie[3],
            is_ads: cdnMovie[4],
            is_director: cdnMovie[5]
          };
        }

        var voices = str.match(/(<ul id="translators-list".*?<\/ul>)/);

        if (voices) {
          var select = $(voices[1]);
          $('.b-translator__item', select).each(function () {
            var title = ($(this).attr('title') || $(this).text() || '').trim();
            $('img', this).each(function () {
              var lang = ($(this).attr('title') || $(this).attr('alt') || '').trim();
              if (lang && title.indexOf(lang) == -1) title += ' (' + lang + ')';
            });
            extract.voice.push({
              name: title,
              id: $(this).attr('data-translator_id'),
              is_camrip: $(this).attr('data-camrip'),
              is_ads: $(this).attr('data-ads'),
              is_director: $(this).attr('data-director')
            });
          });
        }

        if (!extract.voice.length && defVoice) {
          extract.voice.push(defVoice);
        }

        if (extract.is_series) {
          var seasons = str.match(/(<ul id="simple-seasons-tabs".*?<\/ul>)/);

          if (seasons) {
            var _select = $(seasons[1]);

            $('.b-simple_season__item', _select).each(function () {
              extract.season.push({
                name: $(this).text(),
                id: $(this).attr('data-tab_id')
              });
            });
          }

          if (!extract.season.length && defSeason) {
            extract.season.push(defSeason);
          }

          var episodes = str.match(/(<div id="simple-episodes-tabs".*?<\/div>)/);

          if (episodes) {
            var _select2 = $(episodes[1]);

            $('.b-simple_episode__item', _select2).each(function () {
              extract.episode.push({
                name: $(this).text(),
                season_id: $(this).attr('data-season_id'),
                episode_id: $(this).attr('data-episode_id')
              });
            });
          }

          if (!extract.episode.length && defEpisode) {
            extract.episode.push(defEpisode);
          }
        }

        var favs = str.match(/<input type="hidden" id="ctrl_favs" value="([^"]*)"/);
        if (favs) extract.favs = favs[1];
        var blocked = str.match(/class="b-player__restricted__block_message"/);
        if (blocked) extract.blocked = true;
      }

      function getEpisodes(call) {
        if (extract.is_series) {
          filterVoice();

          if (extract.voice[choice.voice]) {
            var translator_id = extract.voice[choice.voice].id;
            var data = extract.voice_data[translator_id];

            if (data) {
              extract.season = data.season;
              extract.episode = data.episode;
            } else {
              var url = embed + 'ajax/get_cdn_series/?t=' + Date.now();
              var postdata = 'id=' + encodeURIComponent(extract.film_id);
              postdata += '&translator_id=' + encodeURIComponent(translator_id);
              postdata += '&favs=' + encodeURIComponent(extract.favs);
              postdata += '&action=get_episodes';
              network.clear();
              network.timeout(10000);
              network["native"](component.proxyLink(url, prox, prox_enc, 'enc2t'), function (json) {
                extractEpisodes(json, translator_id);
                call();
              }, function (a, c) {
                component.empty(network.errorDecode(a, c));
              }, postdata, {
                withCredentials: logged_in,
                headers: headers
              });
              return;
            }
          }
        }

        call();
      }

      function extractEpisodes(json, translator_id) {
        var data = {
          season: [],
          episode: []
        };

        if (json && json.seasons) {
          var select = $('<ul>' + json.seasons + '</ul>');
          $('.b-simple_season__item', select).each(function () {
            data.season.push({
              name: $(this).text(),
              id: $(this).attr('data-tab_id')
            });
          });
        }

        if (json && json.episodes) {
          var _select3 = $('<div>' + json.episodes + '</div>');

          $('.b-simple_episode__item', _select3).each(function () {
            data.episode.push({
              name: $(this).text(),
              translator_id: translator_id,
              season_id: $(this).attr('data-season_id'),
              episode_id: $(this).attr('data-episode_id')
            });
          });
        }

        extract.voice_data[translator_id] = data;
        extract.season = data.season;
        extract.episode = data.episode;
      }

      function filterVoice() {
        var voice = extract.is_series ? extract.voice.map(function (v) {
          return v.name;
        }) : [];
        if (!voice[choice.voice]) choice.voice = 0;

        if (choice.voice_name) {
          var inx = voice.indexOf(choice.voice_name);
          if (inx == -1) choice.voice = 0;else if (inx !== choice.voice) {
            choice.voice = inx;
          }
        }
      }
      /**
       * Построить фильтр
       */


      function filter() {
        filter_items = {
          season: extract.season.map(function (s) {
            return s.name;
          }),
          season_id: extract.season.map(function (s) {
            return s.id;
          }),
          voice: extract.is_series ? extract.voice.map(function (v) {
            return v.name;
          }) : []
        };
        if (!filter_items.season[choice.season]) choice.season = 0;
        if (!filter_items.voice[choice.voice]) choice.voice = 0;

        if (choice.voice_name) {
          var inx = filter_items.voice.indexOf(choice.voice_name);
          if (inx == -1) choice.voice = 0;else if (inx !== choice.voice) {
            choice.voice = inx;
          }
        }

        if (choice.season_id) {
          var _inx = filter_items.season_id.indexOf(choice.season_id);

          if (_inx == -1) choice.season = 0;else if (_inx !== choice.season) {
            choice.season = _inx;
          }
        }

        component.filter(filter_items, choice);
      }
      /**
       * Получить поток
       * @param {*} element
       */


      function getStream(element, call, error) {
        if (element.stream) return call(element);
        var url = embed + 'ajax/get_cdn_series/?t=' + Date.now();
        var postdata = 'id=' + encodeURIComponent(extract.film_id);

        if (extract.is_series) {
          postdata += '&translator_id=' + encodeURIComponent(element.media.translator_id);
          postdata += '&season=' + encodeURIComponent(element.media.season_id);
          postdata += '&episode=' + encodeURIComponent(element.media.episode_id);
          postdata += '&favs=' + encodeURIComponent(extract.favs);
          postdata += '&action=get_stream';
        } else {
          postdata += '&translator_id=' + encodeURIComponent(element.media.id);
          postdata += '&is_camrip=' + encodeURIComponent(element.media.is_camrip);
          postdata += '&is_ads=' + encodeURIComponent(element.media.is_ads);
          postdata += '&is_director=' + encodeURIComponent(element.media.is_director);
          postdata += '&favs=' + encodeURIComponent(extract.favs);
          postdata += '&action=get_movie';
        }

        network.clear();
        network.timeout(10000);
        network["native"](component.proxyLink(url, prox, prox_enc, 'enc2t'), function (json) {
          if (json && json.url) {
            var video = decode(json.url),
                file = '',
                quality = false;
            var items = extractItems(video);

            if (items && items.length) {
              file = items[0].file;
              var premium_content = json.premium_content || false;
              var prev_file = '';
              quality = {};
              items.forEach(function (item) {
                if (item.label !== '1080p Ultra') {
                  if (prev_file !== '' && prev_file !== item.file) premium_content = false;
                  prev_file = item.file;
                }

                quality[item.label] = item.file;
              });

              if (premium_content) {
                error('Перевод доступен только с HDrezka Premium');
                return;
              }
            }

            if (file) {
              element.stream = file;
              element.qualitys = quality;
              element.subtitles = parseSubtitles(json.subtitle);
              call(element);
            } else error();
          } else error();
        }, function (a, c) {
          error();
        }, postdata, {
          withCredentials: logged_in,
          headers: headers
        });
      }

      function decode(data) {
        if (!startsWith(data, '#')) return data;

        var enc = function enc(str) {
          return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function (match, p1) {
            return String.fromCharCode('0x' + p1);
          }));
        };

        var dec = function dec(str) {
          return decodeURIComponent(atob(str).split('').map(function (c) {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
          }).join(''));
        };

        var trashList = ['$$!!@$$@^!@#$$@', '@@@@@!##!^^^', '####^!!##!@@', '^^^!@##!!##', '$$#!!@#!@##'];
        var x = data.substring(2);
        trashList.forEach(function (trash) {
          x = x.replace('//_//' + enc(trash), '');
        });

        try {
          x = dec(x);
        } catch (e) {
          x = '';
        }

        return x;
      }
      /**
       * Получить потоки
       * @param {String} str
       * @returns array
       */


      function extractItems(str) {
        if (!str) return [];

        try {
          var items = component.parsePlaylist(str).map(function (item) {
            var int_quality = NaN;
            var quality = item.label.match(/(\d\d\d+)/);

            if (quality) {
              int_quality = parseInt(quality[1]);
            } else {
              quality = item.label.match(/(\d+)K/);

              if (quality) {
                int_quality = parseInt(quality[1]) * 1000;
              }
            }

            var links;

            if (prefer_mp4) {
              links = item.links.filter(function (url) {
                return /\.mp4$/i.test(url);
              });
            } else {
              links = item.links.filter(function (url) {
                return /\.m3u8$/i.test(url);
              });
            }

            if (!links.length) links = item.links;
            var link = links[0] || '';
            link = component.fixLinkProtocol(link, prefer_http, 'full');
            return {
              label: item.label,
              quality: int_quality,
              file: component.proxyStream(link, 'rezka2')
            };
          });
          items.sort(function (a, b) {
            if (b.quality > a.quality) return 1;
            if (b.quality < a.quality) return -1;
            if (b.label > a.label) return 1;
            if (b.label < a.label) return -1;
            return 0;
          });
          return items;
        } catch (e) {}

        return [];
      }

      function parseSubtitles(str) {
        var subtitles = [];

        if (str) {
          subtitles = component.parsePlaylist(str).map(function (item) {
            var link = item.links[0] || '';
            link = component.fixLinkProtocol(link, prefer_http, 'full');
            return {
              label: item.label,
              url: component.processSubs(link)
            };
          });
        }

        return subtitles.length ? subtitles : false;
      }
      /**
       * Отфильтровать файлы
       * @returns array
       */


      function filtred() {
        var filtred = [];

        if (extract.is_series) {
          var season_name = filter_items.season[choice.season];
          var season_id;
          extract.season.forEach(function (season) {
            if (season.name == season_name) season_id = season.id;
          });
          var voice = filter_items.voice[choice.voice];
          extract.episode.forEach(function (episode) {
            if (episode.season_id == season_id) {
              filtred.push({
                title: component.formatEpisodeTitle(episode.season_id, null, episode.name),
                quality: '360p ~ 1080p',
                info: ' / ' + voice,
                season: parseInt(episode.season_id),
                episode: parseInt(episode.episode_id),
                media: episode
              });
            }
          });
        } else {
          extract.voice.forEach(function (voice) {
            filtred.push({
              title: voice.name || select_title,
              quality: '360p ~ 1080p',
              info: '',
              media: voice
            });
          });
        }

        return filtred;
      }
      /**
       * Показать файлы
       */


      function append(items) {
        component.reset();
        var viewed = Lampa.Storage.cache('online_view', 5000, []);
        var last_episode = component.getLastEpisode(items);
        items.forEach(function (element) {
          if (element.season) {
            element.translate_episode_end = last_episode;
            element.translate_voice = filter_items.voice[choice.voice];
          }

          var hash = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title].join('') : object.movie.original_title);
          var view = Lampa.Timeline.view(hash);
          var item = Lampa.Template.get('online_mod', element);
          var hash_file = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title, filter_items.voice[choice.voice]].join('') : object.movie.original_title + element.title);
          element.timeline = view;
          item.append(Lampa.Timeline.render(view));

          if (Lampa.Timeline.details) {
            item.find('.online__quality').append(Lampa.Timeline.details(view, ' / '));
          }

          if (viewed.indexOf(hash_file) !== -1) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
          item.on('hover:enter', function () {
            if (element.loading) return;
            if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            element.loading = true;
            getStream(element, function (element) {
              element.loading = false;
              var first = {
                url: component.getDefaultQuality(element.qualitys, element.stream),
                quality: component.renameQualityMap(element.qualitys),
                subtitles: element.subtitles,
                timeline: element.timeline,
                title: element.season ? element.title : select_title + (element.title == select_title ? '' : ' / ' + element.title)
              };
              Lampa.Player.play(first);

              if (element.season && Lampa.Platform.version) {
                var playlist = [];
                items.forEach(function (elem) {
                  if (elem == element) {
                    playlist.push(first);
                  } else {
                    var cell = {
                      url: function url(call) {
                        getStream(elem, function (elem) {
                          cell.url = component.getDefaultQuality(elem.qualitys, elem.stream);
                          cell.quality = component.renameQualityMap(elem.qualitys);
                          cell.subtitles = elem.subtitles;
                          call();
                        }, function () {
                          cell.url = '';
                          call();
                        });
                      },
                      timeline: elem.timeline,
                      title: elem.title
                    };
                    playlist.push(cell);
                  }
                });
                Lampa.Player.playlist(playlist);
              } else {
                Lampa.Player.playlist([first]);
              }

              if (viewed.indexOf(hash_file) == -1) {
                viewed.push(hash_file);
                item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
                Lampa.Storage.set('online_view', viewed);
              }
            }, function (error) {
              element.loading = false;
              Lampa.Noty.show(error || Lampa.Lang.translate(extract.blocked ? 'online_mod_blockedlink' : 'online_mod_nolink'));
            });
          });
          component.append(item);
          component.contextmenu({
            item: item,
            view: view,
            viewed: viewed,
            hash_file: hash_file,
            element: element,
            file: function file(call) {
              getStream(element, function (element) {
                call({
                  file: element.stream,
                  quality: element.qualitys
                });
              }, function (error) {
                Lampa.Noty.show(error || Lampa.Lang.translate(extract.blocked ? 'online_mod_blockedlink' : 'online_mod_nolink'));
              });
            }
          });
        });
        component.start(true);
      }
    }

    /* МОИ ПРАВКИ: источник «kinobase» удалён */

    /* МОИ ПРАВКИ: источник «collaps» удалён */

    /* МОИ ПРАВКИ: источник «cdnmovies» удалён */

    /* МОИ ПРАВКИ: источник «filmix» удалён */

    /* МОИ ПРАВКИ: источник «zetflix» удалён */

    /* МОИ ПРАВКИ: источник «fancdn» удалён */

    /* МОИ ПРАВКИ: источник «fancdn2» удалён */

    /* МОИ ПРАВКИ: источник «fanserials» удалён */

    /* МОИ ПРАВКИ: источник «videoseed» удалён */

    /* МОИ ПРАВКИ: источник «vibix» удалён */

    /* МОИ ПРАВКИ: источник «alloha» удалён */

    /* МОИ ПРАВКИ: источник «redheadsound» удалён */

    function cdnvideohub(component, _object) {
      var network = new Lampa.Reguest();
      var extract = {};
      var object = _object;
      var select_title = '';
      var prefer_http = Lampa.Storage.field('online_mod_prefer_http') === true;
      var prox = component.proxy('cdnvideohub');
      var user_agent = Utils.baseUserAgent();
      var prox_enc = '';

      if (prox) {
        prox_enc += 'param/Origin=/';
        prox_enc += 'param/Referer=/';
        prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
      }

      var embed = atob('aHR0cHM6Ly9wbGFwaS5jZG52aWRlb2h1Yi5jb20vYXBpL3YxL3BsYXllci9zdi8=');
      var filter_items = {};
      var choice = {
        season: 0,
        voice: 0,
        voice_name: ''
      };
      /**
       * Начать поиск
       * @param {Object} _object
       * @param {String} kinopoisk_id
       */

      this.search = function (_object, kinopoisk_id) {
        object = _object;
        select_title = object.search || object.movie.title;

        if (isNaN(kinopoisk_id)) {
          component.emptyForQuery(select_title);
          return;
        }

        var url = Lampa.Utils.addUrlComponent(embed + atob('cGxheWxpc3Q/cHViPTEyJmFnZ3I9a3A='), 'id=' + kinopoisk_id);
        network.clear();
        network.timeout(10000);
        network["native"](component.proxyLink(url, prox, prox_enc), function (json) {
          parse(json);
        }, function (a, c) {
          if (a.status == 500 && !a.responseText || a.status == 0 && a.statusText !== 'timeout') {
            parse(null);
          } else component.empty(network.errorDecode(a, c));
        });
      };

      this.extendChoice = function (saved) {
        Lampa.Arrays.extend(choice, saved, true);
      };
      /**
       * Сброс фильтра
       */


      this.reset = function () {
        component.reset();
        choice = {
          season: 0,
          voice: 0,
          voice_name: ''
        };
        filter();
        append(filtred());
        component.saveChoice(choice);
      };
      /**
       * Применить фильтр
       * @param {*} type
       * @param {*} a
       * @param {*} b
       */


      this.filter = function (type, a, b) {
        choice[a.stype] = b.index;
        if (a.stype == 'voice') choice.voice_name = filter_items.voice[b.index];
        component.reset();
        filter();
        append(filtred());
        component.saveChoice(choice);
      };
      /**
       * Уничтожить
       */


      this.destroy = function () {
        network.clear();
        extract = null;
      };

      function parse(json) {
        component.loading(false);

        if (json && json.items && json.items.length && json.items.forEach) {
          var seasons = [];
          var items = json.items;
          items.sort(function (a, b) {
            var cmp = (a.season || 0) - (b.season || 0);
            if (cmp) return cmp;
            cmp = (a.episode || 0) - (b.episode || 0);
            if (cmp) return cmp;
            if ((a.voiceStudio || a.voiceType || '') > (b.voiceStudio || b.voiceType || '')) return 1;
            if ((a.voiceStudio || a.voiceType || '') < (b.voiceStudio || b.voiceType || '')) return -1;
            cmp = (a.vkId || 0) - (b.vkId || 0);
            return cmp;
          });
          items.forEach(function (data) {
            if (data.season != null) {
              var s = seasons.filter(function (s) {
                return s.id === data.season;
              })[0];

              if (!s) {
                s = {
                  id: data.season,
                  title: Lampa.Lang.translate('torrent_serial_season') + ' ' + data.season,
                  voices: []
                };
                seasons.push(s);
              }

              var voice = data.voiceStudio || data.voiceType || '';
              if (s.voices.indexOf(voice) == -1) s.voices.push(voice);
            }
          });
          extract = {
            title_name: json.titleName || json.title_name || select_title,
            items: items,
            seasons: seasons
          };
          filter();
          append(filtred());
        } else component.emptyForQuery(select_title);
      }
      /**
       * Построить фильтр
       */


      function filter() {
        filter_items = {
          season: extract.seasons.map(function (s) {
            return s.title;
          }),
          voice: []
        };
        if (!filter_items.season[choice.season]) choice.season = 0;
        var s = extract.seasons[choice.season];
        if (s) filter_items.voice = s.voices;
        if (!filter_items.voice[choice.voice]) choice.voice = 0;

        if (choice.voice_name) {
          var inx = filter_items.voice.indexOf(choice.voice_name);
          if (inx == -1) choice.voice = 0;else if (inx !== choice.voice) {
            choice.voice = inx;
          }
        }

        component.filter(filter_items, choice);
      }
      /**
       * Отфильтровать файлы
       * @returns array
       */


      function filtred() {
        var filtred = [];

        if (extract.seasons.length) {
          var season_id = extract.seasons[choice.season] && extract.seasons[choice.season].id;
          extract.items.forEach(function (data) {
            var voice = data.voiceStudio || data.voiceType || '';

            if (data.season == season_id && voice == filter_items.voice[choice.voice]) {
              filtred.push({
                title: component.formatEpisodeTitle(season_id, data.episode),
                quality: '360p ~ 1080p',
                info: ' / ' + Lampa.Utils.shortText(voice, 50) + (data.vkId ? ' / id: ' + data.vkId : ''),
                data_id: data.vkId,
                season: '' + season_id,
                episode: data.episode,
                media: data
              });
            }
          });
        } else {
          extract.items.forEach(function (data) {
            filtred.push({
              title: data.voiceStudio || data.voiceType || extract.title_name,
              quality: '360p ~ 1080p',
              info: data.vkId ? ' / id: ' + data.vkId : '',
              data_id: data.vkId,
              media: data
            });
          });
        }

        return filtred;
      }
      /**
       * Получить потоки
       * @param {String} str
       * @returns array
       */


      function extractItems(sources) {
        if (!sources) return [];
        var items = [];
        /* 4K и 2K перепутаны */

        if (sources.mpeg2kUrl) {
          items.push({
            label: '4K',
            quality: 2160,
            file: sources.mpeg2kUrl
          });
        }

        if (sources.mpeg4kUrl) {
          items.push({
            label: '2K',
            quality: 1440,
            file: sources.mpeg4kUrl
          });
        }

        if (sources.mpegQhdUrl) {
          items.push({
            label: '1440p',
            quality: 1440,
            file: sources.mpegQhdUrl
          });
        }

        if (sources.mpegFullHdUrl) {
          items.push({
            label: '1080p',
            quality: 1080,
            file: sources.mpegFullHdUrl
          });
        }

        if (sources.mpegHighUrl) {
          items.push({
            label: '720p',
            quality: 720,
            file: sources.mpegHighUrl
          });
        }

        if (sources.mpegMediumUrl) {
          items.push({
            label: '480p',
            quality: 480,
            file: sources.mpegMediumUrl
          });
        }

        if (sources.mpegLowUrl) {
          items.push({
            label: '360p',
            quality: 360,
            file: sources.mpegLowUrl
          });
        }

        if (sources.mpegLowestUrl) {
          items.push({
            label: '240p',
            quality: 240,
            file: sources.mpegLowestUrl
          });
        }

        if (sources.mpegTinyUrl) {
          items.push({
            label: '144p',
            quality: 144,
            file: sources.mpegTinyUrl
          });
        }

        if (!items.length && sources.hlsUrl) {
          items.push({
            label: 'HLS',
            quality: NaN,
            file: sources.hlsUrl
          });
        }

        items.forEach(function (item) {
          item.file = component.proxyLink(component.fixLinkProtocol(item.file, prefer_http, true), prox, prox_enc);
        });
        return items;
      }
      /**
       * Получить поток
       * @param {*} element
       */


      function getStream(element, call, error) {
        if (element.stream) return call(element);
        if (!element.data_id) return error();
        var url = embed + 'video/' + element.data_id;
        network.clear();
        network.timeout(10000);
        network["native"](component.proxyLink(url, prox, prox_enc), function (json) {
          if (json && json.sources) {
            var file = '',
                quality = false;
            var items = extractItems(json.sources);

            if (items && items.length) {
              file = items[0].file;
              quality = {};
              items.forEach(function (item) {
                quality[item.label] = item.file;
              });
            }

            if (file) {
              element.stream = file;
              element.qualitys = quality;
              call(element);
            } else error();
          } else error();
        }, function (a, c) {
          error();
        });
      }
      /**
       * Показать файлы
       */


      function append(items) {
        component.reset();
        var viewed = Lampa.Storage.cache('online_view', 5000, []);
        items.forEach(function (element) {
          var hash = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title].join('') : object.movie.original_title);
          var view = Lampa.Timeline.view(hash);
          var item = Lampa.Template.get('online_mod', element);
          var hash_file = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title, filter_items.voice[choice.voice]].join('') : object.movie.original_title + element.data_id);
          element.timeline = view;
          item.append(Lampa.Timeline.render(view));

          if (Lampa.Timeline.details) {
            item.find('.online__quality').append(Lampa.Timeline.details(view, ' / '));
          }

          if (viewed.indexOf(hash_file) !== -1) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
          item.on('hover:enter', function () {
            if (element.loading) return;
            if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            element.loading = true;
            getStream(element, function (element) {
              element.loading = false;
              var first = {
                url: component.getDefaultQuality(element.qualitys, element.stream),
                quality: component.renameQualityMap(element.qualitys),
                timeline: element.timeline,
                title: element.season ? element.title : select_title + (element.title == select_title ? '' : ' / ' + element.title)
              };
              Lampa.Player.play(first);

              if (element.season && Lampa.Platform.version) {
                var playlist = [];
                items.forEach(function (elem) {
                  if (elem == element) {
                    playlist.push(first);
                  } else {
                    var cell = {
                      url: function url(call) {
                        getStream(elem, function (elem) {
                          cell.url = component.getDefaultQuality(elem.qualitys, elem.stream);
                          cell.quality = component.renameQualityMap(elem.qualitys);
                          call();
                        }, function () {
                          cell.url = '';
                          call();
                        });
                      },
                      timeline: elem.timeline,
                      title: elem.title
                    };
                    playlist.push(cell);
                  }
                });
                Lampa.Player.playlist(playlist);
              } else {
                Lampa.Player.playlist([first]);
              }

              if (viewed.indexOf(hash_file) == -1) {
                viewed.push(hash_file);
                item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
                Lampa.Storage.set('online_view', viewed);
              }
            }, function () {
              element.loading = false;
              Lampa.Noty.show(Lampa.Lang.translate('online_mod_nolink'));
            });
          });
          component.append(item);
          component.contextmenu({
            item: item,
            view: view,
            viewed: viewed,
            hash_file: hash_file,
            file: function file(call) {
              getStream(element, function (element) {
                call({
                  file: element.stream,
                  quality: element.qualitys
                });
              }, function () {
                Lampa.Noty.show(Lampa.Lang.translate('online_mod_nolink'));
              });
            }
          });
        });
        component.start(true);
      }
    }

    /* МОИ ПРАВКИ: источник «anilibria» удалён */

    /* МОИ ПРАВКИ: источник «anilibria2» удалён */

    /* МОИ ПРАВКИ: источник «animelib» удалён */

    function kodik(component, _object) {
      var network = new Lampa.Reguest();
      var extract = {};
      var object = _object;
      var select_title = '';
      var prefer_http = Lampa.Storage.field('online_mod_prefer_http') === true;
      var prefer_mp4 = false;
      var prox = component.proxy('kodik');
      var token = Utils.decodeSecret([124, 125, 1, 86, 90, 64, 12, 123, 108, 59, 122, 125, 82, 3, 90, 23, 90, 122, 60, 110, 43, 123, 84, 3, 91, 71, 88, 112, 111, 57, 122, 121], atob('ZmluZCB5b3VyIG93biB0b2tlbg=='));
      var embed = 'https://kodik-api.com/search';
      var last_player = '';
      var last_info = '';
      var filter_items = {};
      var choice = {
        season: 0,
        voice: 0,
        voice_name: ''
      };

      function kodik_api_search(api, callback, error) {
        network.clear();
        network.timeout(15000);
        network["native"](component.proxyLink(embed + api, prox), function (json) {
          if (callback) callback(json);
        }, function (a, c) {
          if (error) error(network.errorDecode(a, c));
        });
      }
      /**
       * Поиск
       * @param {Object} _object
       */


      this.search = function (_object, kinopoisk_id, data) {
        var _this = this;

        object = _object;
        select_title = object.search || object.movie.title;
        if (this.wait_similars && data && data[0].is_similars) return success(data[0]);
        var search_year = object.search_date;
        var orig_titles = [];

        if (object.movie.alternative_titles && object.movie.alternative_titles.results) {
          orig_titles = object.movie.alternative_titles.results.map(function (t) {
            return t.title;
          });
        }

        if (object.movie.original_title) orig_titles.push(object.movie.original_title);
        if (object.movie.original_name) orig_titles.push(object.movie.original_name);

        var display = function display(results, empty) {
          if (results && results.length && results.forEach) {
            var is_sure = false;
            var is_imdb = false;
            var elements = {};
            results.forEach(function (c) {
              var id;
              if (c.shikimori_id) id = 'sm_' + c.shikimori_id;else if (c.worldart_link) id = 'wa_' + c.worldart_link;else if (c.kinopoisk_id) id = 'kp_' + c.kinopoisk_id;else if (c.imdb_id) id = 'im_' + c.imdb_id;else if (c.id) id = 'k_' + c.id;else id = '';
              if (!id) return;
              id += c.title;
              var list = elements[id] || [];
              list.push(c);
              elements[id] = list;
            });
            var items = [];

            for (var ID in elements) {
              var list = elements[ID];
              items.push({
                title: list[0].title,
                orig_title: list[0].title_orig,
                other_title: list[0].other_title,
                year: list[0].year,
                kinopoisk_id: list[0].kinopoisk_id,
                imdb_id: list[0].imdb_id,
                episodes_count: list[0].episodes_count,
                media: list[0]
              });
            }

            if (!object.clarification && (object.movie.imdb_id || +kinopoisk_id)) {
              var imdb_id = object.movie.imdb_id;
              var kp_id = +kinopoisk_id;
              var tmp = items.filter(function (c) {
                return imdb_id && c.imdb_id == imdb_id || kp_id && c.kinopoisk_id == kp_id;
              });

              if (tmp.length) {
                items = tmp;
                is_sure = true;
                is_imdb = true;
              }
            }

            var cards = items;

            if (cards.length) {
              if (orig_titles.length) {
                var _tmp = cards.filter(function (c) {
                  return component.containsAnyTitle([c.orig_title, c.title, c.other_title], orig_titles);
                });

                if (_tmp.length) {
                  cards = _tmp;
                  is_sure = true;
                }
              }

              if (select_title) {
                var _tmp2 = cards.filter(function (c) {
                  return component.containsAnyTitle([c.title, c.orig_title, c.other_title], [select_title]);
                });

                if (_tmp2.length) {
                  cards = _tmp2;
                  is_sure = true;
                }
              }

              if (!is_sure) cards = [];
              items = cards;

              if (cards.length > 1 && search_year) {
                var _tmp3 = cards.filter(function (c) {
                  return c.year == search_year;
                });

                if (!_tmp3.length) _tmp3 = cards.filter(function (c) {
                  return c.year && c.year > search_year - 2 && c.year < search_year + 2;
                });
                if (_tmp3.length) cards = _tmp3;
              }
            }

            if (cards.length == 1 && is_sure && !is_imdb) {
              if (search_year && cards[0].year) {
                is_sure = cards[0].year > search_year - 2 && cards[0].year < search_year + 2;
              }

              if (is_sure) {
                is_sure = false;

                if (orig_titles.length) {
                  is_sure |= component.equalAnyTitle([cards[0].orig_title, cards[0].title, cards[0].other_title], orig_titles);
                }

                if (select_title) {
                  is_sure |= component.equalAnyTitle([cards[0].title, cards[0].orig_title, cards[0].other_title], [select_title]);
                }
              }
            }

            if (cards.length == 1 && is_sure) {
              success(cards[0]);
            } else if (items.length) {
              _this.wait_similars = true;
              items.forEach(function (c) {
                c.is_similars = true;
              });
              component.similars(items);
              component.loading(false);
            } else empty();
          } else empty();
        };

        var kodik_search_by_title = function kodik_search_by_title(callback, error) {
          var params = Lampa.Utils.addUrlComponent('', 'token=' + token);
          params = Lampa.Utils.addUrlComponent(params, 'limit=100');
          params = Lampa.Utils.addUrlComponent(params, 'translation_type=voice');
          params = Lampa.Utils.addUrlComponent(params, 'title=' + encodeURIComponent(select_title));
          kodik_api_search(params, callback, error);
        };

        var kodik_search_by_title_part = function kodik_search_by_title_part(callback, error) {
          var params = Lampa.Utils.addUrlComponent('', 'token=' + token);
          params = Lampa.Utils.addUrlComponent(params, 'limit=100');
          params = Lampa.Utils.addUrlComponent(params, 'translation_type=voice');
          var words = component.cleanTitle(select_title || '').replace(/[\s—\-+]+/g, ' ').trim().split(' ');
          words.sort(function (a, b) {
            return b.length - a.length;
          });
          var title = words.splice(0, 1).join(' ');

          if (title !== select_title) {
            params = Lampa.Utils.addUrlComponent(params, 'title=' + encodeURIComponent(title));
            kodik_api_search(params, callback, error);
          } else callback({});
        };

        var kodik_search_by_id = function kodik_search_by_id(callback, error) {
          if (!object.clarification && (object.movie.imdb_id || +kinopoisk_id)) {
            var params = Lampa.Utils.addUrlComponent('', 'token=' + token);
            params = Lampa.Utils.addUrlComponent(params, 'limit=100');
            var kp_params = +kinopoisk_id ? Lampa.Utils.addUrlComponent(params, 'kinopoisk_id=' + encodeURIComponent(+kinopoisk_id)) : '';
            var imdb_params = object.movie.imdb_id ? Lampa.Utils.addUrlComponent(params, 'imdb_id=' + encodeURIComponent(object.movie.imdb_id)) : '';
            kodik_api_search(kp_params || imdb_params, function (json) {
              if (json.results && json.results.length) callback(json);else if (kp_params && imdb_params) {
                kodik_api_search(imdb_params, callback, error);
              } else callback({});
            }, error);
          } else callback({});
        };

        var error = component.empty.bind(component);
        kodik_search_by_id(function (json) {
          display(json && json.results, function () {
            kodik_search_by_title_part(function (json) {
              display(json && json.results, function () {
                kodik_search_by_title(function (json) {
                  display(json && json.results, function () {
                    component.emptyForQuery(select_title);
                  });
                }, error);
              });
            }, error);
          });
        }, error);
      };

      this.extendChoice = function (saved) {
        Lampa.Arrays.extend(choice, saved, true);
      };
      /**
       * Сброс фильтра
       */


      this.reset = function () {
        component.reset();
        choice = {
          season: 0,
          voice: 0,
          voice_name: ''
        };
        filter();
        append(filtred());
        component.saveChoice(choice);
      };
      /**
       * Применить фильтр
       * @param {*} type
       * @param {*} a
       * @param {*} b
       */


      this.filter = function (type, a, b) {
        choice[a.stype] = b.index;
        if (a.stype == 'voice') choice.voice_name = filter_items.voice[b.index];
        component.reset();
        filter();
        append(filtred());
        component.saveChoice(choice);
      };
      /**
       * Уничтожить
       */


      this.destroy = function () {
        network.clear();
        extract = null;
      };

      function success(json) {
        var media = json.media || {};
        var params = Lampa.Utils.addUrlComponent('', 'token=' + token);
        params = Lampa.Utils.addUrlComponent(params, 'limit=100');
        params = Lampa.Utils.addUrlComponent(params, 'with_episodes=true');
        if (media.shikimori_id) params = Lampa.Utils.addUrlComponent(params, 'shikimori_id=' + encodeURIComponent(media.shikimori_id));else if (media.worldart_link) params = Lampa.Utils.addUrlComponent(params, 'worldart_link=' + encodeURIComponent(media.worldart_link));else if (media.kinopoisk_id) params = Lampa.Utils.addUrlComponent(params, 'kinopoisk_id=' + encodeURIComponent(media.kinopoisk_id));else if (media.imdb_id) params = Lampa.Utils.addUrlComponent(params, 'imdb_id=' + encodeURIComponent(media.imdb_id));else if (media.id) params = Lampa.Utils.addUrlComponent(params, 'id=' + encodeURIComponent(media.id));else {
          component.emptyForQuery(select_title);
          return;
        }
        var error = component.empty.bind(component);
        kodik_api_search(params, function (json) {
          component.loading(false);
          extractData(json && json.results ? json.results.filter(function (c) {
            return c.title === media.title;
          }) : []);
          filter();
          append(filtred());
        }, error);
      }
      /**
       * Получить данные о фильме
       * @param {Array} items
       */


      function extractData(items) {
        var seasons = [];
        items.forEach(function (c) {
          if (c.seasons) {
            var _loop = function _loop(season_id) {
              var season = c.seasons[season_id];

              if (season) {
                if (!seasons.some(function (s) {
                  return s.id === season_id;
                })) {
                  seasons.push({
                    id: season_id,
                    title: Lampa.Lang.translate('torrent_serial_season') + ' ' + season_id + (season.title ? ' - ' + season.title : '')
                  });
                }
              }
            };

            for (var season_id in c.seasons) {
              _loop(season_id);
            }
          }
        });
        seasons.sort(function (a, b) {
          return a.id - b.id;
        });
        extract = {
          items: items,
          seasons: seasons
        };
      }
      /**
       * Построить фильтр
       */


      function filter() {
        filter_items = {
          season: extract.seasons.map(function (s) {
            return s.title;
          }),
          voice: [],
          voice_info: []
        };
        if (!filter_items.season[choice.season]) choice.season = 0;

        if (extract.seasons.length) {
          var season_id = extract.seasons[choice.season] && extract.seasons[choice.season].id;
          extract.items.forEach(function (c) {
            if (!(c.seasons && c.seasons[season_id])) return;

            if (c.translation && !filter_items.voice_info.some(function (v) {
              return v.id == c.translation.id;
            })) {
              filter_items.voice.push(c.translation.title);
              filter_items.voice_info.push(c.translation);
            }
          });
        }

        if (!filter_items.voice[choice.voice]) choice.voice = 0;

        if (choice.voice_name) {
          var inx = filter_items.voice.indexOf(choice.voice_name);
          if (inx == -1) choice.voice = 0;else if (inx !== choice.voice) {
            choice.voice = inx;
          }
        }

        component.filter(filter_items, choice);
      }
      /**
       * Отфильтровать файлы
       * @returns array
       */


      function filtred() {
        var filtred = [];

        if (extract.seasons.length) {
          var season_id = extract.seasons[choice.season] && extract.seasons[choice.season].id;
          var voice_name = filter_items.voice[choice.voice];
          var voice_id = filter_items.voice_info[choice.voice] && filter_items.voice_info[choice.voice].id;
          var translation = extract.items.filter(function (c) {
            return c.seasons && c.seasons[season_id] && c.translation && c.translation.id == voice_id;
          })[0];

          if (translation) {
            var episodes = translation.seasons[season_id] && translation.seasons[season_id].episodes || {};

            for (var episode_id in episodes) {
              var link = episodes[episode_id];
              filtred.push({
                title: component.formatEpisodeTitle(season_id, episode_id),
                orig_title: translation.title_orig || translation.title || select_title,
                quality: translation.quality || '360p ~ 1080p',
                info: ' / ' + voice_name,
                season: '' + season_id,
                episode: parseInt(episode_id),
                link: link
              });
            }
          }
        } else {
          extract.items.forEach(function (c) {
            if (c.seasons) return;
            filtred.push({
              title: c.translation && c.translation.title || select_title,
              orig_title: c.title_orig || c.title || select_title,
              quality: c.quality || '360p ~ 1080p',
              info: '',
              link: c.link
            });
          });
        }

        return filtred;
      }
      /**
       * Получить поток
       * @param {*} element
       */


      function getStream(element, call, error) {
        if (element.stream) return call(element);
        if (!element.link) return error();
        var link_match = element.link.match(/^((https?:)?\/\/[^\/]+)\/.*$/);
        var link_origin = component.fixLinkProtocol(link_match ? link_match[1] : '//kodikplayer.com', false);
        var url = component.fixLinkProtocol(element.link, false);
        network.clear();
        network.timeout(10000);
        network["native"](component.proxyLink(url, prox), function (str) {
          str = (str || '').replace(/\n/g, '');
          var urlParams = str.match(/\burlParams = '([^']+)'/);
          var type = str.match(/\b(?:videoInfo|vInfo)\.type = '([^']+)'/);
          var hash = str.match(/\b(?:videoInfo|vInfo)\.hash = '([^']+)'/);
          var id = str.match(/\b(?:videoInfo|vInfo)\.id = '([^']+)'/);
          var player = str.match(/<script [^>]*\bsrc="(\/assets\/js\/app\.player_single[^"]+)"/);
          var json;

          try {
            json = urlParams && urlParams[1] && JSON.parse(urlParams[1]);
          } catch (e) {}

          var postdata = '';

          if (json && type && hash && id) {
            postdata = 'd=' + json.d;
            postdata += '&d_sign=' + json.d_sign;
            postdata += '&pd=' + json.pd;
            postdata += '&pd_sign=' + json.pd_sign;
            postdata += '&ref=' + json.ref;
            postdata += '&ref_sign=' + json.ref_sign;
            postdata += '&bad_user=true';
            postdata += '&cdn_is_working=true';
            postdata += '&type=' + type[1];
            postdata += '&hash=' + hash[1];
            postdata += '&id=' + id[1];
            postdata += '&info=%7B%7D';
          }

          if (postdata && player) {
            var getLinks = function getLinks() {
              network.clear();
              network.timeout(10000);
              network["native"](component.proxyLink(last_info, prox), function (json) {
                if (json && json.links) {
                  var items = extractItems(json.links),
                      file = '',
                      quality = false;

                  if (items && items.length) {
                    file = items[0].file;
                    quality = {};
                    items.forEach(function (item) {
                      quality[item.label] = item.file;
                    });
                  }

                  if (file) {
                    element.stream = file;
                    element.qualitys = quality;
                    call(element);
                  } else error();
                } else error();
              }, function (a, c) {
                error();
              }, postdata);
            };

            var player_url = link_origin + player[1];

            if (player_url !== last_player) {
              network.clear();
              network.timeout(10000);
              network["native"](component.proxyLink(player_url, prox), function (str) {
                str = (str || '').replace(/\n/g, '');
                var info_match = str.match(/\$\.ajax\({type: *"POST", *url: *atob\("([^"]+)"\)/);
                var info;

                try {
                  info = info_match && atob(info_match[1]);
                } catch (e) {}

                if (info && startsWith(info, '/')) {
                  last_info = link_origin + info;
                  last_player = player_url;
                  getLinks();
                } else error();
              }, function (a, c) {
                error();
              }, false, {
                dataType: 'text'
              });
            } else getLinks();
          } else error();
        }, function (a, c) {
          error();
        }, false, {
          dataType: 'text'
        });
      }

      function extractItems(playlists) {
        try {
          var items = [];
          Object.keys(playlists).forEach(function (key) {
            var obj = playlists[key];
            var quality = parseInt(key);
            var link = decode(obj && obj[0] && obj[0].src || '');
            link = component.fixLinkProtocol(link, prefer_http, true);
            if (prefer_mp4) ;
            items.push({
              label: quality ? quality + 'p' : '360p ~ 1080p',
              quality: quality,
              file: component.proxyStream(link, 'kodik')
            });
          });
          items.sort(function (a, b) {
            if (b.quality > a.quality) return 1;
            if (b.quality < a.quality) return -1;
            if (b.label > a.label) return 1;
            if (b.label < a.label) return -1;
            return 0;
          });
          return items;
        } catch (e) {}

        return [];
      }

      function decode(str) {
        try {
          if (startsWith(str, 'http') || startsWith(str, '//')) return str;
          return atob(str.replace(/[a-zA-Z]/g, function (x) {
            return String.fromCharCode((x <= 'Z' ? 90 : 122) >= (x = x.charCodeAt(0) + 18) ? x : x - 26);
          }));
        } catch (e) {
          return '';
        }
      }
      /**
       * Показать файлы
       */


      function append(items) {
        component.reset();
        var viewed = Lampa.Storage.cache('online_view', 5000, []);
        var last_episode = component.getLastEpisode(items);
        items.forEach(function (element) {
          if (element.season) {
            element.translate_episode_end = last_episode;
            element.translate_voice = filter_items.voice[choice.voice];
          }

          var hash = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title, element.orig_title].join('') : object.movie.original_title + element.orig_title);
          var view = Lampa.Timeline.view(hash);
          var item = Lampa.Template.get('online_mod', element);
          var hash_file = Lampa.Utils.hash(element.season ? [element.season, element.season > 10 ? ':' : '', element.episode, object.movie.original_title, element.orig_title, filter_items.voice[choice.voice]].join('') : object.movie.original_title + element.orig_title + element.title);
          element.timeline = view;
          item.append(Lampa.Timeline.render(view));

          if (Lampa.Timeline.details) {
            item.find('.online__quality').append(Lampa.Timeline.details(view, ' / '));
          }

          if (viewed.indexOf(hash_file) !== -1) item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
          item.on('hover:enter', function () {
            if (element.loading) return;
            if (object.movie.id) Lampa.Favorite.add('history', object.movie, 100);
            element.loading = true;
            getStream(element, function (element) {
              element.loading = false;
              var first = {
                url: component.getDefaultQuality(element.qualitys, element.stream),
                quality: component.renameQualityMap(element.qualitys),
                timeline: element.timeline,
                title: element.season ? element.title : select_title + (element.title == select_title ? '' : ' / ' + element.title)
              };
              Lampa.Player.play(first);

              if (element.season && Lampa.Platform.version) {
                var playlist = [];
                items.forEach(function (elem) {
                  if (elem == element) {
                    playlist.push(first);
                  } else {
                    var cell = {
                      url: function url(call) {
                        getStream(elem, function (elem) {
                          cell.url = component.getDefaultQuality(elem.qualitys, elem.stream);
                          cell.quality = component.renameQualityMap(elem.qualitys);
                          call();
                        }, function () {
                          cell.url = '';
                          call();
                        });
                      },
                      timeline: elem.timeline,
                      title: elem.title
                    };
                    playlist.push(cell);
                  }
                });
                Lampa.Player.playlist(playlist);
              } else {
                Lampa.Player.playlist([first]);
              }

              if (viewed.indexOf(hash_file) == -1) {
                viewed.push(hash_file);
                item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
                Lampa.Storage.set('online_view', viewed);
              }
            }, function () {
              element.loading = false;
              Lampa.Noty.show(Lampa.Lang.translate('online_mod_nolink'));
            });
          });
          component.append(item);
          component.contextmenu({
            item: item,
            view: view,
            viewed: viewed,
            hash_file: hash_file,
            element: element,
            file: function file(call) {
              getStream(element, function (element) {
                call({
                  file: element.stream,
                  quality: element.qualitys
                });
              }, function () {
                Lampa.Noty.show(Lampa.Lang.translate('online_mod_nolink'));
              });
            }
          });
        });
        component.start(true);
      }
    }

    /* МОИ ПРАВКИ: источник «kinopub» удалён */

    var proxyInitialized = {};
    var proxyWindow = {};
    var proxyCalls = {};
    var default_balanser = MY_DEFAULT_BALANSER || 'cdnvideohub';

    function component(object) {
      var network = new Lampa.Reguest();
      var scroll = new Lampa.Scroll({
        mask: true,
        over: true
      });
      var files = new Lampa.Explorer(object);
      var filter = new Lampa.Filter(object);
      var balanser = Lampa.Storage.get('online_mod_balanser', default_balanser) + '';
      var last_bls = Lampa.Storage.field('online_mod_save_last_balanser') === true ? Lampa.Storage.cache('online_mod_last_balanser', 200, {}) : {};
      var use_stream_proxy = Lampa.Storage.field('online_mod_use_stream_proxy') === true;
      var rezka2_prx_ukr = '//' + (Lampa.Storage.field('online_mod_rezka2_prx_ukr') || 'prx.ukrtelcdn.net') + '/';
      var rezka2_fix_stream = Lampa.Storage.field('online_mod_rezka2_fix_stream') === true;
      var prefer_http = Lampa.Storage.field('online_mod_prefer_http') === true;
      var forcedQuality = '';
      var qualityFilter = {
        title: Lampa.Lang.translate('settings_player_quality'),
        subtitle: '',
        items: [],
        stype: 'quality'
      };
      var contextmenu_all = [];

      if (last_bls[object.movie.id]) {
        balanser = last_bls[object.movie.id];
      }

      this.proxy = function (name) {
        return Utils.proxy(name);
      };

      this.fixLink = function (link, referrer) {
        return Utils.fixLink(link, referrer);
      };

      this.fixLinkProtocol = function (link, prefer_http, replace_protocol) {
        return Utils.fixLinkProtocol(link, prefer_http, replace_protocol);
      };

      this.proxyLink = function (link, proxy, proxy_enc, enc) {
        return Utils.proxyLink(link, proxy, proxy_enc, enc);
      };

      this.proxyStream = function (url, name) {
        if (url && use_stream_proxy) {
          if (name === 'lumex') return url;

          if (name === 'rezka2') {
            return url.replace(/\/\/(stream\.voidboost\.(cc|top|link|club)|[^\/]*.ukrtelcdn.net|vdbmate.org|sambray.org|rumbegg.org|laptostack.org|frntroy.org|femeretes.org)\//, rezka2_prx_ukr);
          }

          return (prefer_http ? 'http://apn.cfhttp.top/' : 'https://apn.watch/') + url;
        }

        if (url && rezka2_fix_stream && name === 'rezka2') {
          return url.replace(/\/\/(stream\.voidboost\.(cc|top|link|club)|[^\/]*.ukrtelcdn.net)\//, '//femeretes.org/');
        }

        return url;
      };

      this.processSubs = function (url) {
        return url;
      };

      this.proxyStreamSubs = function (url, name) {
        if (name === 'lumex') return url;
        var srtUrl = this.processSubs(url);
        if (srtUrl !== url) return srtUrl;
        return this.proxyStream(url, name);
      };

      this.checkMyIp = function (onComplite) {
        Utils.checkMyIp(network, onComplite);
      };

      var last;
      var extended;
      var selected_id;
      var filter_translate = {
        season: Lampa.Lang.translate('torrent_serial_season'),
        voice: Lampa.Lang.translate('torrent_parser_voice'),
        source: Lampa.Lang.translate('settings_rest_source')
      };
      var disable_dbg = !Utils.isDebug();
      var isAndroid = Lampa.Platform.is('android');
      isAndroid && Utils.checkAndroidVersion(339);
      var collapsBlocked = (!startsWith(window.location.protocol, 'http') || window.location.hostname.indexOf('lampa') !== -1) && disable_dbg;
      var all_sources = [
        {
        name: 'rezka2',
        title: 'HDrezka',
        source: new rezka2(this, object),
        search: true,
        kp: false,
        imdb: false
      },
        {
        name: 'cdnvideohub',
        title: 'CDNVideoHub',
        source: new cdnvideohub(this, object),
        search: false,
        kp: true,
        imdb: false
      },
        {
        name: 'kodik',
        title: 'Kodik',
        source: new kodik(this, object),
        search: true,
        kp: true,
        imdb: true
      }
      ];
      /* МОИ ПРАВКИ: оставляем только нужные источники */
      if (MY_UNLOCK_ALL) {
        all_sources.forEach(function (s) { s.disabled = false; });
      } else if (MY_KEEP_SOURCES !== "__ALL__") {
        all_sources = all_sources.filter(function (s) {
          return MY_KEEP_SOURCES.indexOf(s.name) !== -1;
        });
      }
      for (var _mi = 0; _mi < MY_EXTRA_SOURCES.length; _mi++) {
        var _mx = MY_EXTRA_SOURCES[_mi];
        if (_mx && _mx.name && typeof _MY_EXTRA_FACTORY[_mx.name] === "function") {
          all_sources.push({
            name: _mx.name,
            title: _mx.title || _mx.name,
            source: _MY_EXTRA_FACTORY[_mx.name](this, object),
            search: !!_mx.search,
            kp: !!_mx.kp,
            imdb: !!_mx.imdb
          });
        }
      }
      if (all_sources.length && all_sources.map(function (s) { return s.name; }).indexOf(default_balanser) === -1) {
        default_balanser = all_sources[0].name;
      }
      /* конец моих правок */
      var obj_filter_sources = all_sources.filter(function (s) {
        return !s.disabled;
      });
      var filter_sources = obj_filter_sources.map(function (s) {
        return s.name;
      });
      var sources = {};
      obj_filter_sources.forEach(function (s) {
        sources[s.name] = s.source;
      });
      var search_sources = all_sources.filter(function (s) {
        return s.search;
      }).map(function (s) {
        return s.name;
      });
      var kp_sources = all_sources.filter(function (s) {
        return s.kp;
      }).map(function (s) {
        return s.name;
      });
      var imdb_sources = all_sources.filter(function (s) {
        return s.imdb;
      }).map(function (s) {
        return s.name;
      }); // шаловливые ручки

      if (filter_sources.indexOf(balanser) == -1) {
        balanser = default_balanser;

        if (filter_sources.indexOf(balanser) == -1) {
          balanser = filter_sources[0];
        }

        Lampa.Storage.set('online_mod_balanser', balanser);
      }

      scroll.body().addClass('torrent-list');
      scroll.minus(files.render().find('.explorer__files-head'));
      /**
       * Подготовка
       */

      this.create = function () {
        var _this = this;

        this.activity.loader(true);

        filter.onSearch = function (value) {
          Lampa.Activity.replace({
            search: value,
            search_date: '',
            clarification: true
          });
        };

        filter.onBack = function () {
          _this.start();
        };

        filter.onSelect = function (type, a, b) {
          if (type == 'filter') {
            if (a.reset) {
              if (extended) sources[balanser].reset();else _this.start();
            } else if (a.stype == 'source') {
              _this.changeBalanser(filter_sources[b.index]);
            } else if (a.stype == 'quality') {
              forcedQuality = b.title;

              _this.updateQualityFilter();
            } else {
              sources[balanser].filter(type, a, b);
            }
          } else if (type == 'sort') {
            _this.changeBalanser(a.source);
          }
        };

        filter.render().find('.filter--sort span').text(Lampa.Lang.translate('online_mod_balanser'));
        files.appendHead(filter.render());
        files.appendFiles(scroll.render());
        this.search();
        return this.render();
      };

      this.changeBalanser = function (balanser_name) {
        balanser = balanser_name;
        Lampa.Storage.set('online_mod_balanser', balanser);
        last_bls[object.movie.id] = balanser;

        if (Lampa.Storage.field('online_mod_save_last_balanser') === true) {
          Lampa.Storage.set('online_mod_last_balanser', last_bls);
        }

        this.search();
        setTimeout(this.closeFilter, 10);
      };

      this.updateQualityFilter = function () {
        var preferably = forcedQuality;

        if (!preferably) {
          preferably = Lampa.Storage.get('video_quality_default', '1080') + 'p';
          if (preferably === '1080p') preferably = '1080p Ultra';
        }

        var items = ['2160p', '1440p', '1080p Ultra', '1080p', '720p', '480p'].map(function (quality, i) {
          return {
            title: quality,
            selected: quality === preferably,
            index: i
          };
        });
        qualityFilter.subtitle = preferably;
        qualityFilter.items = items;
        setTimeout(this.closeFilter, 10);
      };
      /**
       * Начать поиск
       */


      this.search = function () {
        this.activity.loader(true);
        this.filter({
          source: filter_sources
        }, {
          source: 0
        });
        this.reset();
        this.find();
      };

      this.cleanTitle = function (str) {
        return str.replace(/[\s.,:;’'`!?]+/g, ' ').trim();
      };

      this.kpCleanTitle = function (str) {
        return this.cleanTitle(str).replace(/^[ \/\\]+/, '').replace(/[ \/\\]+$/, '').replace(/\+( *[+\/\\])+/g, '+').replace(/([+\/\\] *)+\+/g, '+').replace(/( *[\/\\]+ *)+/g, '+');
      };

      this.normalizeTitle = function (str) {
        return this.cleanTitle(str.toLowerCase().replace(/[\-\u2010-\u2015\u2E3A\u2E3B\uFE58\uFE63\uFF0D]+/g, '-').replace(/ё/g, 'е'));
      };

      this.equalTitle = function (t1, t2) {
        return typeof t1 === 'string' && typeof t2 === 'string' && this.normalizeTitle(t1) === this.normalizeTitle(t2);
      };

      this.containsTitle = function (str, title) {
        return typeof str === 'string' && typeof title === 'string' && this.normalizeTitle(str).indexOf(this.normalizeTitle(title)) !== -1;
      };

      this.equalAnyTitle = function (strings, titles) {
        var _this2 = this;

        return titles.some(function (title) {
          return title && strings.some(function (str) {
            return str && _this2.equalTitle(str, title);
          });
        });
      };

      this.containsAnyTitle = function (strings, titles) {
        var _this3 = this;

        return titles.some(function (title) {
          return title && strings.some(function (str) {
            return str && _this3.containsTitle(str, title);
          });
        });
      };

      this.uniqueNamesShortText = function (names, limit) {
        var unique = [];
        names.forEach(function (name) {
          if (name && unique.indexOf(name) == -1) unique.push(name);
        });

        if (limit && unique.length > 1) {
          var length = 0;
          var limit_index = -1;
          var last_index = unique.length - 1;
          unique.forEach(function (name, index) {
            length += name.length;
            if (limit_index == -1 && length > limit - (index == last_index ? 0 : 5)) limit_index = index;
            length += 2;
          });

          if (limit_index != -1) {
            unique = unique.splice(0, Math.max(limit_index, 1));
            unique.push('...');
          }
        }

        return unique.join(', ');
      };

      this.decodeHtml = function (html) {
        var text = document.createElement("textarea");
        text.innerHTML = html;
        return text.value;
      };

      this.vcdn_api_search = function (api, data, callback, error) {
        if (callback) callback(data);
        return;
      };

      this.kp_api_search = function (api, callback, error) {
        KP.clear();
        KP.getFromCache(api, function (json, cached) {
          var items = [];
          if (json.items && json.items.length) items = json.items;else if (json.films && json.films.length) items = json.films;
          if (!cached && items.length) KP.setCache(api, json);
          if (callback) callback(items);
        }, function (a, c) {
          if (error) error(network.errorDecode(a, c));
        });
      };

      this.find = function () {
        var _this4 = this;

        var query = object.search || object.movie.title;
        var search_date = object.search_date || !object.clarification && (object.movie.release_date || object.movie.first_air_date || object.movie.last_air_date) || '0000';
        var search_year = parseInt((search_date + '').slice(0, 4));
        var orig_titles = [];

        if (object.movie.alternative_titles && object.movie.alternative_titles.results) {
          orig_titles = object.movie.alternative_titles.results.map(function (t) {
            return t.title;
          });
        }

        if (object.movie.original_title) orig_titles.push(object.movie.original_title);
        if (object.movie.original_name) orig_titles.push(object.movie.original_name);

        var postprocess = function postprocess(items, success, error) {
          if (items && items.length && items.forEach) {
            var is_sure = false;
            var is_imdb = false;
            items.forEach(function (c) {
              if (c.start_date === '1969-12-31') c.start_date = '';
              if (c.year === '1969-12-31') c.year = '';
              var year = c.start_date || c.year || '0000';
              c.tmp_year = parseInt((year + '').slice(0, 4));
            });

            if (!object.clarification && (object.movie.imdb_id || +object.movie.kinopoisk_id)) {
              var imdb_id = object.movie.imdb_id;
              var kp_id = +object.movie.kinopoisk_id;
              var tmp = items.filter(function (c) {
                return imdb_id && (c.imdb_id || c.imdbId) == imdb_id || kp_id && (c.kp_id || c.kinopoisk_id || c.kinopoiskId || c.filmId) == kp_id;
              });

              if (tmp.length) {
                items = tmp;
                is_sure = true;
                is_imdb = true;
              }
            }

            var cards = items;

            if (cards.length) {
              if (orig_titles.length) {
                var _tmp = cards.filter(function (c) {
                  return _this4.containsAnyTitle([c.orig_title || c.nameOriginal, c.en_title || c.nameEn, c.title || c.ru_title || c.nameRu], orig_titles);
                });

                if (_tmp.length) {
                  cards = _tmp;
                  is_sure = true;
                }
              }

              if (query) {
                var _tmp2 = cards.filter(function (c) {
                  return _this4.containsAnyTitle([c.title || c.ru_title || c.nameRu, c.en_title || c.nameEn, c.orig_title || c.nameOriginal], [query]);
                });

                if (_tmp2.length) {
                  cards = _tmp2;
                  is_sure = true;
                }
              }

              if (cards.length > 1 && search_year) {
                var _tmp3 = cards.filter(function (c) {
                  return c.tmp_year == search_year;
                });

                if (!_tmp3.length) _tmp3 = cards.filter(function (c) {
                  return c.tmp_year && c.tmp_year > search_year - 2 && c.tmp_year < search_year + 2;
                });
                if (_tmp3.length) cards = _tmp3;
              }
            }

            if (cards.length == 1 && is_sure && !is_imdb) {
              if (search_year && cards[0].tmp_year) {
                is_sure = cards[0].tmp_year > search_year - 2 && cards[0].tmp_year < search_year + 2;
              }

              if (is_sure) {
                is_sure = false;

                if (orig_titles.length) {
                  is_sure |= _this4.equalAnyTitle([cards[0].orig_title || cards[0].nameOriginal, cards[0].en_title || cards[0].nameEn, cards[0].title || cards[0].ru_title || cards[0].nameRu], orig_titles);
                }

                if (query) {
                  is_sure |= _this4.equalAnyTitle([cards[0].title || cards[0].ru_title || cards[0].nameRu, cards[0].en_title || cards[0].nameEn, cards[0].orig_title || cards[0].nameOriginal], [query]);
                }
              }
            }

            if (cards.length == 1 && is_sure) success(cards);else error(items);
          } else error([]);
        };

        var display = function display(items) {
          postprocess(items, function (cards) {
            _this4.extendChoice();

            sources[balanser].search(object, cards[0].kp_id || cards[0].kinopoisk_id || cards[0].kinopoiskId || cards[0].filmId || cards[0].imdb_id, cards);
          }, function (items) {
            if (items.length) {
              items.forEach(function (c) {
                if (c.episodes) {
                  var season_count = 1;
                  c.episodes.forEach(function (episode) {
                    if (episode.season_num > season_count) {
                      season_count = episode.season_num;
                    }
                  });
                  c.seasons_count = season_count;
                  c.episodes_count = c.episodes.length;
                }
              });

              _this4.similars(items);

              _this4.loading(false);
            } else _this4.emptyForQuery(query);
          });
        };

        var vcdn_search_by_title = function vcdn_search_by_title(callback, error) {
          var params = Lampa.Utils.addUrlComponent('', Utils.vcdnToken());
          params = Lampa.Utils.addUrlComponent(params, 'query=' + encodeURIComponent(query));
          params = Lampa.Utils.addUrlComponent(params, 'field=title');

          _this4.vcdn_api_search('movies' + params, [], function (data) {
            _this4.vcdn_api_search('animes' + params, data, function (data) {
              _this4.vcdn_api_search('tv-series' + params, data, function (data) {
                _this4.vcdn_api_search('anime-tv-series' + params, data, function (data) {
                  _this4.vcdn_api_search('show-tv-series' + params, data, callback, error);
                }, error);
              }, error);
            }, error);
          }, error);
        };

        var vcdn_search_by_id = function vcdn_search_by_id(callback, error) {
          if (!object.clarification && (object.movie.imdb_id || +object.movie.kinopoisk_id)) {
            var params = Lampa.Utils.addUrlComponent('', Utils.vcdnToken());
            var imdb_params = object.movie.imdb_id ? Lampa.Utils.addUrlComponent(params, 'imdb_id=' + encodeURIComponent(object.movie.imdb_id)) : '';
            var kp_params = +object.movie.kinopoisk_id ? Lampa.Utils.addUrlComponent(params, 'kinopoisk_id=' + encodeURIComponent(+object.movie.kinopoisk_id)) : '';

            _this4.vcdn_api_search('short' + (imdb_params || kp_params), [], function (data) {
              if (data && data.length) callback(data);else if (imdb_params && kp_params) {
                _this4.vcdn_api_search('short' + kp_params, [], callback, error);
              } else callback([]);
            }, error);
          } else callback([]);
        };

        var vcdn_search = function vcdn_search(fallback) {
          var error = function error() {
            if (fallback) fallback();else display([]);
          };

          vcdn_search_by_id(function (data) {
            if (data && data.length && data.forEach) display(data);else vcdn_search_by_title(function (data) {
              if (data && data.length && data.forEach) display(data);else error();
            }, error);
          }, error);
        };

        var kp_search_by_title = function kp_search_by_title(callback, error) {
          var url = 'api/v2.1/films/search-by-keyword?keyword=' + encodeURIComponent(_this4.kpCleanTitle(query));

          _this4.kp_api_search(url, callback, error);
        };

        var kp_search_by_id = function kp_search_by_id(callback, error) {
          if (!object.clarification && object.movie.imdb_id) {
            var url = 'api/v2.2/films?imdbId=' + encodeURIComponent(object.movie.imdb_id);

            _this4.kp_api_search(url, callback, error);
          } else callback([]);
        };

        var kp_search = function kp_search(fallback) {
          var error = function error() {
            if (fallback) fallback();else display([]);
          };

          kp_search_by_id(function (data) {
            if (data && data.length && data.forEach) display(data);else kp_search_by_title(function (data) {
              if (data && data.length && data.forEach) display(data);else error();
            }, error);
          }, error);
        };

        var vcdn_search_imdb = function vcdn_search_imdb() {
          var error = function error() {
            if (imdb_sources.indexOf(balanser) >= 0) {
              var error1 = function error1() {
                _this4.extendChoice();

                sources[balanser].search(object, object.movie.imdb_id);
              };

              if (search_sources.indexOf(balanser) >= 0) error1();else {
                kp_search_by_title(function (data) {
                  postprocess(data, function (cards) {
                    _this4.extendChoice();

                    sources[balanser].search(object, cards[0].kp_id || cards[0].kinopoisk_id || cards[0].kinopoiskId || cards[0].filmId || cards[0].imdb_id, cards);
                  }, function (items) {
                    error1();
                  });
                }, error1);
              }
            } else if (search_sources.indexOf(balanser) >= 0) {
              _this4.extendChoice();

              sources[balanser].search(object);
            } else {
              var error2 = function error2() {
                display([]);
              };

              kp_search_by_title(function (data) {
                if (data && data.length && data.forEach) display(data);else error2();
              }, error2);
            }
          };

          vcdn_search_by_id(function (data) {
            if (data && data.length && data.forEach) display(data);else error();
          }, error);
        };

        var kp_search_imdb = function kp_search_imdb() {
          kp_search_by_id(function (data) {
            if (data && data.length && data.forEach) display(data);else vcdn_search_imdb();
          }, vcdn_search_imdb);
        };

        var letgo = function letgo() {
          if (!object.clarification && +object.movie.kinopoisk_id && kp_sources.indexOf(balanser) >= 0) {
            _this4.extendChoice();

            sources[balanser].search(object, +object.movie.kinopoisk_id);
          } else if (!object.clarification && object.movie.imdb_id && kp_sources.indexOf(balanser) >= 0) {
            kp_search_imdb();
          } else if (search_sources.indexOf(balanser) >= 0) {
            _this4.extendChoice();

            sources[balanser].search(object);
          } else {
            if (balanser == 'lumex' || balanser == 'lumex2') {
              var fallback = function fallback() {
                if (!object.clarification && (+object.movie.kinopoisk_id || object.movie.imdb_id)) {
                  _this4.extendChoice();

                  sources[balanser].search(object, +object.movie.kinopoisk_id || object.movie.imdb_id);
                } else if (Lampa.Storage.field('online_mod_skip_kp_search') !== true) kp_search();else display([]);
              };

              vcdn_search(fallback);
            } else kp_search(vcdn_search);
          }
        };

        if (!object.movie.imdb_id && (object.movie.source == 'tmdb' || object.movie.source == 'cub') && (imdb_sources.indexOf(balanser) >= 0 || kp_sources.indexOf(balanser) >= 0)) {
          var tmdburl = (object.movie.name ? 'tv' : 'movie') + '/' + object.movie.id + '/external_ids?api_key=4ef0d7355d9ffb5151e987764708ce96&language=ru';
          var baseurl = typeof Lampa.TMDB !== 'undefined' ? Lampa.TMDB.api(tmdburl) : 'http://api.themoviedb.org/3/' + tmdburl;
          network.clear();
          network.timeout(1000 * 15);
          network.silent(baseurl, function (ttid) {
            object.movie.imdb_id = ttid.imdb_id;
            letgo();
          }, function (a, c) {
            letgo();
          });
        } else {
          letgo();
        }
      };

      this.parsePlaylist = function (str) {
        var pl = [];

        try {
          if (startsWith(str, '[')) {
            str.substring(1).split(/, *\[/).forEach(function (item) {
              item = item.trim();
              if (endsWith(item, ',')) item = item.substring(0, item.length - 1).trim();
              var label_end = item.indexOf(']');

              if (label_end >= 0) {
                var label = item.substring(0, label_end).trim();

                if (item.charAt(label_end + 1) === '{') {
                  item.substring(label_end + 2).split(/; *\{/).forEach(function (voice_item) {
                    voice_item = voice_item.trim();
                    if (endsWith(voice_item, ';')) voice_item = voice_item.substring(0, voice_item.length - 1).trim();
                    var voice_end = voice_item.indexOf('}');

                    if (voice_end >= 0) {
                      var voice = voice_item.substring(0, voice_end).trim();
                      pl.push({
                        label: label,
                        voice: voice,
                        links: voice_item.substring(voice_end + 1).split(' or ').map(function (link) {
                          return link.trim();
                        }).filter(function (link) {
                          return link;
                        })
                      });
                    }
                  });
                } else {
                  pl.push({
                    label: label,
                    links: item.substring(label_end + 1).split(' or ').map(function (link) {
                      return link.trim();
                    }).filter(function (link) {
                      return link;
                    })
                  });
                }
              }
            });
            pl = pl.filter(function (item) {
              return item.links.length;
            });
          }
        } catch (e) {}

        return pl;
      };

      this.parseM3U = function (str) {
        var pl = [];

        try {
          var xstream = false;
          var bandwidth = 0;
          var width = 0;
          var height = 0;
          var codecs = '';
          str.split('\n').forEach(function (line) {
            line = line.trim();

            if (startsWith(line, '#')) {
              if (startsWith(line, '#EXT-X-STREAM-INF')) {
                xstream = true;
                var BANDWIDTH = line.match(/\bBANDWIDTH=(\d+)\b/);

                if (BANDWIDTH) {
                  bandwidth = BANDWIDTH[1];
                }

                var RESOLUTION = line.match(/\bRESOLUTION=(\d+)x(\d+)\b/);

                if (RESOLUTION) {
                  width = parseInt(RESOLUTION[1]);
                  height = parseInt(RESOLUTION[2]);
                }

                var CODECS = line.match(/\bCODECS="([^"]+)"/);

                if (CODECS) {
                  codecs = CODECS[1];
                }
              }
            } else if (line.length) {
              pl.push({
                xstream: xstream,
                bandwidth: bandwidth,
                width: width,
                height: height,
                codecs: codecs,
                link: line
              });
              xstream = false;
              bandwidth = 0;
              width = 0;
              height = 0;
              codecs = '';
            }
          });
        } catch (e) {}

        return pl;
      };

      this.formatEpisodeTitle = function (s_num, e_num, name) {
        var title = '';
        var full = Lampa.Storage.field('online_mod_full_episode_title') === true;

        if (s_num != null && s_num !== '') {
          title = (full ? Lampa.Lang.translate('torrent_serial_season') + ' ' : 'S') + s_num + ' / ';
        }

        if (name == null || name === '') name = Lampa.Lang.translate('torrent_serial_episode') + ' ' + e_num;else if (e_num != null && e_num !== '') name = Lampa.Lang.translate('torrent_serial_episode') + ' ' + e_num + ' - ' + name;
        title += name;
        return title;
      };

      this.proxyUrlCall = function (proxy_url, method, url, timeout, post_data, call_success, call_fail, withCredentials) {
        proxy_url = this.proxy('iframe') + proxy_url;

        var process = function process() {
          if (proxyWindow[proxy_url]) {
            timeout = timeout || 60 * 1000;
            var message_id;

            try {
              message_id = crypto.getRandomValues(new Uint8Array(16)).toString();
            } catch (e) {}

            if (!message_id) message_id = Math.random().toString();
            proxyCalls[message_id] = {
              success: call_success,
              fail: call_fail
            };
            proxyWindow[proxy_url].postMessage({
              message: 'proxyMessage',
              message_id: message_id,
              method: method,
              url: url,
              timeout: timeout,
              post_data: post_data,
              withCredentials: withCredentials
            }, '*');
            setTimeout(function () {
              var call = proxyCalls[message_id];

              if (call) {
                delete proxyCalls[message_id];
                if (call.fail) call.fail({
                  status: 0,
                  statusText: 'timeout',
                  responseText: ''
                }, 'timeout');
              }
            }, timeout + 1000);
          } else {
            if (call_fail) call_fail({
              status: 0,
              statusText: 'abort',
              responseText: ''
            }, 'abort');
          }
        };

        if (!proxyInitialized[proxy_url]) {
          proxyInitialized[proxy_url] = true;
          var proxyOrigin = proxy_url.replace(/(https?:\/\/[^\/]+)\/.*/, '$1');
          var proxyIframe = document.createElement('iframe');
          proxyIframe.setAttribute('src', proxy_url);
          proxyIframe.setAttribute('width', '0');
          proxyIframe.setAttribute('height', '0');
          proxyIframe.setAttribute('tabindex', '-1');
          proxyIframe.setAttribute('title', 'empty');
          proxyIframe.setAttribute('style', 'display:none');
          proxyIframe.addEventListener('load', function () {
            proxyWindow[proxy_url] = proxyIframe.contentWindow;
            window.addEventListener('message', function (event) {
              var data = event.data;

              if (event.origin === proxyOrigin && data && data.message === 'proxyResponse' && data.message_id) {
                var call = proxyCalls[data.message_id];

                if (call) {
                  delete proxyCalls[data.message_id];

                  if (data.status === 200) {
                    if (call.success) call.success(data.responseText);
                  } else {
                    if (call.fail) call.fail({
                      status: data.status,
                      statusText: data.statusText,
                      responseText: data.responseText
                    });
                  }
                }
              }
            });
            if (process) process();
            process = null;
          });
          document.body.appendChild(proxyIframe);
          setTimeout(function () {
            if (process) process();
            process = null;
          }, 10000);
        } else {
          process();
        }
      };

      this.proxyCall = function (method, url, timeout, post_data, call_success, call_fail, withCredentials) {
        var proxy_url = (window.location.protocol === 'https:' ? 'https://' : 'http://') + 'nb557.surge.sh/proxy.html';
        this.proxyUrlCall(proxy_url, method, url, timeout, post_data, call_success, call_fail, withCredentials);
      };

      this.proxyCall2 = function (method, url, timeout, post_data, call_success, call_fail, withCredentials) {
        var proxy_url = (window.location.protocol === 'https:' ? 'https://' : 'http://') + 'lampa.stream/proxy.html';
        this.proxyUrlCall(proxy_url, method, url, timeout, post_data, call_success, call_fail, withCredentials);
      };

      this.proxyCall3 = function (method, url, timeout, post_data, call_success, call_fail, withCredentials) {
        var proxy_url = 'https://nb557.github.io/plugins/proxy.html';
        this.proxyUrlCall(proxy_url, method, url, timeout, post_data, call_success, call_fail, withCredentials);
      };

      this.extendChoice = function () {
        var data = Lampa.Storage.cache('online_mod_choice_' + balanser, 500, {});
        var save = data[selected_id || object.movie.id] || {};
        extended = true;
        sources[balanser].extendChoice(save);
      };

      this.saveChoice = function (choice) {
        var data = Lampa.Storage.cache('online_mod_choice_' + balanser, 500, {});
        data[selected_id || object.movie.id] = choice;
        Lampa.Storage.set('online_mod_choice_' + balanser, data);
      };
      /**
       * Есть похожие карточки
       * @param {Object} json
       */


      this.similars = function (json, search_more, more_params) {
        var _this5 = this;

        json.forEach(function (elem) {
          var title = elem.title || elem.ru_title || elem.nameRu || elem.en_title || elem.nameEn || elem.orig_title || elem.nameOriginal;
          var orig_title = elem.orig_title || elem.nameOriginal || elem.en_title || elem.nameEn;
          var year = elem.start_date || elem.year || '';
          var info = [];
          if (orig_title && orig_title != elem.title) info.push(orig_title);
          if (elem.seasons_count) info.push(Lampa.Lang.translate('online_mod_seasons_count') + ': ' + elem.seasons_count);
          if (elem.episodes_count) info.push(Lampa.Lang.translate('online_mod_episodes_count') + ': ' + elem.episodes_count);
          elem.title = title;
          elem.quality = year ? (year + '').slice(0, 4) : '----';
          elem.info = info.length ? ' / ' + info.join(' / ') : '';
          var item = Lampa.Template.get('online_mod_folder', elem);
          item.on('hover:enter', function () {
            _this5.activity.loader(true);

            _this5.reset();

            object.search = elem.title;
            object.search_date = year;
            selected_id = elem.id;

            _this5.extendChoice();

            sources[balanser].search(object, elem.kp_id || elem.kinopoisk_id || elem.kinopoiskId || elem.filmId || elem.imdb_id, [elem]);
          });

          _this5.append(item);
        });

        if (search_more) {
          var elem = {
            title: Lampa.Lang.translate('online_mod_show_more'),
            quality: '...',
            info: ''
          };
          var item = Lampa.Template.get('online_mod_folder', elem);
          item.on('hover:enter', function () {
            _this5.activity.loader(true);

            _this5.reset();

            search_more(more_params);
          });
          this.append(item);
        }
      };
      /**
       * Очистить список файлов
       */


      this.reset = function () {
        contextmenu_all = [];
        last = filter.render().find('.selector').eq(0)[0];
        scroll.render().find('.empty').remove();
        scroll.clear();
        scroll.reset();
      };

      this.inActivity = function () {
        var body = $('body');
        return !(body.hasClass('settings--open') || body.hasClass('menu--open') || body.hasClass('keyboard-input--visible') || body.hasClass('selectbox--open') || body.hasClass('search--open') || body.hasClass('ambience--enable') || $('div.modal').length);
      };
      /**
       * Загрузка
       */


      this.loading = function (status) {
        if (status) this.activity.loader(true);else {
          this.activity.loader(false);
          if (Lampa.Activity.active().activity === this.activity && this.inActivity()) this.activity.toggle();
        }
      };

      this.getDefaultQuality = function (qualityMap, defValue) {
        {
          var needHackHlsLink = function needHackHlsLink(link) {
            return link && endsWith(link, '.m3u8') && link.lastIndexOf('?') <= link.lastIndexOf('/');
          };

          if (qualityMap) {
            for (var ID in qualityMap) {
              if (needHackHlsLink(qualityMap[ID])) {
                qualityMap[ID] += '?';
              }
            }
          }

          if (needHackHlsLink(defValue)) {
            defValue += '?';
          }
        }

        if (qualityMap) {
          var preferably = forcedQuality;

          if (!preferably) {
            preferably = Lampa.Storage.get('video_quality_default', '1080') + 'p';
            if (preferably === '1080p') preferably = '1080p Ultra';
          }

          var items = ['2160p', '2160', '4K', '1440p', '1440', '2K', '1080p Ultra', '1080p', '1080', '720p', '720', '480p', '480', '360p', '360', '240p', '240'];
          var idx = items.indexOf(preferably);

          if (idx !== -1) {
            for (var i = idx; i < items.length; i++) {
              var item = items[i];
              if (qualityMap[item]) return qualityMap[item];
            }

            for (var _i = idx - 1; _i >= 0; _i--) {
              var _item = items[_i];
              if (qualityMap[_item]) return qualityMap[_item];
            }
          }
        }

        return defValue;
      };

      this.renameQualityMap = function (qualityMap) {
        if (!qualityMap) return qualityMap;
        var renamed = {};

        for (var label in qualityMap) {
          renamed["\u200B" + label] = qualityMap[label];
        }

        return renamed;
      };
      /**
       * Построить фильтр
       */


      this.filter = function (filter_items, choice) {
        var select = [];

        var add = function add(type, title) {
          var need = Lampa.Storage.get('online_mod_filter', '{}');
          var items = filter_items[type];
          var subitems = [];
          var value = need[type];
          items.forEach(function (name, i) {
            subitems.push({
              title: name,
              selected: value == i,
              index: i
            });
          });
          select.push({
            title: title,
            subtitle: items[value],
            items: subitems,
            stype: type
          });
        };

        choice.source = filter_sources.indexOf(balanser);
        Lampa.Storage.set('online_mod_filter', choice);
        select.push({
          title: Lampa.Lang.translate('torrent_parser_reset'),
          reset: true
        });
        filter_items.source = obj_filter_sources.map(function (s) {
          return s.title;
        });
        add('source', Lampa.Lang.translate('online_mod_balanser'));
        if (filter_items.voice && filter_items.voice.length) add('voice', Lampa.Lang.translate('torrent_parser_voice'));
        if (filter_items.season && filter_items.season.length) add('season', Lampa.Lang.translate('torrent_serial_season'));
        if (filter_items.server && filter_items.server.length) add('server', Lampa.Lang.translate('online_mod_server'));
        this.updateQualityFilter();
        select.push(qualityFilter);
        filter.set('filter', select);
        filter.set('sort', obj_filter_sources.map(function (e) {
          return {
            source: e.name,
            title: e.title,
            selected: e.name === balanser
          };
        }));
        this.selected(filter_items);
      };
      /**
       * Закрыть фильтр
       */


      this.closeFilter = function () {
        if ($('body').hasClass('selectbox--open')) Lampa.Select.close();
      };
      /**
       * Показать что выбрано в фильтре
       */


      this.selected = function (filter_items) {
        var need = Lampa.Storage.get('online_mod_filter', '{}'),
            select = [];

        for (var i in need) {
          if (i !== 'source' && filter_translate[i] && filter_items[i] && filter_items[i].length > 1) {
            select.push(filter_translate[i] + ': ' + filter_items[i][need[i]]);
          }
        }

        var source_obj = obj_filter_sources.filter(function (e) {
          return e.name === balanser;
        })[0];
        filter.chosen('filter', select);
        filter.chosen('sort', [source_obj ? source_obj.title : balanser]);
      };
      /**
       * Добавить файл
       */


      this.append = function (item) {
        item.on('hover:focus', function (e) {
          last = e.target;
          scroll.update($(e.target), true);
        });
        scroll.append(item);
      };
      /**
       * Меню
       */


      this.contextmenu = function (params) {
        contextmenu_all.push(params);
        params.item.on('hover:long', function () {
          function selectQuality(title, callback) {
            return function (extra) {
              if (extra.quality) {
                var qual = [];

                for (var i in extra.quality) {
                  qual.push({
                    title: i,
                    file: extra.quality[i]
                  });
                }

                Lampa.Select.show({
                  title: title,
                  items: qual,
                  onBack: function onBack() {
                    Lampa.Controller.toggle(enabled);
                  },
                  onSelect: callback
                });
              } else callback(null, extra);
            };
          }

          var enabled = Lampa.Controller.enabled().name;
          var menu = [{
            title: Lampa.Lang.translate('torrent_parser_label_title'),
            mark: true
          }, {
            title: Lampa.Lang.translate('torrent_parser_label_cancel_title'),
            clearmark: true
          }, {
            title: Lampa.Lang.translate('online_mod_clearmark_all'),
            clearmark_all: true
          }, {
            title: Lampa.Lang.translate('time_reset'),
            timeclear: true
          }, {
            title: Lampa.Lang.translate('online_mod_timeclear_all'),
            timeclear_all: true
          }];

          if (Lampa.Platform.is('webos')) {
            menu.push({
              title: Lampa.Lang.translate('player_lauch') + ' - Webos',
              player: 'webos'
            });
          }

          if (Lampa.Platform.is('android')) {
            menu.push({
              title: Lampa.Lang.translate('player_lauch') + ' - Android',
              player: 'android'
            });
          }

          menu.push({
            title: Lampa.Lang.translate('player_lauch') + ' - Lampa',
            player: 'lampa'
          });

          if (params.file) {
            menu.push({
              title: Lampa.Lang.translate('copy_link'),
              copylink: true
            });
          }

          if (Lampa.Account.working() && params.element && typeof params.element.season !== 'undefined' && Lampa.Account.subscribeToTranslation) {
            menu.push({
              title: Lampa.Lang.translate('online_mod_voice_subscribe'),
              subscribe: true
            });
          }

          Lampa.Select.show({
            title: Lampa.Lang.translate('title_action'),
            items: menu,
            onBack: function onBack() {
              Lampa.Controller.toggle(enabled);
            },
            onSelect: function onSelect(a) {
              if (a.clearmark) {
                Lampa.Arrays.remove(params.viewed, params.hash_file);
                Lampa.Storage.set('online_view', params.viewed);
                params.item.find('.torrent-item__viewed').remove();
              }

              if (a.clearmark_all) {
                contextmenu_all.forEach(function (params) {
                  Lampa.Arrays.remove(params.viewed, params.hash_file);
                  Lampa.Storage.set('online_view', params.viewed);
                  params.item.find('.torrent-item__viewed').remove();
                });
              }

              if (a.mark) {
                if (params.viewed.indexOf(params.hash_file) == -1) {
                  params.viewed.push(params.hash_file);
                  params.item.append('<div class="torrent-item__viewed">' + Lampa.Template.get('icon_star', {}, true) + '</div>');
                  Lampa.Storage.set('online_view', params.viewed);
                }
              }

              if (a.timeclear) {
                params.view.percent = 0;
                params.view.time = 0;
                params.view.duration = 0;
                Lampa.Timeline.update(params.view);
              }

              if (a.timeclear_all) {
                contextmenu_all.forEach(function (params) {
                  params.view.percent = 0;
                  params.view.time = 0;
                  params.view.duration = 0;
                  Lampa.Timeline.update(params.view);
                });
              }

              Lampa.Controller.toggle(enabled);

              if (a.player) {
                Lampa.Player.runas(a.player);
                params.item.trigger('hover:enter', {
                  runas: a.player
                });
              }

              if (a.copylink) {
                params.file(selectQuality('Ссылки', function (b, extra) {
                  Lampa.Utils.copyTextToClipboard(b && b.file || extra && extra.file, function () {
                    Lampa.Noty.show(Lampa.Lang.translate('copy_secuses'));
                  }, function () {
                    Lampa.Noty.show(Lampa.Lang.translate('copy_error'));
                  });
                }));
              }

              if (a.subscribe) {
                Lampa.Account.subscribeToTranslation({
                  card: object.movie,
                  season: params.element.season,
                  episode: params.element.translate_episode_end,
                  voice: params.element.translate_voice
                }, function () {
                  Lampa.Noty.show(Lampa.Lang.translate('online_mod_voice_success'));
                }, function () {
                  Lampa.Noty.show(Lampa.Lang.translate('online_mod_voice_error'));
                });
              }
            }
          });
        }).on('hover:focus', function () {
          if (Lampa.Helper) Lampa.Helper.show('online_file', Lampa.Lang.translate('online_mod_file_helper'), params.item);
        });
      };
      /**
       * Показать пустой результат
       */


      this.empty = function (msg) {
        var empty = Lampa.Template.get('list_empty');
        if (msg) empty.find('.empty__descr').text(msg);
        scroll.append(empty);
        this.loading(false);
      };
      /**
       * Показать пустой результат по ключевому слову
       */


      this.emptyForQuery = function (query) {
        this.empty(Lampa.Lang.translate('online_mod_query_start') + ' (' + query + ') ' + Lampa.Lang.translate('online_mod_query_end'));
      };

      this.getLastEpisode = function (items) {
        var last_episode = 0;
        items.forEach(function (e) {
          if (typeof e.episode !== 'undefined') last_episode = Math.max(last_episode, parseInt(e.episode));
        });
        return last_episode;
      };
      /**
       * Начать навигацию по файлам
       */


      this.start = function (first_select) {
        if (Lampa.Activity.active().activity !== this.activity) return; //обязательно, иначе наблюдается баг, активность создается но не стартует, в то время как компонент загружается и стартует самого себя.

        if (first_select) {
          var last_views = scroll.render().find('.selector.online').find('.torrent-item__viewed').parent().last();
          if (object.movie.number_of_seasons && last_views.length) last = last_views.eq(0)[0];else last = scroll.render().find('.selector').eq(0)[0];
        }

        Lampa.Background.immediately(Lampa.Utils.cardImgBackground(object.movie));
        Lampa.Controller.add('content', {
          toggle: function toggle() {
            Lampa.Controller.collectionSet(scroll.render(), files.render());
            Lampa.Controller.collectionFocus(last || false, scroll.render());
          },
          up: function up() {
            if (Navigator.canmove('up')) {
              Navigator.move('up');
            } else Lampa.Controller.toggle('head');
          },
          down: function down() {
            Navigator.move('down');
          },
          right: function right() {
            if (Navigator.canmove('right')) Navigator.move('right');else filter.show(Lampa.Lang.translate('title_filter'), 'filter');
          },
          left: function left() {
            if (Navigator.canmove('left')) Navigator.move('left');else Lampa.Controller.toggle('menu');
          },
          back: this.back
        });
        if (this.inActivity()) Lampa.Controller.toggle('content');
      };

      this.render = function () {
        return files.render();
      };

      this.back = function () {
        Lampa.Activity.backward();
      };

      this.pause = function () {};

      this.stop = function () {};

      this.destroy = function () {
        network.clear();
        files.destroy();
        scroll.destroy();
        network = null;
        all_sources.forEach(function (s) {
          s.source.destroy();
        });
      };
    }

    var mod_version = '20.09.2026-my';
    var isMSX = !!(window.TVXHost || window.TVXManager);
    var isTizen = navigator.userAgent.toLowerCase().indexOf('tizen') !== -1;
    var isIFrame = window.parent !== window;
    var isLocal = !startsWith(window.location.protocol, 'http');
    var androidHeaders = Lampa.Platform.is('android') && Utils.checkAndroidVersion(339);
    var filmixHost = Utils.filmixHost();
    var network = new Lampa.Reguest();
    var online_loading = false;

    function logApp() {
      console.log('App', 'start address:', window.location.href);
      console.log('App', 'is MSX:', isMSX);
      console.log('App', 'is Tizen:', isTizen);
      console.log('App', 'is iframe:', isIFrame);
      console.log('App', 'is local:', isLocal);
      console.log('App', 'supports headers:', androidHeaders);
    }

    function initStorage() {
      if (!Utils.isDebug()) {
        Lampa.Storage.set('online_mod_proxy_lumex', 'false');
        Lampa.Storage.set('online_mod_proxy_rezka2', 'false');
        Lampa.Storage.set('online_mod_proxy_kinobase', 'false');
        Lampa.Storage.set('online_mod_proxy_collaps', 'false');
        Lampa.Storage.set('online_mod_proxy_cdnmovies', 'false');
        Lampa.Storage.set('online_mod_proxy_fancdn', 'false');
        Lampa.Storage.set('online_mod_proxy_fancdn2', 'false');
        Lampa.Storage.set('online_mod_proxy_fanserials', 'false');
        Lampa.Storage.set('online_mod_proxy_fanserials_cdn', 'false');
        Lampa.Storage.set('online_mod_proxy_animelib', 'false');
      } else if (!Lampa.Platform.is('android')) {
        Lampa.Storage.set('online_mod_proxy_lumex', 'true');
        Lampa.Storage.set('online_mod_proxy_cdnmovies', 'true');
        Lampa.Storage.set('online_mod_proxy_fancdn', 'true');
        Lampa.Storage.set('online_mod_proxy_fancdn2', 'true');

        if (!isLocal) {
          Lampa.Storage.set('online_mod_proxy_fanserials', 'true');
        }
      }

      if (!Lampa.Platform.is('android')) {
        Lampa.Storage.set('online_mod_proxy_filmix', 'true');
      }

      Lampa.Storage.set('online_mod_proxy_videoseed', Lampa.Platform.is('android') || isLocal ? 'false' : 'true');
      Lampa.Storage.set('online_mod_proxy_vibix', Lampa.Platform.is('android') ? 'false' : 'true');
      Lampa.Storage.set('online_mod_proxy_redheadsound', Lampa.Platform.is('android') ? 'false' : 'true');
      Lampa.Storage.set('online_mod_proxy_cdnvideohub', 'false');
      Lampa.Storage.set('online_mod_proxy_videodb', 'false');
      Lampa.Storage.set('online_mod_proxy_zetflix', 'false');
      Lampa.Storage.set('online_mod_proxy_kinopub', 'true');
      Lampa.Storage.set('online_mod_proxy_alloha', 'false');
      Lampa.Storage.set('online_mod_proxy_hdvb', 'false');
      Lampa.Storage.set('online_mod_proxy_kp', 'false');
      Lampa.Params.trigger('online_mod_iframe_proxy', !isTizen || isLocal);
      Lampa.Params.trigger('online_mod_proxy_iframe', false);
      Lampa.Params.trigger('online_mod_use_stream_proxy', false);
      Lampa.Params.trigger('online_mod_proxy_find_ip', false);
      Lampa.Params.trigger('online_mod_proxy_other', false);
      Lampa.Params.trigger('online_mod_proxy_lumex', false);
      Lampa.Params.trigger('online_mod_proxy_rezka', false);
      Lampa.Params.trigger('online_mod_proxy_rezka2', false);
      Lampa.Params.trigger('online_mod_proxy_rezka2_mirror', false);
      Lampa.Params.trigger('online_mod_proxy_kinobase', false);
      Lampa.Params.trigger('online_mod_proxy_collaps', false);
      Lampa.Params.trigger('online_mod_proxy_cdnmovies', false);
      Lampa.Params.trigger('online_mod_proxy_filmix', false);
      Lampa.Params.trigger('online_mod_proxy_videodb', false);
      Lampa.Params.trigger('online_mod_proxy_zetflix', false);
      Lampa.Params.trigger('online_mod_proxy_fancdn', false);
      Lampa.Params.trigger('online_mod_proxy_fancdn2', false);
      Lampa.Params.trigger('online_mod_proxy_fanserials', false);
      Lampa.Params.trigger('online_mod_proxy_fanserials_cdn', false);
      Lampa.Params.trigger('online_mod_proxy_videoseed', false);
      Lampa.Params.trigger('online_mod_proxy_vibix', false);
      Lampa.Params.trigger('online_mod_proxy_redheadsound', false);
      Lampa.Params.trigger('online_mod_proxy_cdnvideohub', false);
      Lampa.Params.trigger('online_mod_proxy_anilibria', false);
      Lampa.Params.trigger('online_mod_proxy_anilibria2', false);
      Lampa.Params.trigger('online_mod_proxy_animelib', false);
      Lampa.Params.trigger('online_mod_proxy_kodik', false);
      Lampa.Params.trigger('online_mod_proxy_kinopub', false);
      Lampa.Params.trigger('online_mod_proxy_alloha', false);
      Lampa.Params.trigger('online_mod_proxy_hdvb', false);
      Lampa.Params.trigger('online_mod_proxy_kp', false);
      Lampa.Params.trigger('online_mod_skip_kp_search', false);
      Lampa.Params.trigger('online_mod_prefer_http', window.location.protocol !== 'https:');
      Lampa.Params.trigger('online_mod_prefer_mp4', true);
      Lampa.Params.trigger('online_mod_prefer_dash', false);
      Lampa.Params.trigger('online_mod_collaps_lampa_player', false);
      Lampa.Params.trigger('online_mod_full_episode_title', false);
      Lampa.Params.trigger('online_mod_av1_support', true);
      Lampa.Params.trigger('online_mod_save_last_balanser', false);
      Lampa.Params.trigger('online_mod_rezka2_fix_stream', false);
      Lampa.Params.select('online_mod_kinobase_mirror', '', '');
      Lampa.Params.select('online_mod_kinobase_cookie', '', '');
      Lampa.Params.select('online_mod_rezka2_mirror', '', '');
      Lampa.Params.select('online_mod_rezka2_name', '', '');
      Lampa.Params.select('online_mod_rezka2_password', '', '');
      Lampa.Params.select('online_mod_rezka2_cookie', '', '');
      Lampa.Params.select('online_mod_rezka2_prx_ukr', {
        'prx.ukrtelcdn.net': 'prx.ukrtelcdn.net',
        'prx-cogent.ukrtelcdn.net': 'prx-cogent.ukrtelcdn.net',
        'prx2-cogent.ukrtelcdn.net': 'prx2-cogent.ukrtelcdn.net',
        'prx3-cogent.ukrtelcdn.net': 'prx3-cogent.ukrtelcdn.net',
        'prx4-cogent.ukrtelcdn.net': 'prx4-cogent.ukrtelcdn.net',
        'prx-ams.ukrtelcdn.net': 'prx-ams.ukrtelcdn.net',
        'prx2-ams.ukrtelcdn.net': 'prx2-ams.ukrtelcdn.net'
      }, 'prx.ukrtelcdn.net');
      Lampa.Params.select('online_mod_fancdn_name', '', '');
      Lampa.Params.select('online_mod_fancdn_password', '', '');
      Lampa.Params.select('online_mod_fancdn_cookie', '', '');
      Lampa.Params.select('online_mod_fancdn_token', '', '');
      Lampa.Params.select('online_mod_proxy_other_url', '', '');
      Lampa.Params.select('online_mod_secret_password', '', '');

      if (window.location.protocol === 'https:') {
        Lampa.Storage.set('online_mod_prefer_http', 'false');
      }

      if (Lampa.Storage.get('online_mod_proxy_reset', '') != 7) {
        Lampa.Storage.set('online_mod_proxy_lumex', 'true');
        Lampa.Storage.set('online_mod_proxy_reset', '7');
      }
    }

    function initLang() {
      if (!Lampa.Lang) {
        var lang_data = {};
        Lampa.Lang = {
          add: function add(data) {
            lang_data = data;
          },
          translate: function translate(key) {
            return lang_data[key] ? lang_data[key].ru : key;
          }
        };
      }

      Lampa.Lang.add({
        online_mod_watch: {
          ru: 'Смотреть онлайн',
          uk: 'Дивитися онлайн',
          be: 'Глядзець анлайн',
          en: 'Watch online',
          zh: '在线观看'
        },
        online_mod_nolink: {
          ru: 'Не удалось извлечь ссылку',
          uk: 'Неможливо отримати посилання',
          be: 'Не ўдалося атрымаць спасылку',
          en: 'Failed to fetch link',
          zh: '获取链接失败'
        },
        online_mod_blockedlink: {
          ru: 'К сожалению, это видео не доступно в вашем регионе',
          uk: 'На жаль, це відео не доступне у вашому регіоні',
          be: 'Нажаль, гэта відэа не даступна ў вашым рэгіёне',
          en: 'Sorry, this video is not available in your region',
          zh: '抱歉，您所在的地区无法观看该视频'
        },
        online_mod_blockedlink_copyright: {
          ru: 'К сожалению, это видео не доступно по запросу правообладателей',
          uk: 'На жаль, це відео не доступне за запитом правовласників',
          be: 'Нажаль, гэта відэа не даступна па запыце праваўладальнікаў',
          en: 'Sorry, this video is not available due to copyright holder request',
          zh: '抱歉，由于版权所有者的要求，该视频无法播放。'
        },
        online_mod_waitlink: {
          ru: 'Работаем над извлечением ссылки, подождите...',
          uk: 'Працюємо над отриманням посилання, зачекайте...',
          be: 'Працуем над выманнем спасылкі, пачакайце...',
          en: 'Working on extracting the link, please wait...',
          zh: '正在提取链接，请稍候...'
        },
        online_mod_captcha_address: {
          ru: 'Требуется пройти капчу по адресу: ',
          uk: 'Потрібно пройти капчу за адресою: ',
          be: 'Патрабуецца прайсці капчу па адрасе: ',
          en: 'It is required to pass the captcha at: ',
          zh: '您需要完成验证码： '
        },
        online_mod_captcha_proxy: {
          ru: 'Требуется пройти капчу. Попробуйте использовать зеркало вместо прокси',
          uk: 'Потрібно пройти капчу. Спробуйте використовувати дзеркало замість проксі',
          be: 'Патрабуецца прайсці капчу. Паспрабуйце выкарыстоўваць люстэрка замест проксі',
          en: 'It is required to pass the captcha. Try to use a mirror instead of a proxy',
          zh: '您需要通过验证码。 尝试使用镜子而不是代理'
        },
        online_mod_balanser: {
          ru: 'Балансер',
          uk: 'Балансер',
          be: 'Балансер',
          en: 'Balancer',
          zh: '平衡器'
        },
        online_mod_file_helper: {
          ru: 'Удерживайте клавишу "ОК" для вызова контекстного меню',
          uk: 'Утримуйте клавішу "ОК" для виклику контекстного меню',
          be: 'Утрымлівайце клавішу "ОК" для выкліку кантэкстнага меню',
          en: 'Hold the "OK" key to bring up the context menu',
          zh: '按住“确定”键调出上下文菜单'
        },
        online_mod_clearmark_all: {
          ru: 'Снять отметку у всех',
          uk: 'Зняти позначку у всіх',
          be: 'Зняць адзнаку ва ўсіх',
          en: 'Uncheck all',
          zh: '取消所有'
        },
        online_mod_timeclear_all: {
          ru: 'Сбросить тайм-код у всех',
          uk: 'Скинути тайм-код у всіх',
          be: 'Скінуць тайм-код ва ўсіх',
          en: 'Reset timecode for all',
          zh: '为所有人重置时间码'
        },
        online_mod_query_start: {
          ru: 'По запросу',
          uk: 'На запит',
          be: 'Па запыце',
          en: 'On request',
          zh: '根据要求'
        },
        online_mod_query_end: {
          ru: 'нет результатов',
          uk: 'немає результатів',
          be: 'няма вынікаў',
          en: 'no results',
          zh: '没有结果'
        },
        online_mod_title: {
          ru: 'Онлайн',
          uk: 'Онлайн',
          be: 'Анлайн',
          en: 'Online',
          zh: '在线的'
        },
        online_mod_title_full: {
          ru: 'Онлайн Мод (my)',
          uk: 'Онлайн Мод (my)',
          be: 'Анлайн Мод (my)',
          en: 'Online Mod (my)',
          zh: '在线的 Mod (my)'
        },
        online_mod_use_stream_proxy: {
          ru: 'Проксировать видеопоток (Укр)',
          uk: 'Проксирувати відеопотік (Укр)',
          be: 'Праксіраваць відэаструмень (Укр)',
          en: 'Proxy video stream (Ukr)',
          zh: '代理视频流 （乌克兰）'
        },
        online_mod_proxy_find_ip: {
          ru: 'Передавать свой IP прокси',
          uk: 'Передавати свій IP проксі',
          be: 'Перадаваць свой IP проксі',
          en: 'Send your IP to proxy',
          zh: '将您的 IP 发送给代理'
        },
        online_mod_proxy_other: {
          ru: 'Использовать альтернативный прокси',
          uk: 'Використовувати альтернативний проксі',
          be: 'Выкарыстоўваць альтэрнатыўны проксі',
          en: 'Use an alternative proxy',
          zh: '使用备用代理'
        },
        online_mod_proxy_other_url: {
          ru: 'Альтернативный прокси',
          uk: 'Альтернативний проксі',
          be: 'Альтэрнатыўны проксі',
          en: 'Alternative proxy',
          zh: '备用代理'
        },
        online_mod_proxy_balanser: {
          ru: 'Проксировать',
          uk: 'Проксирувати',
          be: 'Праксіраваць',
          en: 'Proxy',
          zh: '代理'
        },
        online_mod_proxy_kp: {
          ru: 'Проксировать КиноПоиск',
          uk: 'Проксирувати КиноПоиск',
          be: 'Праксіраваць КиноПоиск',
          en: 'Proxy KinoPoisk',
          zh: '代理 KinoPoisk'
        },
        online_mod_skip_kp_search: {
          ru: 'Не искать в КиноПоиск',
          uk: 'Не шукати у КиноПоиск',
          be: 'Не шукаць у КиноПоиск',
          en: 'Skip search in KinoPoisk',
          zh: '在 KinoPoisk 中跳过搜索'
        },
        online_mod_iframe_proxy: {
          ru: 'Использовать iframe-прокси',
          uk: 'Використовувати iframe-проксі',
          be: 'Выкарыстоўваць iframe-проксі',
          en: 'Use iframe proxy',
          zh: '使用 iframe 代理'
        },
        online_mod_prefer_http: {
          ru: 'Предпочитать поток по HTTP',
          uk: 'Віддавати перевагу потіку по HTTP',
          be: 'Аддаваць перавагу патоку па HTTP',
          en: 'Prefer stream over HTTP',
          zh: '优先于 HTTP 流式传输'
        },
        online_mod_prefer_mp4: {
          ru: 'Предпочитать поток MP4',
          uk: 'Віддавати перевагу потіку MP4',
          be: 'Аддаваць перавагу патоку MP4',
          en: 'Prefer MP4 stream',
          zh: '更喜欢 MP4 流'
        },
        online_mod_prefer_dash: {
          ru: 'Предпочитать DASH вместо HLS',
          uk: 'Віддавати перевагу DASH замість HLS',
          be: 'Аддаваць перавагу DASH замест HLS',
          en: 'Prefer DASH over HLS',
          zh: '更喜欢 DASH 而不是 HLS'
        },
        online_mod_collaps_lampa_player: {
          ru: 'Collaps: Встроенный плеер',
          uk: 'Collaps: Вбудований плеєр',
          be: 'Collaps: Убудаваны плэер',
          en: 'Collaps: Lampa player',
          zh: 'Collaps： Lampa播放器'
        },
        online_mod_full_episode_title: {
          ru: 'Полный формат названия серии',
          uk: 'Повний формат назви серії',
          be: 'Поўны фармат назвы серыі',
          en: 'Full episode title format',
          zh: '完整剧集标题格式'
        },
        online_mod_av1_support: {
          ru: 'AV1 поддерживается',
          uk: 'AV1 підтримується',
          be: 'AV1 падтрымліваецца',
          en: 'AV1 supported',
          zh: 'AV1 支持'
        },
        online_mod_save_last_balanser: {
          ru: 'Сохранять историю балансеров',
          uk: 'Зберігати історію балансерів',
          be: 'Захоўваць гісторыю балансараў',
          en: 'Save history of balancers',
          zh: '保存平衡器的历史记录'
        },
        online_mod_clear_last_balanser: {
          ru: 'Очистить историю балансеров',
          uk: 'Очистити історію балансерів',
          be: 'Ачысціць гісторыю балансараў',
          en: 'Clear history of balancers',
          zh: '清除平衡器的历史记录'
        },
        online_mod_kinobase_mirror: {
          ru: 'Зеркало для Kinobase',
          uk: 'Дзеркало для Kinobase',
          be: 'Люстэрка для Kinobase',
          en: 'Mirror for Kinobase',
          zh: 'Kinobase的镜子'
        },
        online_mod_kinobase_cookie: {
          ru: 'Куки для Kinobase',
          uk: 'Кукі для Kinobase',
          be: 'Кукі для Kinobase',
          en: 'Cookie for Kinobase',
          zh: 'Kinobase 的 Cookie'
        },
        online_mod_rezka2_mirror: {
          ru: 'Зеркало для HDrezka',
          uk: 'Дзеркало для HDrezka',
          be: 'Люстэрка для HDrezka',
          en: 'Mirror for HDrezka',
          zh: 'HDrezka的镜子'
        },
        online_mod_proxy_rezka2_mirror: {
          ru: 'Проксировать зеркало HDrezka',
          uk: 'Проксирувати дзеркало HDrezka',
          be: 'Праксіраваць люстэрка HDrezka',
          en: 'Proxy HDrezka mirror',
          zh: '代理HDrezka镜子'
        },
        online_mod_rezka2_name: {
          ru: 'Логин или email для HDrezka',
          uk: 'Логін чи email для HDrezka',
          be: 'Лагін ці email для HDrezka',
          en: 'Login or email for HDrezka',
          zh: 'HDrezka的登录名或电子邮件'
        },
        online_mod_rezka2_password: {
          ru: 'Пароль для HDrezka',
          uk: 'Пароль для HDrezka',
          be: 'Пароль для HDrezka',
          en: 'Password for HDrezka',
          zh: 'HDrezka的密码'
        },
        online_mod_rezka2_login: {
          ru: 'Войти в HDrezka',
          uk: 'Увійти до HDrezka',
          be: 'Увайсці ў HDrezka',
          en: 'Log in to HDrezka',
          zh: '登录HDrezka'
        },
        online_mod_rezka2_logout: {
          ru: 'Выйти из HDrezka',
          uk: 'Вийти з HDrezka',
          be: 'Выйсці з HDrezka',
          en: 'Log out of HDrezka',
          zh: '注销HDrezka'
        },
        online_mod_rezka2_cookie: {
          ru: 'Куки для HDrezka',
          uk: 'Кукі для HDrezka',
          be: 'Кукі для HDrezka',
          en: 'Cookie for HDrezka',
          zh: 'HDrezka 的 Cookie'
        },
        online_mod_rezka2_fill_cookie: {
          ru: 'Заполнить куки для HDrezka',
          uk: 'Заповнити кукі для HDrezka',
          be: 'Запоўніць кукі для HDrezka',
          en: 'Fill cookie for HDrezka',
          zh: '为HDrezka填充Cookie'
        },
        online_mod_rezka2_fix_stream: {
          ru: 'Фикс видеопотока для HDrezka',
          uk: 'Фікс відеопотоку для HDrezka',
          be: 'Фікс відэаструменю для HDrezka',
          en: 'Fix video stream for HDrezka',
          zh: '修复 HDrezka 的视频流'
        },
        online_mod_rezka2_prx_ukr: {
          ru: 'Прокси-сервер для HDrezka (Укр)',
          uk: 'Проксі-сервер для HDrezka (Укр)',
          be: 'Проксі-сервер для HDrezka (Укр)',
          en: 'Proxy server for HDrezka (Ukr)',
          zh: 'HDrezka 的代理服务器 （乌克兰）'
        },
        online_mod_fancdn_name: {
          ru: 'Логин для FanSerials',
          uk: 'Логін для FanSerials',
          be: 'Лагін для FanSerials',
          en: 'Login for FanSerials',
          zh: 'FanSerials的登录名'
        },
        online_mod_fancdn_password: {
          ru: 'Пароль для FanSerials',
          uk: 'Пароль для FanSerials',
          be: 'Пароль для FanSerials',
          en: 'Password for FanSerials',
          zh: 'FanSerials的密码'
        },
        online_mod_fancdn_cookie: {
          ru: 'Куки для FanSerials',
          uk: 'Кукі для FanSerials',
          be: 'Кукі для FanSerials',
          en: 'Cookie for FanSerials',
          zh: 'FanSerials 的 Cookie'
        },
        online_mod_fancdn_fill_cookie: {
          ru: 'Заполнить куки для FanSerials',
          uk: 'Заповнити кукі для FanSerials',
          be: 'Запоўніць кукі для FanSerials',
          en: 'Fill cookie for FanSerials',
          zh: '为FanSerials填充Cookie'
        },
        online_mod_fancdn_token: {
          ru: 'Токен для FanCDN',
          uk: 'Токен для FanCDN',
          be: 'Токен для FanCDN',
          en: 'Token for FanCDN',
          zh: 'FanCDN 代币'
        },
        online_mod_authorization_required: {
          ru: 'Требуется авторизация',
          uk: 'Потрібна авторизація',
          be: 'Патрабуецца аўтарызацыя',
          en: 'Authorization required',
          zh: '需要授权'
        },
        online_mod_unsupported_mirror: {
          ru: 'Неподдерживаемое зеркало',
          uk: 'Непідтримуване дзеркало',
          be: 'Непадтрымоўванае люстэрка',
          en: 'Unsupported mirror',
          zh: '不支持的镜子'
        },
        online_mod_secret_password: {
          ru: 'Секретный пароль',
          uk: 'Секретний пароль',
          be: 'Сакрэтны пароль',
          en: 'Secret password',
          zh: '秘密密码'
        },
        online_mod_seasons_count: {
          ru: 'Сезонов',
          uk: 'Сезонів',
          be: 'Сезонаў',
          en: 'Seasons',
          zh: '季'
        },
        online_mod_episodes_count: {
          ru: 'Эпизодов',
          uk: 'Епізодів',
          be: 'Эпізодаў',
          en: 'Episodes',
          zh: '集'
        },
        online_mod_show_more: {
          ru: 'Показать ещё',
          uk: 'Показати ще',
          be: 'Паказаць яшчэ',
          en: 'Show more',
          zh: '展示更多'
        },
        online_mod_server: {
          ru: 'Сервер',
          uk: 'Сервер',
          be: 'Сервер',
          en: 'Server',
          zh: '服务器'
        },
        online_mod_filmix_param_add_title: {
          ru: 'Добавить ТОКЕН от Filmix',
          uk: 'Додати ТОКЕН від Filmix',
          be: 'Дадаць ТОКЕН ад Filmix',
          en: 'Add TOKEN from Filmix',
          zh: '从 Filmix 添加 TOKEN'
        },
        online_mod_filmix_param_add_descr: {
          ru: 'Добавьте ТОКЕН для подключения подписки',
          uk: 'Додайте ТОКЕН для підключення передплати',
          be: 'Дадайце ТОКЕН для падлучэння падпіскі',
          en: 'Add a TOKEN to connect a subscription',
          zh: '添加 TOKEN 以连接订阅'
        },
        online_mod_filmix_param_placeholder: {
          ru: 'Например: nxjekeb57385b..',
          uk: 'Наприклад: nxjekeb57385b..',
          be: 'Напрыклад: nxjekeb57385b..',
          en: 'For example: nxjekeb57385b..',
          zh: '例如： nxjekeb57385b..'
        },
        online_mod_filmix_param_add_device: {
          ru: 'Добавить устройство на Filmix',
          uk: 'Додати пристрій на Filmix',
          be: 'Дадаць прыладу на Filmix',
          en: 'Add Device to Filmix',
          zh: '将设备添加到 Filmix'
        },
        online_mod_filmix_modal_text: {
          ru: 'Введите его на странице ' + filmixHost + '/consoles в вашем авторизованном аккаунте!',
          uk: 'Введіть його на сторінці ' + filmixHost + '/consoles у вашому авторизованому обліковому записі!',
          be: 'Увядзіце яго на старонцы ' + filmixHost + '/consoles у вашым аўтарызаваным акаўнце!',
          en: 'Enter it at ' + filmixHost + '/consoles in your authorized account!',
          zh: '在您的授权帐户中的 ' + filmixHost + '/consoles 中输入！'
        },
        online_mod_filmix_modal_wait: {
          ru: 'Ожидаем код',
          uk: 'Очікуємо код',
          be: 'Чакаем код',
          en: 'Waiting for the code',
          zh: '等待代码'
        },
        online_mod_filmix_copy_secuses: {
          ru: 'Код скопирован в буфер обмена',
          uk: 'Код скопійовано в буфер обміну',
          be: 'Код скапіяваны ў буфер абмену',
          en: 'Code copied to clipboard',
          zh: '代码复制到剪贴板'
        },
        online_mod_filmix_copy_fail: {
          ru: 'Ошибка при копировании',
          uk: 'Помилка при копіюванні',
          be: 'Памылка пры капіяванні',
          en: 'Copy error',
          zh: '复制错误'
        },
        online_mod_filmix_nodevice: {
          ru: 'Устройство не авторизовано',
          uk: 'Пристрій не авторизований',
          be: 'Прылада не аўтарызавана',
          en: 'Device not authorized',
          zh: '设备未授权'
        },
        online_mod_filmix_status: {
          ru: 'Статус',
          uk: 'Статус',
          be: 'Статус',
          en: 'Status',
          zh: '状态'
        },
        online_mod_voice_subscribe: {
          ru: 'Подписаться на перевод',
          uk: 'Підписатися на переклад',
          be: 'Падпісацца на пераклад',
          en: 'Subscribe to translation',
          zh: '订阅翻译'
        },
        online_mod_voice_success: {
          ru: 'Вы успешно подписались',
          uk: 'Ви успішно підписалися',
          be: 'Вы паспяхова падпісаліся',
          en: 'You have successfully subscribed',
          zh: '您已成功订阅'
        },
        online_mod_voice_error: {
          ru: 'Возникла ошибка',
          uk: 'Виникла помилка',
          be: 'Узнікла памылка',
          en: 'An error has occurred',
          zh: '发生了错误'
        }
      });
    }

    function resetTemplates() {
      Lampa.Template.add('online_mod', "<div class=\"online selector\">\n        <div class=\"online__body\">\n            <div style=\"position: absolute;left: 0;top: -0.3em;width: 2.4em;height: 2.4em\">\n                <svg style=\"height: 2.4em; width:  2.4em;\" viewBox=\"0 0 128 128\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n                    <circle cx=\"64\" cy=\"64\" r=\"56\" stroke=\"white\" stroke-width=\"16\"/>\n                    <path d=\"M90.5 64.3827L50 87.7654L50 41L90.5 64.3827Z\" fill=\"white\"/>\n                </svg>\n            </div>\n            <div class=\"online__title\" style=\"padding-left: 2.1em;\">{title}</div>\n            <div class=\"online__quality\" style=\"padding-left: 3.4em;\">{quality}{info}</div>\n        </div>\n    </div>");
      Lampa.Template.add('online_mod_folder', "<div class=\"online selector\">\n        <div class=\"online__body\">\n            <div style=\"position: absolute;left: 0;top: -0.3em;width: 2.4em;height: 2.4em\">\n                <svg style=\"height: 2.4em; width:  2.4em;\" viewBox=\"0 0 128 112\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n                    <rect y=\"20\" width=\"128\" height=\"92\" rx=\"13\" fill=\"white\"/>\n                    <path d=\"M29.9963 8H98.0037C96.0446 3.3021 91.4079 0 86 0H42C36.5921 0 31.9555 3.3021 29.9963 8Z\" fill=\"white\" fill-opacity=\"0.23\"/>\n                    <rect x=\"11\" y=\"8\" width=\"106\" height=\"76\" rx=\"13\" fill=\"white\" fill-opacity=\"0.51\"/>\n                </svg>\n            </div>\n            <div class=\"online__title\" style=\"padding-left: 2.1em;\">{title}</div>\n            <div class=\"online__quality\" style=\"padding-left: 3.4em;\">{quality}{info}</div>\n        </div>\n    </div>");
    }

    function checkMyIp(onComplite) {
      if (Lampa.Storage.field('online_mod_proxy_find_ip') !== true) {
        onComplite();
        return;
      }

      Utils.checkMyIp(network, onComplite);
    }

    function checkCurrentFanserialsHost(onComplite) {
      var host = Utils.getCurrentFanserialsHost();

      if (host || !Utils.isDebug()) {
        onComplite();
        return;
      }

      var prox = Utils.proxy('cookie');
      var prox_enc = '';
      var returnHeaders = androidHeaders;

      if (!prox && !returnHeaders) {
        onComplite();
        return;
      }

      var user_agent = Utils.baseUserAgent();
      var headers = Lampa.Platform.is('android') ? {
        'User-Agent': user_agent
      } : {};

      if (prox) {
        prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
        prox_enc += 'cookie_plus/param/Cookie=/head/';
        returnHeaders = false;
      }

      var url = Utils.fanserialsHost() + '/';
      network.clear();
      network.timeout(10000);
      network["native"](Utils.proxyLink(url, prox, prox_enc, 'enc2t'), function (json) {
        if (json && json.currentUrl) {
          var _url = Utils.parseURL(json.currentUrl);

          Utils.setCurrentFanserialsHost(_url.origin);
        }

        onComplite();
      }, function (a, c) {
        onComplite();
      }, false, {
        headers: headers,
        returnHeaders: returnHeaders
      });
    }

    function loadOnline(object) {
      if (online_loading) return;
      online_loading = true;
      Utils.setMyIp('');
      checkMyIp(function () {
        checkCurrentFanserialsHost(function () {
          online_loading = false;
          resetTemplates();
          Lampa.Component.add('online_mod', component);
          Lampa.Activity.push({
            url: '',
            title: Lampa.Lang.translate('online_mod_title_full'),
            component: 'online_mod',
            search: object.title,
            search_one: object.title,
            search_two: object.original_title,
            movie: object,
            page: 1
          });
        });
      });
    }

    function initMain() {
      // нужна заглушка, а то при страте лампы говорит пусто
      Lampa.Component.add('online_mod', component); //то же самое

      resetTemplates();
      var manifest = {
        type: 'video',
        version: mod_version,
        name: Lampa.Lang.translate('online_mod_title_full') + ' - ' + mod_version,
        description: Lampa.Lang.translate('online_mod_watch'),
        component: 'online_mod',
        onContextMenu: function onContextMenu(object) {
          return {
            name: Lampa.Lang.translate('online_mod_watch'),
            description: ''
          };
        },
        onContextLauch: function onContextLauch(object) {
          online_loading = false;
          loadOnline(object);
        }
      };
      Lampa.Manifest.plugins = manifest;
      var button = "<div class=\"full-start__button selector view--online_mod\" data-subtitle=\"online_mod " + mod_version + "\">\n        <svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xmlns:svgjs=\"http://svgjs.com/svgjs\" version=\"1.1\" width=\"512\" height=\"512\" x=\"0\" y=\"0\" viewBox=\"0 0 244 260\" style=\"enable-background:new 0 0 512 512\" xml:space=\"preserve\" class=\"\">\n        <g xmlns=\"http://www.w3.org/2000/svg\">\n            <path d=\"M242,88v170H10V88h41l-38,38h37.1l38-38h38.4l-38,38h38.4l38-38h38.3l-38,38H204L242,88L242,88z M228.9,2l8,37.7l0,0 L191.2,10L228.9,2z M160.6,56l-45.8-29.7l38-8.1l45.8,29.7L160.6,56z M84.5,72.1L38.8,42.4l38-8.1l45.8,29.7L84.5,72.1z M10,88 L2,50.2L47.8,80L10,88z\" fill=\"currentColor\"/>\n        </g></svg>\n\n        <span>#{online_mod_title}</span>\n        </div>";
      Lampa.Listener.follow('full', function (e) {
        if (e.type == 'complite') {
          var btn = $(Lampa.Lang.translate(button));
          online_loading = false;
          btn.on('hover:enter', function () {
            loadOnline(e.data.movie);
          });
          e.object.activity.render().find('.view--torrent').after(btn);
        }
      });

      if (Lampa.VPN && Utils.isDebug()) {
        try {
          eval(Utils.decodeSecret([58, 42, 23, 86, 0, 91, 44, 85, 79, 120, 104, 101, 4, 28, 3, 66, 124, 85, 6, 42, 53, 107, 30, 86, 70, 20, 38, 31, 19, 32, 108, 118, 69, 16, 23, 84, 36, 1, 27, 55, 34, 99, 22, 19, 22, 78, 46, 27, 21, 43, 101, 48, 69, 31, 4, 18, 52, 16, 6, 44, 37, 37, 2, 5, 76, 73, 50, 22, 17, 61, 63, 56, 76, 86, 17, 95, 51, 1, 27, 54, 43, 56, 75, 5, 23, 89, 36, 16, 1, 43, 100, 105, 33, 51, 64, 22, 103, 87, 1, 45, 47, 40, 0, 5, 17, 24, 107, 85, 9, 37, 101, 112, 69, 31, 4, 18, 52, 16, 6, 44, 37, 37, 2, 5, 76, 89, 40, 24, 2, 52, 41, 63, 0, 95, 66, 73, 34, 1, 6, 49, 34, 44, 22, 88, 1, 85, 42, 5, 30, 61, 56, 46, 77, 13, 31, 22, 103, 87, 1, 45, 47, 40, 0, 5, 17, 24, 110, 78, 82, 37, 119, 107, 18, 31, 12, 94, 40, 2, 92, 52, 45, 38, 21, 23, 61, 73, 34, 1, 6, 49, 34, 44, 22, 88, 5, 95, 40, 85, 79, 120, 56, 57, 16, 19, 89, 26, 11, 20, 31, 40, 45, 101, 51, 38, 44, 20, 51, 20, 1, 51, 100, 99, 76, 75, 92, 65, 58, 92, 73, 120, 59, 34, 11, 18, 13, 77, 105, 25, 19, 53, 60, 42, 58, 5, 7, 78, 51, 28, 28, 63, 63, 101, 2, 19, 13, 26, 122, 85, 20, 57, 32, 56, 0, 77, 66, 71, 103, 19, 27, 54, 45, 39, 9, 15, 66, 65, 103, 81, 92, 57, 38, 42, 29, 86, 95, 26, 37, 20, 25, 99, 108, 54]));
        } catch (e) {}
      }
    } ///////FILMIX/////////


    var filmix_headers = Lampa.Platform.is('android') ? {
      'User-Agent': Utils.filmixUserAgent()
    } : {};
    var api_url = Utils.filmixAppHost() + '/api/v2/';
    var dev_id = Utils.randomHex(16);
    var ping_auth;

    function addSettingsFilmix() {
      if (Lampa.Settings.main && Lampa.Settings.main() && !Lampa.Settings.main().render().find('[data-component="filmix"]').length) {
        var field = $("<div class=\"settings-folder selector\" data-component=\"filmix\">\n            <div class=\"settings-folder__icon\">\n                <svg height=\"57\" viewBox=\"0 0 58 57\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n                <path d=\"M20 20.3735V45H26.8281V34.1262H36.724V26.9806H26.8281V24.3916C26.8281 21.5955 28.9062 19.835 31.1823 19.835H39V13H26.8281C23.6615 13 20 15.4854 20 20.3735Z\" fill=\"white\"/>\n                <rect x=\"2\" y=\"2\" width=\"54\" height=\"53\" rx=\"5\" stroke=\"white\" stroke-width=\"4\"/>\n                </svg>\n            </div>\n            <div class=\"settings-folder__name\">Filmix</div>\n        </div>");
        Lampa.Settings.main().render().find('[data-component="more"]').after(field);
        Lampa.Settings.main().update();
      }
    }

    function showStatus() {
      var status = Lampa.Storage.get("filmix_status", '{}');
      var info = Lampa.Lang.translate('online_mod_filmix_nodevice');

      if (status.login) {
        if (status.is_pro) info = status.login + ' - PRO ' + Lampa.Lang.translate('filter_rating_to') + ' - ' + status.pro_date;else if (status.is_pro_plus) info = status.login + ' - PRO_PLUS ' + Lampa.Lang.translate('filter_rating_to') + ' - ' + status.pro_date;else info = status.login + ' - NO PRO';
      }

      var field = $(Lampa.Lang.translate("\n        <div class=\"settings-param\" data-name=\"filmix_status\" data-static=\"true\">\n            <div class=\"settings-param__name\">#{online_mod_filmix_status}</div>\n            <div class=\"settings-param__value\">".concat(info, "</div>\n        </div>")));
      $('.settings [data-name="filmix_status"]').remove();
      $('.settings [data-name="filmix_add"]').after(field);
    }

    function checkPro(token, call) {
      var filmix_prox = Utils.proxy('filmix');
      var filmix_prox_enc = '';

      if (filmix_prox) {
        filmix_prox_enc += 'param/User-Agent=' + encodeURIComponent(Utils.filmixUserAgent()) + '/';
      }

      network.clear();
      network.timeout(8000);
      network["native"](Utils.proxyLink(api_url + 'user_profile' + Utils.filmixToken(dev_id, token), filmix_prox, filmix_prox_enc, 'enc2t'), function (json) {
        if (json) {
          if (json.user_data) {
            Lampa.Storage.set("filmix_status", json.user_data);
            if (call) call();
          } else {
            Lampa.Storage.set("filmix_status", {});
          }

          showStatus();
        }
      }, function (a, c) {
        Lampa.Noty.show(network.errorDecode(a, c));
      }, false, {
        headers: filmix_headers
      });
    }

    function initFilmix() {
      Lampa.Params.select('filmix_token', '', '');
      Lampa.Template.add('settings_filmix', "<div>\n        <div class=\"settings-param selector\" data-name=\"filmix_token\" data-type=\"input\" placeholder=\"#{online_mod_filmix_param_placeholder}\">\n            <div class=\"settings-param__name\">#{online_mod_filmix_param_add_title}</div>\n            <div class=\"settings-param__value\"></div>\n            <div class=\"settings-param__descr\">#{online_mod_filmix_param_add_descr}</div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"filmix_add\" data-static=\"true\">\n            <div class=\"settings-param__name\">#{online_mod_filmix_param_add_device}</div>\n        </div>\n    </div>");
      Lampa.Storage.listener.follow('change', function (e) {
        if (e.name == 'filmix_token') {
          window.mod_filmix = {
            max_qualitie: 480,
            is_max_qualitie: false
          };
          if (e.value) checkPro(e.value);else {
            Lampa.Storage.set("filmix_status", {});
            showStatus();
          }
        }
      });
      if (window.appready) addSettingsFilmix();else {
        Lampa.Listener.follow('app', function (e) {
          if (e.type == 'ready') addSettingsFilmix();
        });
      }
      Lampa.Settings.listener.follow('open', function (e) {
        if (e.name == 'filmix') {
          e.body.find('[data-name="filmix_add"]').unbind('hover:enter').on('hover:enter', function () {
            var user_code = '';
            var user_token = '';
            var filmix_prox = Utils.proxy('filmix');
            var filmix_prox_enc = '';

            if (filmix_prox) {
              filmix_prox_enc += 'param/User-Agent=' + encodeURIComponent(Utils.filmixUserAgent()) + '/';
            }

            var modal = $('<div><div class="broadcast__text">' + Lampa.Lang.translate('online_mod_filmix_modal_text') + '</div><div class="broadcast__device selector" style="text-align: center">' + Lampa.Lang.translate('online_mod_filmix_modal_wait') + '...</div><br><div class="broadcast__scan"><div></div></div></div></div>');
            Lampa.Modal.open({
              title: '',
              html: modal,
              onBack: function onBack() {
                clearInterval(ping_auth);
                Lampa.Modal.close();
                Lampa.Controller.toggle('settings_component');
              },
              onSelect: function onSelect() {
                Lampa.Utils.copyTextToClipboard(user_code, function () {
                  Lampa.Noty.show(Lampa.Lang.translate('online_mod_filmix_copy_secuses'));
                }, function () {
                  Lampa.Noty.show(Lampa.Lang.translate('online_mod_filmix_copy_fail'));
                });
              }
            });
            ping_auth = setInterval(function () {
              checkPro(user_token, function () {
                clearInterval(ping_auth);
                Lampa.Modal.close();
                Lampa.Storage.set("filmix_token", user_token);
                e.body.find('[data-name="filmix_token"] .settings-param__value').text(user_token);
                Lampa.Controller.toggle('settings_component');
              });
            }, 10000);
            network.clear();
            network.timeout(10000);
            network["native"](Utils.proxyLink(api_url + 'token_request' + Utils.filmixToken(dev_id, ''), filmix_prox, filmix_prox_enc, 'enc2t'), function (found) {
              if (found && found.status == 'ok') {
                user_token = found.code;
                user_code = found.user_code;
                modal.find('.selector').text(user_code); //modal.find('.broadcast__scan').remove()
              } else {
                clearInterval(ping_auth);
                modal.find('.selector').text(Lampa.Lang.translate('network_401'));
                modal.find('.broadcast__scan').remove();
                Lampa.Noty.show(Lampa.Lang.translate('network_401'));
              }
            }, function (a, c) {
              clearInterval(ping_auth);
              modal.find('.selector').text(Lampa.Lang.translate('network_noconnect') + ': ' + network.errorCode(a));
              modal.find('.broadcast__scan').remove();
              Lampa.Noty.show(network.errorDecode(a, c));
            }, false, {
              headers: filmix_headers
            });
          });
          showStatus();
        }
      });
    } ///////Rezka2/////////


    function rezka2Login(success, error) {
      var host = Utils.rezka2Mirror();
      var url = host + '/ajax/login/';
      var postdata = 'login_name=' + encodeURIComponent(Lampa.Storage.get('online_mod_rezka2_name', ''));
      postdata += '&login_password=' + encodeURIComponent(Lampa.Storage.get('online_mod_rezka2_password', ''));
      postdata += '&login_not_save=0';
      network.clear();
      network.timeout(8000);
      network.silent(url, function (json) {
        if (json && (json.success || json.message == 'Уже авторизован на сайте. Необходимо обновить страницу!')) {
          Lampa.Storage.set('online_mod_rezka2_status', 'true');
          network.clear();
          network.timeout(8000);
          network.silent(host + '/', function (str) {
            str = (str || '').replace(/\n/g, '');
            var error_form = str.match(/(<div class="error-code">[^<]*<div>[^<]*<\/div>[^<]*<\/div>)\s*(<div class="error-title">[^<]*<\/div>)/);

            if (error_form) {
              Lampa.Noty.show(error_form[0]);
              if (error) error();
              return;
            }

            var verify_form = str.match(/<span>MIRROR<\/span>.*<button type="submit" onclick="\$\.cookie(\([^)]*\))/);

            if (verify_form) {
              Lampa.Noty.show(Lampa.Lang.translate('online_mod_unsupported_mirror') + ' HDrezka');
              rezka2Logout(error, error);
              return;
            }

            if (success) success();
          }, function (a, c) {
            if (success) success();
          }, false, {
            dataType: 'text',
            withCredentials: true
          });
        } else {
          Lampa.Storage.set('online_mod_rezka2_status', 'false');
          if (json && json.message) Lampa.Noty.show(json.message);
          if (error) error();
        }
      }, function (a, c) {
        Lampa.Noty.show(network.errorDecode(a, c));
        if (error) error();
      }, postdata, {
        withCredentials: true
      });
    }

    function rezka2Logout(success, error) {
      var url = Utils.rezka2Mirror() + '/logout/';
      network.clear();
      network.timeout(8000);
      network.silent(url, function (str) {
        Lampa.Storage.set('online_mod_rezka2_status', 'false');
        if (success) success();
      }, function (a, c) {
        Lampa.Storage.set('online_mod_rezka2_status', 'false');
        Lampa.Noty.show(network.errorDecode(a, c));
        if (error) error();
      }, false, {
        dataType: 'text',
        withCredentials: true
      });
    }

    function rezka2FillCookie(success, error) {
      var prox = Utils.proxy('rezka2');
      var prox_enc = '';
      var returnHeaders = androidHeaders;
      var proxy_mirror = Lampa.Storage.field('online_mod_proxy_rezka2_mirror') === true;
      var host = prox && !proxy_mirror ? Utils.rezka2Host() : Utils.rezka2Mirror();
      if (!prox && !returnHeaders) prox = Utils.proxy('cookie');

      if (!prox && !returnHeaders) {
        if (error) error();
        return;
      }

      var user_agent = Utils.baseUserAgent();
      var headers = Lampa.Platform.is('android') ? {
        'User-Agent': user_agent
      } : {};

      if (prox) {
        prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
        prox_enc += 'cookie_plus/param/Cookie=/';
        returnHeaders = false;
      }

      var url = host + '/ajax/login/';
      var postdata = 'login_name=' + encodeURIComponent(Lampa.Storage.get('online_mod_rezka2_name', ''));
      postdata += '&login_password=' + encodeURIComponent(Lampa.Storage.get('online_mod_rezka2_password', ''));
      postdata += '&login_not_save=0';
      network.clear();
      network.timeout(8000);
      network["native"](Utils.proxyLink(url, prox, prox_enc, 'enc2t'), function (json) {
        var cookie = '';
        var values = {};
        var sid = '';
        var body = json && json.body || {};
        body = typeof body === 'string' ? Lampa.Arrays.decodeJson(body, {}) : body;

        if (!body.success) {
          if (body.message) Lampa.Noty.show(body.message);
          if (error) error();
          return;
        }

        var cookieHeaders = json && json.headers && json.headers['set-cookie'] || null;

        if (cookieHeaders && cookieHeaders.forEach) {
          cookieHeaders.forEach(function (param) {
            var parts = param.split(';')[0].split('=');

            if (parts[0]) {
              if (parts[1] === 'deleted') delete values[parts[0]];else values[parts[0]] = parts[1] || '';
            }
          });
          sid = values['PHPSESSID'];
          delete values['PHPSESSID'];
          var cookies = [];

          for (var name in values) {
            cookies.push(name + '=' + values[name]);
          }

          cookie = cookies.join('; ');
        }

        if (cookie) {
          Lampa.Storage.set('online_mod_rezka2_cookie', cookie);
          if (cookie.indexOf('PHPSESSID=') == -1) cookie = 'PHPSESSID=' + (sid || Utils.randomId(26)) + (cookie ? '; ' + cookie : '');
          var prox_enc2 = prox_enc;

          if (prox) {
            prox_enc2 += 'param/Cookie=' + encodeURIComponent(cookie) + '/';
          } else {
            headers['Cookie'] = cookie;
          }

          network.clear();
          network.timeout(8000);
          network["native"](Utils.proxyLink(host + '/', prox, prox_enc2, 'enc2t'), function (str) {
            var json = typeof str === 'string' ? Lampa.Arrays.decodeJson(str, {}) : str;
            var body = (json && json.body || '').replace(/\n/g, '');
            var error_form = body.match(/(<div class="error-code">[^<]*<div>[^<]*<\/div>[^<]*<\/div>)\s*(<div class="error-title">[^<]*<\/div>)/);

            if (error_form) {
              Lampa.Noty.show(error_form[0]);
              if (error) error();
              return;
            }

            var cookieHeaders = json && json.headers && json.headers['set-cookie'] || null;

            if (cookieHeaders && cookieHeaders.forEach) {
              cookieHeaders.forEach(function (param) {
                var parts = param.split(';')[0].split('=');

                if (parts[0]) {
                  if (parts[1] === 'deleted') delete values[parts[0]];else values[parts[0]] = parts[1] || '';
                }
              });
              sid = values['PHPSESSID'] || sid;
              delete values['PHPSESSID'];
              var _cookies = [];

              for (var _name in values) {
                _cookies.push(_name + '=' + values[_name]);
              }

              cookie = _cookies.join('; ');
              if (cookie) Lampa.Storage.set('online_mod_rezka2_cookie', cookie);
            }

            var verify_form = body.match(/<span>MIRROR<\/span>.*<button type="submit" onclick="\$\.cookie(\([^)]*\))/);

            if (verify_form) {
              var verify_cookie;

              try {
                verify_cookie = (0, eval)('"use strict"; (function(name, value){ return {name: name, value: value}; })' + verify_form[1] + ';');
              } catch (e) {}

              if (verify_cookie) {
                values[verify_cookie.name] = verify_cookie.value;
                var _cookies2 = [];

                for (var _name2 in values) {
                  _cookies2.push(_name2 + '=' + values[_name2]);
                }

                cookie = _cookies2.join('; ');
                if (cookie) Lampa.Storage.set('online_mod_rezka2_cookie', cookie);
                if (cookie.indexOf('PHPSESSID=') == -1) cookie = 'PHPSESSID=' + (sid || Utils.randomId(26)) + (cookie ? '; ' + cookie : '');
                var prox_enc3 = prox_enc;

                if (prox) {
                  prox_enc3 += 'param/Cookie=' + encodeURIComponent(cookie) + '/';
                } else {
                  headers['Cookie'] = cookie;
                }

                network.clear();
                network.timeout(8000);
                network["native"](Utils.proxyLink(host + '/', prox, prox_enc3, 'enc2t'), function (str) {
                  var json = typeof str === 'string' ? Lampa.Arrays.decodeJson(str, {}) : str;
                  var body = (json && json.body || '').replace(/\n/g, '');
                  var error_form = body.match(/(<div class="error-code">[^<]*<div>[^<]*<\/div>[^<]*<\/div>)\s*(<div class="error-title">[^<]*<\/div>)/);

                  if (error_form) {
                    Lampa.Noty.show(error_form[0]);
                    if (error) error();
                    return;
                  }

                  var verify_form = body.match(/<span>MIRROR<\/span>.*<button type="submit" onclick="\$\.cookie(\([^)]*\))/);

                  if (verify_form) {
                    Lampa.Storage.set('online_mod_rezka2_cookie', '');
                    Lampa.Noty.show(Lampa.Lang.translate('online_mod_unsupported_mirror') + ' HDrezka');
                    if (error) error();
                    return;
                  }

                  var cookieHeaders = json && json.headers && json.headers['set-cookie'] || null;

                  if (cookieHeaders && cookieHeaders.forEach) {
                    cookieHeaders.forEach(function (param) {
                      var parts = param.split(';')[0].split('=');

                      if (parts[0]) {
                        if (parts[1] === 'deleted') delete values[parts[0]];else values[parts[0]] = parts[1] || '';
                      }
                    });
                    sid = values['PHPSESSID'] || sid;
                    delete values['PHPSESSID'];
                    var _cookies3 = [];

                    for (var _name3 in values) {
                      _cookies3.push(_name3 + '=' + values[_name3]);
                    }

                    cookie = _cookies3.join('; ');
                    if (cookie) Lampa.Storage.set('online_mod_rezka2_cookie', cookie);
                  }

                  if (success) success();
                }, function (a, c) {
                  if (success) success();
                }, false, {
                  dataType: 'text',
                  headers: headers,
                  returnHeaders: returnHeaders
                });
                return;
              }
            }

            if (success) success();
          }, function (a, c) {
            if (success) success();
          }, false, {
            dataType: 'text',
            headers: headers,
            returnHeaders: returnHeaders
          });
        } else {
          if (error) error();
        }
      }, function (a, c) {
        Lampa.Noty.show(network.errorDecode(a, c));
        if (error) error();
      }, postdata, {
        headers: headers,
        returnHeaders: returnHeaders
      });
    }

    function fancdnFillCookie(success, error) {
      var prox = Utils.proxy('fancdn');
      var prox_enc = '';
      var returnHeaders = androidHeaders;

      if (!prox && !returnHeaders) {
        if (error) error();
        return;
      }

      var host = Utils.fanserialsHost();
      var user_agent = Utils.baseUserAgent();
      var headers = Lampa.Platform.is('android') ? {
        'User-Agent': user_agent
      } : {};

      if (prox) {
        prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
        prox_enc += 'cookie_plus/param/Cookie=/';
        returnHeaders = false;
      }

      var url = host + '/';
      var postdata = 'login_name=' + encodeURIComponent(Lampa.Storage.get('online_mod_fancdn_name', ''));
      postdata += '&login_password=' + encodeURIComponent(Lampa.Storage.get('online_mod_fancdn_password', ''));
      postdata += '&login=submit';
      network.clear();
      network.timeout(8000);
      network["native"](Utils.proxyLink(url, prox, prox_enc, 'enc2t'), function (str) {
        var cookie = '';
        var values = {};
        var sid = '';
        var json = typeof str === 'string' ? Lampa.Arrays.decodeJson(str, {}) : str;
        var body = (json && json.body || '').replace(/\n/g, '');
        var error_form = body.match(/(<div class="berrors-inner">[^<]*<b class="berrors-title">[^<]*<\/b>[^<]*<\/div>)/);

        if (error_form) {
          Lampa.Noty.show(error_form[0]);
          if (error) error();
          return;
        }

        var cookieHeaders = json && json.headers && json.headers['set-cookie'] || null;

        if (cookieHeaders && cookieHeaders.forEach) {
          cookieHeaders.forEach(function (param) {
            var parts = param.split(';')[0].split('=');

            if (parts[0]) {
              if (parts[1] === 'deleted') delete values[parts[0]];else values[parts[0]] = parts[1] || '';
            }
          });
          sid = values['PHPSESSID'];
          delete values['PHPSESSID'];
          var cookies = [];

          for (var name in values) {
            cookies.push(name + '=' + values[name]);
          }

          cookie = cookies.join('; ');
        }

        if (cookie) {
          Lampa.Storage.set('online_mod_fancdn_cookie', cookie);
          if (cookie.indexOf('PHPSESSID=') == -1) cookie = 'PHPSESSID=' + (sid || Utils.randomHex(32)) + (cookie ? '; ' + cookie : '');
          var prox_enc2 = prox_enc;

          if (prox) {
            prox_enc2 += 'param/Cookie=' + encodeURIComponent(cookie) + '/';
          } else {
            headers['Cookie'] = cookie;
          }

          network.clear();
          network.timeout(8000);
          network["native"](Utils.proxyLink(host + '/', prox, prox_enc2, 'enc2t'), function (str) {
            var json = typeof str === 'string' ? Lampa.Arrays.decodeJson(str, {}) : str;
            var body = (json && json.body || '').replace(/\n/g, '');
            var error_form = body.match(/(<div class="berrors-inner">[^<]*<b class="berrors-title">[^<]*<\/b>[^<]*<\/div>)/);

            if (error_form) {
              Lampa.Noty.show(error_form[0]);
              if (error) error();
              return;
            }

            var cookieHeaders = json && json.headers && json.headers['set-cookie'] || null;

            if (cookieHeaders && cookieHeaders.forEach) {
              cookieHeaders.forEach(function (param) {
                var parts = param.split(';')[0].split('=');

                if (parts[0]) {
                  if (parts[1] === 'deleted') delete values[parts[0]];else values[parts[0]] = parts[1] || '';
                }
              });
              delete values['PHPSESSID'];
              var _cookies4 = [];

              for (var _name4 in values) {
                _cookies4.push(_name4 + '=' + values[_name4]);
              }

              cookie = _cookies4.join('; ');
              if (cookie) Lampa.Storage.set('online_mod_fancdn_cookie', cookie);
            }

            if (success) success();
          }, function (a, c) {
            if (success) success();
          }, false, {
            dataType: 'text',
            headers: headers,
            returnHeaders: returnHeaders
          });
        } else {
          if (error) error();
        }
      }, function (a, c) {
        Lampa.Noty.show(network.errorDecode(a, c));
        if (error) error();
      }, postdata, {
        dataType: 'text',
        headers: headers,
        returnHeaders: returnHeaders
      });
    } ///////Онлайн Мод/////////


    function addSettingsOnlineMod() {
      if (Lampa.Settings.main && Lampa.Settings.main() && !Lampa.Settings.main().render().find('[data-component="online_mod"]').length) {
        var field = $(Lampa.Lang.translate("<div class=\"settings-folder selector\" data-component=\"online_mod\">\n            <div class=\"settings-folder__icon\">\n                <svg height=\"260\" viewBox=\"0 0 244 260\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n                <path d=\"M242,88v170H10V88h41l-38,38h37.1l38-38h38.4l-38,38h38.4l38-38h38.3l-38,38H204L242,88L242,88z M228.9,2l8,37.7l0,0 L191.2,10L228.9,2z M160.6,56l-45.8-29.7l38-8.1l45.8,29.7L160.6,56z M84.5,72.1L38.8,42.4l38-8.1l45.8,29.7L84.5,72.1z M10,88 L2,50.2L47.8,80L10,88z\" fill=\"white\"/>\n                </svg>\n            </div>\n            <div class=\"settings-folder__name\">#{online_mod_title_full}</div>\n        </div>"));
        Lampa.Settings.main().render().find('[data-component="more"]').after(field);
        Lampa.Settings.main().update();
      }
    }

    function initSettings() {
      var template = "<div>";

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_proxy_lumex удалена */
      }

      if (Utils.isDebug()) {
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_rezka2\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_balanser} HDrezka</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
        /* МОИ ПРАВКИ: настройка online_mod_proxy_kinobase удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_collaps удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_cdnmovies удалена */
      }

      /* МОИ ПРАВКИ: настройка online_mod_proxy_filmix удалена */

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_proxy_fancdn удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_fancdn2 удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_fanserials удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_fanserials_cdn удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_videoseed удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_vibix удалена */
        /* МОИ ПРАВКИ: настройка online_mod_proxy_redheadsound удалена */
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_cdnvideohub\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_balanser} CDNVideoHub</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      }

      /* МОИ ПРАВКИ: настройка online_mod_proxy_anilibria удалена */
      /* МОИ ПРАВКИ: настройка online_mod_proxy_anilibria2 удалена */

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_proxy_animelib удалена */
      }

      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_kodik\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_balanser} Kodik</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";

      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_prefer_http\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_prefer_http}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_prefer_mp4\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_prefer_mp4}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";

      {
        /* МОИ ПРАВКИ: настройка online_mod_collaps_lampa_player удалена */
      }

      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_full_episode_title\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_full_episode_title}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_save_last_balanser\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_save_last_balanser}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_clear_last_balanser\" data-static=\"true\">\n            <div class=\"settings-param__name\">#{online_mod_clear_last_balanser}</div>\n            <div class=\"settings-param__status\"></div>\n        </div>";

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_kinobase_mirror удалена */
        /* МОИ ПРАВКИ: настройка online_mod_kinobase_cookie удалена */
      }

      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_mirror\" data-type=\"input\" placeholder=\"#{settings_cub_not_specified}\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_mirror}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";

      if (Utils.isDebug()) {
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_rezka2_mirror\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_rezka2_mirror}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      }

      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_name\" data-type=\"input\" placeholder=\"#{settings_cub_not_specified}\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_name}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_password\" data-type=\"input\" data-string=\"true\" placeholder=\"#{settings_cub_not_specified}\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_password}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";

      if (Lampa.Platform.is('android')) {
        Lampa.Storage.set("online_mod_rezka2_status", 'false');
      } else {
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_login\" data-static=\"true\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_login}</div>\n            <div class=\"settings-param__status\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_logout\" data-static=\"true\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_logout}</div>\n            <div class=\"settings-param__status\"></div>\n        </div>";
      }

      if (Utils.isDebug() || Lampa.Platform.is('android')) {
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_cookie\" data-type=\"input\" data-string=\"true\" placeholder=\"#{settings_cub_not_specified}\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_cookie}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_fill_cookie\" data-static=\"true\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_fill_cookie}</div>\n            <div class=\"settings-param__status\"></div>\n        </div>";
      }

      {
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_fix_stream\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_fix_stream}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      }

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_fancdn_name, online_mod_fancdn_password удалена */
      }

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_fancdn_cookie удалена */
      }

      if (Utils.isDebug()) {
        /* МОИ ПРАВКИ: настройка online_mod_fancdn_fill_cookie удалена */
      }

      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_use_stream_proxy\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_use_stream_proxy}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_rezka2_prx_ukr\" data-type=\"select\">\n            <div class=\"settings-param__name\">#{online_mod_rezka2_prx_ukr}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_find_ip\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_find_ip}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_other\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_other}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_proxy_other_url\" data-type=\"input\" placeholder=\"#{settings_cub_not_specified}\">\n            <div class=\"settings-param__name\">#{online_mod_proxy_other_url}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>\n        <div class=\"settings-param selector\" data-name=\"online_mod_secret_password\" data-type=\"input\" data-string=\"true\" placeholder=\"#{settings_cub_not_specified}\">\n            <div class=\"settings-param__name\">#{online_mod_secret_password}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";

      if (Utils.isDebug()) {
        template += "\n        <div class=\"settings-param selector\" data-name=\"online_mod_av1_support\" data-type=\"toggle\">\n            <div class=\"settings-param__name\">#{online_mod_av1_support}</div>\n            <div class=\"settings-param__value\"></div>\n        </div>";
      }

      template += "\n    </div>";
      Lampa.Template.add('settings_online_mod', template);
      if (window.appready) addSettingsOnlineMod();else {
        Lampa.Listener.follow('app', function (e) {
          if (e.type == 'ready') addSettingsOnlineMod();
        });
      }
      Lampa.Settings.listener.follow('open', function (e) {
        if (e.name == 'online_mod') {
          var clear_last_balanser = e.body.find('[data-name="online_mod_clear_last_balanser"]');
          clear_last_balanser.unbind('hover:enter').on('hover:enter', function () {
            Lampa.Storage.set('online_last_balanser', {});
            Lampa.Storage.set('online_balanser', '');
            Lampa.Storage.set('online_mod_last_balanser', {});
            Lampa.Storage.set('online_mod_balanser', '');
            $('.settings-param__status', clear_last_balanser).removeClass('active error wait').addClass('active');
          });
          var rezka2_login = e.body.find('[data-name="online_mod_rezka2_login"]');
          rezka2_login.unbind('hover:enter').on('hover:enter', function () {
            var rezka2_login_status = $('.settings-param__status', rezka2_login).removeClass('active error wait').addClass('wait');
            rezka2Login(function () {
              rezka2_login_status.removeClass('active error wait').addClass('active');
            }, function () {
              rezka2_login_status.removeClass('active error wait').addClass('error');
            });
          });
          var rezka2_logout = e.body.find('[data-name="online_mod_rezka2_logout"]');
          rezka2_logout.unbind('hover:enter').on('hover:enter', function () {
            var rezka2_logout_status = $('.settings-param__status', rezka2_logout).removeClass('active error wait').addClass('wait');
            rezka2Logout(function () {
              rezka2_logout_status.removeClass('active error wait').addClass('active');
            }, function () {
              rezka2_logout_status.removeClass('active error wait').addClass('error');
            });
          });
          var rezka2_fill_cookie = e.body.find('[data-name="online_mod_rezka2_fill_cookie"]');
          rezka2_fill_cookie.unbind('hover:enter').on('hover:enter', function () {
            var rezka2_fill_cookie_status = $('.settings-param__status', rezka2_fill_cookie).removeClass('active error wait').addClass('wait');
            rezka2FillCookie(function () {
              rezka2_fill_cookie_status.removeClass('active error wait').addClass('active');
              Lampa.Params.update(e.body.find('[data-name="online_mod_rezka2_cookie"]'), [], e.body);
            }, function () {
              rezka2_fill_cookie_status.removeClass('active error wait').addClass('error');
              Lampa.Params.update(e.body.find('[data-name="online_mod_rezka2_cookie"]'), [], e.body);
            });
          });
          var fancdn_fill_cookie = e.body.find('[data-name="online_mod_fancdn_fill_cookie"]');
          fancdn_fill_cookie.unbind('hover:enter').on('hover:enter', function () {
            var fancdn_fill_cookie_status = $('.settings-param__status', fancdn_fill_cookie).removeClass('active error wait').addClass('wait');
            fancdnFillCookie(function () {
              fancdn_fill_cookie_status.removeClass('active error wait').addClass('active');
              Lampa.Params.update(e.body.find('[data-name="online_mod_fancdn_cookie"]'), [], e.body);
            }, function () {
              fancdn_fill_cookie_status.removeClass('active error wait').addClass('error');
              Lampa.Params.update(e.body.find('[data-name="online_mod_fancdn_cookie"]'), [], e.body);
            });
          });
        }
      });
    }

    function startPlugin() {
      if (Utils.isDebug3()) return;
      logApp();
      initStorage();
      initLang();
      initMain();
      /* МОИ ПРАВКИ: Filmix отключён */
      initSettings();
    }

    startPlugin();

})();
