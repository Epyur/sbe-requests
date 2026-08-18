# AGENTS.md — sbe-requests (Заявки на испытания)

SBE-плагин «Заявки на испытания»: локальная БД-кэш заявок + синхронизация с lab-service
(сервер — канон), файлы заявок в S3 (`sbe-doc`).

## Назначение (текущее)

- **Синхронизация** с сервером `https://epyur.fvds.ru` через JWT из ЦУП СБЕ
  (`getService('sbe-apstore').auth.getToken('lab')`): push `/api/lab/sync/push`,
  pull `/api/lab/sync/pull`. Сервер — канон, локальный JSON — кэш. Конфликты заявок — LWW
  по `updated_at`. Справочники/проекты/группы в pull — полный слепок (заменяются целиком).
- **Локальная БД**: `yourbase/sbe_requests/requests_data.json`
  (`{"requests": [...], "projects": [...], "groups": [...], "labs": [...], "methods": [...], "objects": [...]}`).
  Модель совместима с серверной (lab-service).
- **Справочники**: лаборатории/методы — **только чтение** (наполняются в ЛИМС, в заявку
  подтягиваются оттуда); объекты — создание editor+ (server); проекты (дерево parent_id,
  code уникальный) — editor; группы (создание/участники, владелец или admin).
- **Нумерация** (сервер): `{NNN}/{yyyy}` — сквозной счётчик по году, не зависит от проекта.
  Заказчику: `{projectID}-{NNN}/{yyyy}-{labID}-{methodID}`; лаборатории: `{NNN}/{yyyy}-{methodID}`
  (без labID). Номера присваиваются сервером при создании заявки/метода.
- **Файлы**: загрузка в S3 через сервис (`POST /api/lab/file`, multipart: `request_id` + `file`),
  ключ и URL хранятся в заявке (`files[]`). Загрузка через **rclone CLI** внутри сервиса.
- **Точка входа** — магазин: «Установленные → Открыть» (`publishService('sbe-requests', {open})`).
- Статусы заявки: `new` / `processing` / `completed` (смена — editor+, сервер валидирует).
- Видимость (сервер): owner ИЛИ участник группы заявки; admin — все.

## Структура

| Файл | Что это |
|---|---|
| `src/main.ts` | `SbeRequestsPlugin`: настройки, БД, syncService, view, publishService |
| `src/database/requests-db.ts` | `RequestsDatabase`: кэш JSON, mergeRequestsFromServer (LWW), replaceReferenceData, dedupe |
| `src/services/sync.service.ts` | `RequestsSyncService`: sync/push/pull, создание справочников/проектов/групп, участники, статусы, файлы, permissions/common-access, JWT, multipart, таймауты |
| `src/ui/requests-view.ts` | `RequestsView`: дерево проектов → заявки, карточка заявки, создание/правка, группы, справочники, файлы, статусы |
| `src/ui/settings-tab.ts` | Настройки: apiUrl + «Права доступа» (роли viewer/editor/admin + общий доступ) |
| `src/types/requests.ts` | `LabRequest`, `LabProject`, `LabGroup`, `Lab`, `LabMethod`, `LabObject`, `RequestMethod`, `RequestFile`, `RequestsDbData`, `PullResponse`, `PushResponse`, `UploadFileResponse` |
| `src/styles.css` | Классы `tn-req-*` на семантических токенах |

## Настройки (data.json)

`apiUrl` (default `https://epyur.fvds.ru`). Роли lab: `viewer`(1) < `editor`(2) < `admin`(3).

## Правила

- `catch(e: unknown)` + `errorMessage()`; `requestUrl()`; `window.setTimeout()`; без `any`;
  UI на русском; автор — Полищук Евгений (polishchuk@tn.ru). Классы `tn-req-*` / `tn-btn*`
  / `tn-table` на семантических токенах sbe-core.
- Коммиты/пуши — только по явной команде пользователя.
- **«Фиксируй» = поднять версию (+0.0.1 в `manifest.json` и `package.json`), обновить
  документацию, подготовить сообщение для коммита и СПРОСИТЬ подтверждение commit/push.**

