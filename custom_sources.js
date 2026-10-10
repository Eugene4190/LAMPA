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
            append(filtred());
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
