# Phone Live

Готовый проект для GitHub и Render: мобильная клавиатура посетителя и отдельная защищённая админка с обновлением номера в реальном времени.

## Что находится в архиве

- `public/` — основная пользовательская страница и админка.
- `disclosure/` — отдельная корневая папка предупреждения.
- `test/` — автоматические серверные тесты.
- `server.js` — Node.js сервер и передача данных через Socket.IO.
- `render.yaml` — готовая конфигурация Render.
- `package.json` и `pnpm-lock.yaml` — зависимости проекта.

## Адреса

- `/` — клавиатура посетителя.
- `/admin` — чёрный экран оператора, защищённый паролем.
- `/health` — проверка состояния Render-сервиса.

Введённые значения хранятся только в оперативной памяти сервера, не записываются в файлы или базу и автоматически удаляются спустя пять минут после отключения посетителя.

Предупреждение полностью вынесено в отдельную папку `disclosure/`. Код находится в `disclosure/disclosure.js`, стили — в `disclosure/disclosure.css`. Передача ввода работает только когда модуль предупреждения успешно загрузился.

## Локальный запуск

Требуется Node.js 20–24 и pnpm 11 через Corepack.

```powershell
corepack enable
pnpm install
pnpm start
```

Откройте:

- `http://localhost:3000/`
- `http://localhost:3000/admin`

## Загрузка на GitHub

ZIP сначала нужно распаковать. На GitHub загружается содержимое распакованной папки так, чтобы `render.yaml`, `package.json`, `server.js`, `public/`, `disclosure/` и `test/` находились в корне репозитория.

```bash
git init
git add .
git commit -m "Build real-time phone dialer"
git branch -M main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

## Развёртывание на Render

1. Распакуйте ZIP и загрузите всё содержимое в корень GitHub-репозитория.
2. В Render выберите **New → Blueprint**.
3. Подключите GitHub-репозиторий.
4. Render автоматически обнаружит `render.yaml` и создаст один Web Service.
5. Дождитесь статуса **Live**.

Если Render показывает только `Not Found`, проверьте две вещи:

- в Render должен быть создан **Web Service через New → Blueprint**, а не Static Site;
- в корне GitHub-репозитория должны лежать именно `render.yaml`, `package.json` и `server.js`. ZIP нельзя загружать в репозиторий одним нераспакованным файлом.

После публикации:

- пользовательская страница: `https://ИМЯ-СЕРВИСА.onrender.com/`;
- админка без пароля: `https://ИМЯ-СЕРВИСА.onrender.com/admin`.

Обе страницы обслуживаются одним Render-сервисом. Компьютер пользователя после публикации можно выключить.

## Проверки

```bash
pnpm run check
pnpm test
```
