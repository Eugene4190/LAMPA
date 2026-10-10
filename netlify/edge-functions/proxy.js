// Netlify Edge Functions: тонкий адаптер — весь код живёт в kinokino_worker.js.
// Netlify Edge работает на Deno-рантайме (Request/Response нативные), поэтому
// файл воркера подключается без изменений и без копипасты.
//
// Деплой: app.netlify.com → Add new site → Import an existing project →
// GitHub → репозиторий LAMPA. Build command не нужен (netlify.toml ниже).
// После деплоя адрес вида https://ИМЯ.netlify.app вписать в Lampa:
// Настройки → Онлайн Мод (my) → «Использовать альтернативный прокси» →
// «Альтернативный прокси».
import worker from '../../kinokino_worker.js';

// ловим все пути: /, /debuglog, /enc2/…
export const config = { path: '/*' };

export default (request, _context) => worker.fetch(request);
