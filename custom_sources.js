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

  // свой прокси (Настройки → Онлайн Мод (my) → «свой прокси»): нужен на webOS/Tizen,
  // где CDN Collaps отдаёт 503 на User-Agent телевизора — воркер подменит UA
  var DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  var stream_prox = Lampa.Storage.field('online_mod_proxy_other') === true ? (Lampa.Storage.field('online_mod_proxy_other_url') + '' || '') : '';
  var stream_prox_enc = stream_prox ? 'param/User-Agent=' + encodeURIComponent(DESKTOP_UA) + '/' : '';

  if (prox) {
    prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
  }

  var play_headers = !prox && Lampa.Platform.is('android') ? {
    'User-Agent': user_agent
  } : {};
  var filter_items = {};
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

  function pickFile(src) {
    if (!src) return '';
    return (prefer_dash && (src.dasha || src.dash)) || src.hls || '';
  }

  /* ── честная метка качества: смотрим реальный мастер-плейлист ── */
  function probeQuality(url, onDone) {
    if (!url) {
      onDone(0);
      return;
    }

    network.clear();
    network.timeout(8000);
    network.native(component.proxyLink(url, stream_prox, stream_prox_enc, 'enc2'), function (str) {
      var h = 0;
      var re = prefer_dash ? /height="(\d+)"/g : /RESOLUTION=\d+x(\d+)/g;
      var m;
      str = str || '';

      while ((m = re.exec(str))) {
        var v = parseInt(m[1]);
        if (v > h) h = v;
      }

      onDone(h);
    }, function () {
      onDone(0);
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
  function fetchEmbeds(urls, i, onEmpty) {
    if (!urls || i >= urls.length) {
      onEmpty();
      return;
    }

    network.clear();
    network.timeout(10000);
    network.native(component.proxyLink(urls[i], prox, prox_enc, 'enc2t'), function (str) {
      if (str && str.indexOf('makePlayer(') !== -1) parse(str);else fetchEmbeds(urls, i + 1, onEmpty);
    }, function () {
      fetchEmbeds(urls, i + 1, onEmpty);
    }, false, {
      dataType: 'text',
      headers: play_headers
    });
  }

  function searchBy(kinopoisk_id, onEmpty) {
    apiSearch(kinopoisk_id, function (iframe) {
      var urls = [];
      if (iframe) urls.push(iframe);

      var api = (+kinopoisk_id ? 'kp/' : 'imdb/') + kinopoisk_id;

      for (var m = 0; m < MIRRORS.length; m++) {
        urls.push(MIRRORS[m] + api);
      }

      fetchEmbeds(urls, 0, onEmpty);
    });
  }

  /* ── разбор embed-а: makePlayer({...}); ──────────────────────── */
  function parse(str) {
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

      var probe_url = '';

      if (extract.source) {
        probe_url = pickFile(extract.source);
      } else if (extract.playlist && extract.playlist.seasons.length && extract.playlist.seasons[0].episodes && extract.playlist.seasons[0].episodes.length) {
        probe_url = pickFile(extract.playlist.seasons[0].episodes[0]);
      }

      probeQuality(probe_url, function (h) {
        detected_height = h;
        filter();
        append(filtred());
      });
    } else component.emptyForQuery(select_title);
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
    var fallback = prefer_dash ? '1080p' : '720p';

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
              file: component.proxyLink(file, stream_prox, stream_prox_enc, 'enc2'),
              subtitles: episode.cc ? episode.cc.map(function (c) {
                var url = fixUrl(c.url || '');
                return {
                  label: c.name,
                  url: component.processSubs(component.proxyLink(url, stream_prox, stream_prox_enc, 'enc2'))
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
        file: component.proxyLink(file, stream_prox, stream_prox_enc, 'enc2'),
        subtitles: extract.source.cc ? extract.source.cc.map(function (c) {
          var url = fixUrl(c.url || '');
          return {
            label: c.name,
            url: component.processSubs(component.proxyLink(url, stream_prox, stream_prox_enc, 'enc2'))
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
            headers: play_headers
          };

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
                headers: play_headers
              });
            });
          } else {
            playlist.push(first);
          }

          if (playlist.length > 1) first.playlist = playlist;
          if (options && options.runas) Lampa.Player.runas(options.runas);
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
