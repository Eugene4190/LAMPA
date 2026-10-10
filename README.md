# Своя сборка плагина «Онлайн Мод» для Lampa

Форк плагина [nb557/plugins → online_mod.js](https://github.com/nb557/plugins) с вырезанными
ненужными балансерами. Исходник автора **не правится руками** — его скачивает `build.js`,
применяет твой конфиг и выдаёт готовый файл в `dist/`.

**Текущая сборка:** из 23 источников оставлено 3 — `HDrezka`, `CDNVideoHub`, `Kodik`
(все работают **без аккаунтов и токенов**) — и добавлен **свой источник `KinoKino`**
(сайт kinokino.win / Flicksbar, тоже без регистрации). Размер файла: **568 КБ → 229 КБ**.

---

## 1. Что именно изменено

| Правка | Что даёт |
|---|---|
| Список балансеров урезан до `KEEP` | В меню «Источник» только нужное, ничего лишнего |
| Код 18 неиспользуемых источников физически удалён | Файл в 2.6 раза легче → быстрее старт на ТВ |
| Из настроек убраны пункты удалённых источников | Нет мусора в Настройки → Онлайн Мод |
| Папка настроек «Filmix» отключена | Filmix требует PRO-аккаунт, он не используется |
| Название «Онлайн Мод **(my)**», версия `…-my` | На телевизоре видно, что стоит твоя сборка |
| Добавлен свой источник **KinoKino** | Фильмы/сериалы с kinokino.win: без регистрации, переводы дорожками, субтитры |

Что **не** тронуто: логика поиска, плеер, прокси, субтитры, переводы — всё как у автора.

---

## 2. Опубликовать (чтобы получить ссылку)

### Вариант A — через сайт GitHub, без консоли (проще всего, работает и с телефона)

Репозиторий: **Eugene4190 / LAMPA**, Public, без README.

1. На пустой странице репозитория нажми **«uploading an existing file»**
2. Выбери файл `online_mod.js` (он лежит в `dist/` этой папки — скачай его из рабочей папки)
3. Commit changes (ветка создастся `main`, файл ляжет в корень)

Ссылка, которая работает **сразу, без дополнительных настроек**:

```
https://raw.githubusercontent.com/Eugene4190/LAMPA/main/online_mod.js
```

4. (по желанию) **Settings → Pages → Source: Deploy from a branch → main / root → Save** —
   через минуту добавится ещё одна, более быстрая ссылка:

```
https://eugene4190.github.io/LAMPA/online_mod.js
```

> С компьютера удобнее закинуть и остальное (`build.js`, `custom_sources.js`, `package.json`,
> `test/`, `README.md`) — тогда сборка обновлений будет жить прямо в репозитории.
> Если положишь файл в папку `dist/`, просто добавь `dist/` в ссылки выше.

### Вариант B — через CDN jsDelivr (быстрее всего на ТВ)

```
https://cdn.jsdelivr.net/gh/Eugene4190/LAMPA@main/online_mod.js
```

После каждого обновления файла кэш сбрасывается так:
`https://purge.jsdelivr.net/gh/Eugene4190/LAMPA@main/online_mod.js` (просто открой в браузере).

### Вариант D — консолью

```bash
cd lampa-mod
git init && git add . && git commit -m "Моя сборка Онлайн Мод"
git branch -M main
git remote add origin https://github.com/Eugene4190/LAMPA.git
git push -u origin main
```

---

## 3. Подключить на телевизоре (webOS)

1. Lampa → **Настройки → Расширения**
2. Старый «Онлайн Мод» (`https://nb557.github.io/plugins/online_mod.js`) — **удалить**,
   иначе будут два одинаковых плагина и конфликт кнопок «Онлайн».
3. **Добавить плагин** → вписать свою ссылку из раздела 2 → OK.
4. Перезапусти Lampa.
5. Проверка, что встала именно твоя сборка:
   - Настройки → **Онлайн Мод (my)**
   - На карточке фильма кнопка «Онлайн» в подсказке показывает версию `20.09.2026-my`
   - Внутри фильма в фильтре «Источник» только HDrezka / CDNVideoHub / Kodik

> **Если изменения не подхватились:** Lampa кэширует плагины по URL. Удали плагин и добавь
> заново, либо добавь к ссылке `?v=2` — это гарантированно сбросит кэш.

> **Про http/https:** Lampa на webOS открывается по https, поэтому ссылка на плагин обязана
> быть https. GitHub Pages / raw / jsDelivr — все https, тут всё хорошо. Локальный сервер
> `http://192.168.x.x:8000` на webOS не подойдёт (смешанный контент блокируется).

---

## 4. Настроить под себя

Весь конфиг — вверху `build.js`, блок `CONFIG`:

```js
KEEP: ['rezka2', 'kodik', 'cdnvideohub'],  // какие источники оставить
DEFAULT_BALANSER: 'cdnvideohub',           // какой выбирать первым
TITLE_SUFFIX: ' (my)',                     // пометка в названии ('' — убрать)
VERSION_SUFFIX: '-my',                     // пометка в версии
STRIP_DEAD_CODE: true,                     // физически вырезать лишний код
CLEAN_SETTINGS: true,                      // чистить настройки от мусора
DISABLE_FILMIX: true,                      // убрать папку настроек Filmix
UNLOCK_ALL: false,                         // показать ВСЕ источники, включая спрятанные автором
EXTRA_SOURCES: [],                         // свои источники (см. раздел 6)
```

После правки: `node build.js` → залить новый `dist/online_mod.js` в репозиторий.
Менять можно и прямо в готовом файле — блок «МОИ ПРАВКИ» лежит в самом верху `dist/online_mod.js`.

### Все доступные имена источников

| Имя | Название в меню | Авторизация | Примечание |
|---|---|---|---|
| `rezka2` | HDrezka | не нужна | поиск по названию, логин/куки опционально, есть настройка зеркала |
| `kodik` | Kodik | не нужна | токен уже зашит автором; агрегатор плееров kinogo-типа |
| `cdnvideohub` | CDNVideoHub | не нужна | работает по ID КиноПоиска, без рекламы |
| `anilibria2` | AniLibria.top | не нужна | аниме |
| `anilibria` | AniLibria | не нужна | аниме, старое API |
| `animelib` | AnimeLib | не нужна | аниме |
| `filmix` | Filmix | **нужен PRO‑аккаунт** | dev‑id + токен |
| `kinopub` | KinoPub | **нужна подписка** | |
| `collaps` / `collaps-dash` | Collaps | не нужна | автор блокирует его на официальных доменах Lampa |
| `lumex` / `lumex2` | Lumex | внутренний токен | `lumex2` — с рекламой |
| `fancdn` / `fancdn2` | FanCDN | аккаунт/куки | |
| `fanserials` | FanSerials | не нужна | |
| `kinobase` | Kinobase | куки/зеркало | |
| `cdnmovies` | CDNMovies | не нужна | |
| `zetflix` | Zetflix | не нужна | |
| `videoseed` | VideoSeed | не нужна | |
| `vibix` | Vibix | не нужна | |
| `redheadsound` / `-dash` | RedHeadSound | не нужна | |
| `alloha` | Alloha | не нужна | |

Часть из них спрятана автором (`disabled: true`) — в твоём форке это ограничение снимается:
либо добавь имя в `KEEP`, либо включи `UNLOCK_ALL: true` (покажет всё сразу, но часть
источников может не работать без своих токенов/кук).

---

## 5. Обновить, когда автор выпустит новую версию

```bash
node build.js     # скачает свежий online_mod.js и заново применит твой конфиг
node test/smoke.js
```

Все твои настройки живут в `CONFIG`, поэтому переносить правки руками не нужно.
Если автор сильно изменит структуру файла, сборщик честно упадёт с сообщением,
какой «якорь» он не нашёл (а не выдаст молча сломанный плагин).

---

## 6. Свой источник (например, Kinogo)

### Уже готовый пример — KinoKino (kinokino.win)

В `custom_sources.js` лежит рабочий класс `kinokino`, подключённый в `build.js`:

```js
EXTRA_SOURCES: [
  { name: 'kinokino', title: 'KinoKino', search: false, kp: true, imdb: true },
],
```

Как он работает:

1. Запрашивает API сайта: `https://fbphdplay.top/api/players?kinopoisk={kp_id}`
   (или `?imdb={imdb_id}`). API открытое (`Access-Control-Allow-Origin: *`) — с ТВ работает напрямую.
2. Из списка плееров (Alloha, Collaps, Veoveo, Turbo) берёт **Collaps** и скачивает его
   iframe (`api.nextembed.ws/embed/...`) — внутри вызов `makePlayer({...})` с файлами.
3. Если через сайт не вышло — запасные зеркала Collaps напрямую: `api.ortified.ws/embed/kp/{id}`,
   `api.kinogram.best/embed/kp/{id}`.
4. Фильмы и сериалы (фильтр сезонов), переводы — аудиодорожками внутри файла
   (Dragon Money Studio, Укр. Дуб, Kaz.MVO, Uzb.Dub и др.), субтитры RU/EN/UK, качество до 720p (HLS).

Ограничения: поиск **только по ID** КиноПоиска/IMDB (по названию API сайта не умеет) —
для карточек, где ID нет, Lampa сама сходит в TMDB за ID и повторит попытку.

**Два балансера:** `KinoKino` (HLS — играет везде) и `KinoKino (DASH)` (1080p там, где
у Collaps есть DASH-версия; на слабых ТВ может тормозить). Метка качества честная:
плагин один раз смотрит реальный master.m3u8/.mpd и берёт максимальную высоту кадра
(в JSON Collaps карта qualityByWidth занижает качество).

**Про переводы:** у Collaps все переводы лежат аудиодорожками внутри одного потока,
поэтому на фильм приходится одна строка списка, а дорожка переключается в плеере
(кнопка аудио / меню дорожек) — так же работает авторский балансер Collaps.

**Важно про прокси-воркер (`kinokino_worker.js`):** CDN Collaps (interkh.com) воюет
с плеерами: 503 на User-Agent webOS-телевизоров, 423 на Origin `lampa.mx` (встроенный
плеер Lampa) и ротация токенов, из-за которой ссылки сегментов умирают (410) прямо во
время просмотра. Всё это лечится одним бесплатным воркером на Deno Deploy
(деплой: deno.com/deploy → Sign in with GitHub → New Project → Deploy from GitHub
repository → LAMPA → Entry point: `kinokino_worker.js`), адрес воркера вписывается в
«Настройки → Онлайн Мод (my) → Использовать альтернативный прокси = вкл →
Альтернативный прокси = https://имя.deno.net». Что делает плагин при включённом прокси:

- адрес воркера нормализуется (пробелы, протокол, слэш на конце — можно вводить как
  угодно, «...deno.net» и «...deno.net/» равнозначны; без нормализации `proxyLink`
  склеивал «...deno.netenc2/...» и плеер не открывался — баг «Не открывает плеер»);
- на Android/в браузере поток принудительно играет **встроенным плеером Lampa**
  (`Player.runas('lampa')`): воркер отдаёт CORS, поэтому блокировка Origin больше не
  мешает, а hls.js — единственный плеер на телефоне, который умеет многоголосый HLS
  (Mi Video и VLC-интенты на нём спотыкаются: «Неизвестная ошибка (1)»);
- DASH-балансер на Android при включённом воркере честно отдаёт HLS (встроенный
  плеер не умеет mpd, а системные — многоголосый поток);
- воркер переписывает на себя все ссылки плейлиста (варианты, сегменты, дорожки,
  ключи, субтитры) и при 410/403 сам перечитывает свежий embed («самолечение»);
- v3: CDN-кэш Коллапса иногда отдаёт плейлист, в котором ссылки УЖЕ обёрнуты в
  адрес воркера (матрёшка x2-x3 → плеер получает текст вместо видео,
  fragLoadError). Воркер распутывает такие ссылки до исходных и больше никогда
  не оборачивает собственные URL (тест: `node test/worker_v3.js`);
- если воркер мёртв или адрес кривой — плагин тихо откатывается на прямые ссылки
  и системный плеер (проверка: probe мастер-плейлиста через прокси обязан вернуть
  плейлист, иначе прокси игнорируется).

На LG webOS при включённом воркере остаётся системный плеер телевизора (встроенный
веб-плеер webOS слабее) — воркер снимает блокировку по UA, и поток играет.

Живая проверка (реальная сеть, без телевизора):

```
node test/live_kinokino.js    # источник как таковой
WORKER_URL=https://имя.deno.net node test/proxy_android.js   # воркер + Android-сценарии
```

### Шаблон нового источника

1. В `custom_sources.js` пишешь класс — он автоматически вставится внутрь плагина:

```js
function kinogo(component, object) {
  var network = new Lampa.Reguest();
  var extract = {};
  var choice = { season: 0, voice: 0 };
  var filter_items = {};
  var select_title = '';

  // обязательный метод: поиск
  // kinopoisk_id приходит, только если у фильма есть ID КиноПоиска
  this.search = function (_object, kinopoisk_id) {
    object = _object;
    select_title = _object.search || _object.movie.title;

    network.clear();
    network.timeout(15000);
    // component.proxyLink(...) решает проблему CORS на webOS/Tizen
    network['native'](component.proxyLink('https://пример.ru/search?q=' + encodeURIComponent(select_title), component.proxy('other')), function (json) {
      extract = json || {};
      filter();
      append(filtred());          // вывести список в интерфейс
    }, function (a, c) {
      component.empty(network.errorDecode(a, c));   // показать ошибку
    });
  };

  this.extendChoice = function (saved) { Lampa.Arrays.extend(choice, saved, true); };
  this.reset  = function () { component.reset(); filter(); append(filtred()); };
  this.filter = function (type, a, b) { choice[a.stype] = b.index; filter(); append(filtred()); component.saveChoice(choice); };
  this.destroy = function () { network.clear(); };

  function filtred() {
    // каждый пункт списка:
    // { title, quality, info, stream: 'https://…/index.m3u8', media: {...} }
    return [];
  }
  function filter() { /* пункты фильтра: перевод, сезон, качество */ }
  function append(items) { /* component.append(items) + обработка hover:enter → Lampa.Player.play(...) */ }
}
```

2. В `build.js` добавляешь одну строку:

```js
EXTRA_SOURCES: [
  { name: 'kinogo', title: 'Kinogo', search: true, kp: false, imdb: false },
],
```

- `search: true` — источник умеет искать по названию (нужно для фильмов без ID КиноПоиска)
- `kp: true` — умеет искать по `kinopoisk_id`
- `imdb: true` — умеет по `imdb_id`

3. `node build.js` — источник появится в меню.

**Полезные методы `component`, которые доступны твоему источнику:**
`proxyLink`, `proxy`, `fixLink`, `fixLinkProtocol`, `proxyStream`, `reset`, `loading`,
`empty`, `emptyForQuery`, `error`, `similars`, `append`, `saveChoice`, `contextmenu`,
`formatEpisodeTitle`, `getDefaultQuality`, `renameQualityMap`, `parsePlaylist`,
`cleanTitle`, `equalAnyTitle`, `containsAnyTitle`, `getLastEpisode`.

**Лучший способ написать свой источник** — взять за образец готовый класс из исходника автора
(`online_mod.js`): `cdnvideohub` (самый простой, ~430 строк, поиск по ID КиноПоиска) или
`rezka2` (поиск по названию + зеркала + логин).

> **Важно про CORS.** Браузер webOS/Tizen не даст читать HTML чужих сайтов напрямую.
> Поэтому либо источник должен отдавать JSON с `Access-Control-Allow-Origin: *`,
> либо запросы идут через прокси (`component.proxyLink(...)`, в настройках плагина есть
> «Проксировать…», либо свой Cloudflare Worker — у автора в репозитории лежат
> `cloudflare_worker.js` и `deno_worker.js`). Именно поэтому «просто спарсить kinogo»
> без своего воркера не получится.

---

## 7. Проверки

```bash
npm install               # один раз (нужен acorn — им разбирается код плагина)
npm test                  # собрать + прогнать дымовой тест обеих сборок
node test/smoke.js        # только тест dist/online_mod.js
node test/live_kinokino.js  # живой тест KinoKino (нужен интернет)
```

`smoke.js` запускает плагин в песочнице с заглушкой Lampa и проверяет:
загрузку без ошибок, регистрацию компонента, открытие карточки фильма,
точный состав списка балансеров, отсутствие мусора в настройках, наличие нужных настроек.

`live_kinokino.js` делает то же, но сеть настоящая: открывает карточку фильма
(«Обитель зла», kp 7378605) и сериала («Холод», kp 7036356) и проверяет, что
KinoKino реально находит HLS-ссылку, переводы-дорожки, субтитры и сезоны.

---

## 8. Нюансы, которые стоит знать

- **Плагин молча не стартует на некоторых доменах.** В коде автора есть проверка
  `isDebug3()`: если Lampa открыта с `prisma.ws`, `lampishe.cc`, `lampa.walsy.synology.me`
  или `bylampa.online` — плагин не запускается вообще. На обычной `lampa.mx` и на своих
  сборках это не мешает. Если будешь менять домен Лампы и плагин «пропадёт» — причина тут.
- **Kodik** работает из коробки: 32‑символьный токен зашит автором в коде. Если он однажды
  отвалится, свой токен бесплатно выдаётся на <https://kodik-api.com> — вставляется в файл
  (переменная `token` в классе `kodik`).
- **HDrezka** (`rezka.ag`) может не отвечать из РФ без зеркала — в настройках плагина есть
  поле «Зеркало HDrezka».
- **Collaps** автор намеренно блокирует на официальных доменах Lampa (требование правообладателей).
  В твоём форке это ограничение снимается через `UNLOCK_ALL` или добавление `collaps` в `KEEP`.
- **Скрытый debug‑режим автора** (поле «Секретный пароль» в настройках) открывает часть
  спрятанных балансеров и настроек. Подбирать пароль не нужно: в своём форке ты и так
  можешь включить любой источник через `KEEP`/`UNLOCK_ALL`.

---

## 9. Файлы

```
lampa-mod/
├── build.js                 ← конфиг и сборщик (правь здесь)
├── custom_sources.js        ← свои источники (сейчас там KinoKino)
├── online_mod.js            ← оригинал автора, скачанный при последней сборке
├── package.json             ← npm test / npm run build
├── test/smoke.js            ← дымовой тест с заглушкой Lampa
├── test/live_kinokino.js    ← живой тест KinoKino (реальная сеть, фильм + сериал)
└── dist/
    ├── online_mod.js        ← ЭТОТ файл публикуем (229 КБ)
    └── online_mod.full.js   ← запасной: то же самое, но без вырезания кода (578 КБ)
```

## 10. Откатиться на оригинал

Удали свой плагин в Lampa и добавь обратно ссылку автора:
`https://nb557.github.io/plugins/online_mod.js`
