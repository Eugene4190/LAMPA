// СВОИ ИСТОЧНИКИ. Код отсюда автоматически вставляется внутрь плагина при сборке.
// Добавил класс ниже -> пропиши его в build.js: CONFIG.EXTRA_SOURCES.
// Шаблон класса и описание контракта — в README.md, раздел «Свой источник».

/*
 * KinoKino — источник по мотивам сайта kinokino.win (Flicksbar).
 *
 * Как работает:
 *   1. Запрашивает API сайта: https://fbphdplay.top/api/players?kinopoisk={kp_id}
 *      (или ?imdb={imdb_id}). API открытое, отдаёт Access-Control-Allow-Origin: * —
 *      с телевизора работает напрямую, прокси не нужен.
 *   2. Из ответа берёт iframe плеера Collaps (тип "Collaps", поле iframeUrl)
 *      и скачивает его HTML: там вызов makePlayer({...}) с файлами.
 *   3. Если через сайт не вышло — запасные зеркала Collaps напрямую по ID:
 *      api.ortified.ws/embed/kp/{id} и api.kinogram.best/embed/kp/{id}.
 *   4. Разбор makePlayer, фильтры сезонов, аудиодорожки (переводы внутри файла),
 *      субтитры — по образцу авторского класса collaps.
 *
 * Контент: фильмы и сериалы, переводы те же, что на сайте
 * (Dragon Money Studio, Укр. Дуб, Kaz.MVO, Uzb.Dub и т.д.), качество до 720p (HLS).
 * Поиск только по ID КиноПоиска/IMDB (по названию API сайта не умеет) —
 * поэтому в CONFIG.EXTRA_SOURCES стоит search:false, kp:true, imdb:true.
 */
function kinokino(component, _object) {
  var network = new Lampa.Reguest();
  var extract = {};
  var object = _object;
  var select_title = '';
  var prefer_http = Lampa.Storage.field('online_mod_prefer_http') === true;

  var API = 'https://fbphdplay.top/api/players';
  var MIRRORS = ['https://api.ortified.ws/embed/', 'https://api.kinogram.best/embed/'];

  var user_agent = Utils.baseUserAgent();
  var prox = component.proxy('collaps');
  var prox_enc = '';
  var prox_enc_stream = '';

  if (prox) {
    prox_enc += 'param/User-Agent=' + encodeURIComponent(user_agent) + '/';
    prox_enc_stream = prox_enc;
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

      if (extract.playlist && extract.playlist.seasons) {
        extract.playlist.seasons.sort(function (a, b) {
          return a.season - b.season;
        });
      }

      filter();
      append(filtred());
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
            var file = fixUrl(episode.hls || '', true);
            filtred.push({
              title: episode.title,
              quality: '360p ~ 720p',
              info: names.length ? ' / ' + component.uniqueNamesShortText(names, 80) : '',
              season: season.season,
              episode: parseInt(episode.episode),
              file: component.proxyLink(file, prox, prox_enc_stream),
              subtitles: episode.cc ? episode.cc.map(function (c) {
                var url = fixUrl(c.url || '');
                return {
                  label: c.name,
                  url: component.processSubs(component.proxyLink(url, prox, prox_enc_stream))
                };
              }) : false,
              audio_tracks: tracks.length ? tracks : false
            });
          });
        }
      });
    } else if (extract.source) {
      var max_quality = 0;
      extract.qualityByWidth && Lampa.Arrays.getKeys(extract.qualityByWidth).forEach(function (resolution) {
        var quality = extract.qualityByWidth[resolution] || 0;
        if (quality > 720) quality = 0;
        if (quality > max_quality) max_quality = quality;
      });

      var names = audioNames(extract.source.audio);
      var tracks = names.map(function (name) {
        return {
          language: name
        };
      });
      var file = fixUrl(extract.source.hls || '', true);
      filtred.push({
        title: extract.title || select_title,
        quality: max_quality ? max_quality + 'p' : '360p ~ 720p',
        info: names.length ? ' / ' + component.uniqueNamesShortText(names, 80) : '',
        file: component.proxyLink(file, prox, prox_enc_stream),
        subtitles: extract.source.cc ? extract.source.cc.map(function (c) {
          var url = fixUrl(c.url || '');
          return {
            label: c.name,
            url: component.processSubs(component.proxyLink(url, prox, prox_enc_stream))
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