## История работ

### 2026-08-18 — v0.1.0 (создание, Этап 2 плана 2026-08-17-sbe-requests-lab-service-plan)
- Скаффолд как sbe-documents. БД-кэш `yourbase/sbe_requests/requests_data.json` (заявки +
  справочники/проекты/группы), LWW-синхронизация (заявки — merge LWW, справочники/проекты/группы —
  полная замена слепком pull), view (дерево проектов → заявки, карточка, создание/правка,
  группы, справочники, файлы, статусы), settings (apiUrl + «Права доступа»).
  `publishService('sbe-requests')`.
- `sbe-core`: добавлены `SbeRequestsApi`, `'sbe-requests'` в `SbeServiceMap` и
  `getServiceName` («Заявки на испытания»); пересобраны все 8 SBE-плагинов.
- Реестр: запись `sbe-requests` (hasView, tools, ownerEmail); registry.json синхронизирован
  на сервер (`https://epyur.fvds.ru/registry.json`). `community-plugins.json` дополнен
  `sbe-requests` (требуется перезапуск Obsidian для загрузки плагина).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK (main.js 53KB, styles.css 20KB).
- Git-репозиторий `Epyur/sbe-requests` — не создан (Этап 3, по команде пользователя).

### 2026-08-18 — правки по требованию пользователя
- **Создание лабораторий и методов убрано из плагина** — это функционал ЛИМС: справочники
  labs/methods в заявках только читаются (подтягиваются с сервера, наполняются в ЛИМС).
  Удалены `createLab`/`createMethod` из sync.service, формы `showCreateLabForm`/
  `showCreateMethodForm` и кнопки их создания в «Справочниках» (осталась только «➕ Объект»).
- **Таблица заявок**: убраны колонки «Заявка» и «Номер (лаборатория)»; колонка
  «Номер (заказчику)» переименована в **«Номер заявки»** (customer_number первого метода;
  название заявки — мелкой подписью под номером). tsc EXIT=0, build OK.

### 2026-08-18 — баг: новая заявка не получала номер (push create) — исправлен
- **Симптом**: созданная в Obsidian заявка оставалась с `number_seq: 0`, номера нет.
- **Причина**: плагин пушил новую заявку с положительным локальным id (`id: Date.now()`),
  сервер в `handlePush` трактовал `p.ID > 0` как UPDATE несуществующей заявки → 0 строк;
  `pushCreate` (идёт только при `id == 0`) не вызывался. Плагин помечал заявку `synced`,
  повторный push не происходил.
- **Фикс (сервер, `server_back/lab-service/sync.go`)**:
  - `PushRequest` += `client_id` (локальный id клиента);
  - `pushCreate` возвращает полную созданную заявку (`*Request`); `handlePush` отвечает
    `{"inserted", "updated", "created": [{client_id, request}]}`.
  - Залит на VDS `/opt/mailers/lab-service/sync.go` (md5 `184744af...`), контейнер `lab`
    пересобран (`docker compose up -d --build lab`, recreate OK).
- **Фикс (плагин)**:
  - `push()`: новые заявки (`number_seq === 0`) уходят с `id: 0` и `client_id: r.id`;
  - `sync()`: `res.created` → `db.replaceLocalRequest(client_id, request)` (заменяет локальную
    запись серверной с настоящим id и номерами);
  - `requests-db.ts`: новый `replaceLocalRequest(clientId, server)`; `types/requests.ts`:
    `PushResponse` += `created`. tsc EXIT=0, build OK.
- **Замечание**: уже созданная до фикса заявка (id `1787043970409`, `number_seq: 0`) в кэше
  осталась `synced` — не перепушится сама; её надо отредактировать/сохранить (станет `local`)
  или удалить. Новая версия main.js подхватится после перезапуска Obsidian / hot-reload.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 инлайн-стилей, `window.setTimeout` корректен,
  все `catch(e: unknown)` + `errorMessage()`.
- `npx tsc --noEmit` EXIT=0, `npm run build` OK (без предупреждений).