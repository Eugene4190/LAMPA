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
 *        - на телефоне/в браузере при живом воркере играем встроенным плеером
 *          Lampa (hls.js): только он умеет многоголосый HLS и дорожки;
 *        - если воркер не отвечает плейлистом — тихий откат на прямые ссылки;
 *        - DASH-балансер на Android с воркером отдаёт HLS (встроенный плеер
 *          не умеет mpd, а системные плееры — многоголосый поток).
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

  // v9: нативные плееры (Android, webOS) не умеют многоголосый HLS Коллапса —
  // для них просим у воркера mono-плейлист (дорожка по умолчанию вшита в видео)
  var use_mono = Lampa.Platform.is('android') || Lampa.Platform.is('webos') || Lampa.Platform.is('tizen');

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

  // DASH не играется встроенным плеером Lampa (hls.js умеет только HLS),
  // а на Android с включённым прокси мы форсируем именно встроенный —
  // поэтому там DASH-балансер честно отдаёт HLS-поток
  function dashActive() {
    // v13: DASH(1080p) остаётся только там, где его есть чем играть (десктоп);
    // на android/webos/tizen отдаём HLS — нативные и встроенный плееры MPD не тянут
    return prefer_dash && !use_mono;
  }

  function pickFile(src) {
    if (!src) return '';
    return (dashActive() && (src.dasha || src.dash)) || src.hls || '';
  }

  /* ── честная метка качества: смотрим реальный мастер-плейлист ── */
  function probeQuality(url, onDone) {
    if (!url) {
      onDone(0, true);
      return;
    }

    network.clear();
    network.timeout(8000);
    network.native(proxUrl(url, use_mono), function (str) {
      var h = 0;
      var re = dashActive() ? /height="(\d+)"/g : /RESOLUTION=\d+x(\d+)/g;
      var m;
      str = str || '';

      while ((m = re.exec(str))) {
        var v = parseInt(m[1]);
        if (v > h) h = v;
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

  function qualityLabel(fallback) {
    if (detected_height) return detected_height + 'p';
    return '360p ~ ' + fallback;
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

          if (extract.source) {
            probe_url = pickFile(extract.source);
          } else if (extract.playlist && extract.playlist.seasons.length && extract.playlist.seasons[0].episodes && extract.playlist.seasons[0].episodes.length) {
            probe_url = pickFile(extract.playlist.seasons[0].episodes[0]);
          }

          var finalize = function (h) {
            detected_height = h;
            filter();
            append(filtred());
          };

          probeQuality(probe_url, function (h, prox_ok) {
            if (!prox_ok && stream_prox) {
              // прокси не отвечает плейлистом (воркер мёртв или адрес кривой) —
              // сбрасываемся на прямые ссылки, чтобы хоть что-то открывалось,
              // и перечитываем качество уже напрямую
              stream_prox = '';
              play_headers = makePlayHeaders();
              probeQuality(probe_url, function (h2) {
                finalize(h2);
              });
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
            filtred.push({
              title: episode.title,
              quality: qualityLabel(fallback),
              info: names.length ? ' / ' + component.uniqueNamesShortText(names, 80) : '',
              season: season.season,
              episode: parseInt(episode.episode),
              file: proxUrl(file, use_mono),
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
      filtred.push({
        title: extract.title || select_title,
        quality: qualityLabel(fallback),
        info: names.length ? ' / ' + component.uniqueNamesShortText(names, 80) : '',
        file: proxUrl(file, use_mono),
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
          var playlist = [];
          var first = {
            url: component.getDefaultQuality(null, element.file),
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

          // v11: на webOS просим нативный HLS-режим встроенного плеера
          // (парсер плейлистов + <video> телевизора), MSE на старых webOS слабый
          if (Lampa.Platform.is('webos')) first.hls_type = 'native';

          if (element.season) {
            items.forEach(function (elem) {
              playlist.push({
                url: component.getDefaultQuality(null, elem.file),
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
          // плеер, и показываем код в уведомлении: DIAG [W воркер|D напрямую]
          // [M mono|- мульти] ok/master/vari/seg + статус или килобайты
          (function () {
            try {
              var mark = (stream_prox ? 'W' : 'D') + (stream_prox && use_mono ? 'M' : '-');
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
                  if ((mtxt || '').indexOf('<MPD') !== -1 || (mtxt || '').indexOf('<?xml') === 0) {
                    Lampa.Noty.show('DIAG ' + mark + ' mpd (DASH) ' + (mtxt || '').length);
                    return;
                  }
                  Lampa.Noty.show('DIAG ' + mark + ' master? ' + (mtxt || '').length + '|' + (mtxt || '').replace(/\n/g, ' ').substring(0, 20));
                  return;
                }
                var d2 = new Lampa.Reguest();
                d2.timeout(12000);
                d2.native(vurl, function (vtxt) {
                  var surl = pick(vtxt);
                  if (surl && surl.indexOf('http') !== 0) surl = vurl.substring(0, vurl.lastIndexOf('/') + 1) + surl;
                  if (!surl) {
                    Lampa.Noty.show('DIAG ' + mark + ' vari? ' + (vtxt || '').length + '|' + (vtxt || '').replace(/\n/g, ' ').substring(0, 20));
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

          // Выбор плеера:
          //  - пользователь сам выбрал в контекстном меню — уважаем (options.runas);
          //  - прописан свой прокси-воркер — на телефоне/в браузере играем встроенным
          //    плеером Lampa (hls.js): воркер отдаёт CORS-заголовки, значит блокировка
          //    Origin lampa.mx (423) больше не мешает, а встроенный плеер — единственный,
          //    кто умеет многоголосый HLS (Mi Video/VLC-интенты на нём спотыкаются);
          //  - на webOS/Tizen оставляем системный плеер (там встроенный слабый,
          //    а воркер и так снимает блокировку по UA);
          //  - иначе — как настроено в Lampa (по умолчанию системный).
          if (options && options.runas) Lampa.Player.runas(options.runas);
          else if (Lampa.Player.runas) {
            // v9: многоголосый поток умеет только десктопный hls.js; на телефоне и
            // ТВ играем нативными/внешними плеерами mono-поток
            if (Lampa.Platform.is('android')) Lampa.Player.runas('android');
            else if (stream_prox && Lampa.Platform.is('webos')) Lampa.Player.runas('lampa'); // v13: на webOS всегда встроенный плеер Lampa (родной «Фото и видео» поток не берёт); DASH-балансер на ТВ/телефоне честно отдаёт HLS
            else if (stream_prox && Lampa.Platform.is('tizen')) Lampa.Player.runas('tizen');
            else Lampa.Player.runas('');
          }
          Lampa.Player.play(first);
          Lampa.Player.playlist(playlist);

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
