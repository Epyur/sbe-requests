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

### 2026-08-19 — v0.1.5 (external_id для переходного периода миграции)
- По решению пользователя: перед переносом заявок из десктопной ЛИМС (`LIMS_LPI`) заведено
  поле `LabRequest.external_id` — номер из legacy email-трекера (`LPITrack`, вид
  `"LPIZAYAVKINAPRO-<N>"`); у новых заявок пусто, заполняется только при импорте legacy-данных.
  Живой индексацией почты `lpitn@yandex.ru` подтверждено: 1 email-заявка трекера = 1 метод —
  совместимо с текущей моделью «1 заявка = 1 метод» без конфликта номеров.
  Сервер (lab-service): миграция `requests.external_id` + индекс, поле в create/update/
  pull/push (см. lab-service/AGENTS.md) — **код готов, деплой на VDS по подтверждению**.
  Плагин: тип `LabRequest.external_id`, push отправляет поле (round-trip), pull получает
  автоматически (полный спред объекта в `mergeRequestsFromServer`). UI для ввода/показа
  не добавлялся — поле предназначено для будущего инструмента импорта legacy-заявок,
  не для ручного использования.
- Версия 0.1.4 → **0.1.5** (manifest + package.json). `npx tsc --noEmit` EXIT=0;
  `npm run build` OK.

### 2026-08-19 — v0.1.4 (видимость проектов по группе) + git
- **Видимость проектов по группе** (дизайн
  `docs/superpowers/specs/2026-08-19-sbe-requests-project-group-visibility-design.md`,
  план `docs/superpowers/plans/2026-08-19-sbe-requests-project-group-visibility-plan.md`):
  - сервер (lab-service): миграция `projects.group_id BIGINT REFERENCES groups(id)`;
    create/update проекта принимают `group_id` (0 = публичный, 400 `group not found`);
    новый `loadVisibleProjects` (видимость: публичный ∨ владелец ∨ admin ∨ член группы)
    в `/projects` и `/sync/pull` + **цепочка предков** видимых проектов (дерево не рвётся).
    Задеплоено на VDS, контейнер `lab` пересобран, md5 = локальным, E2E пройден
    (видимость по группам, цепочка предков, PATCH group_id, pull-фильтр, 400 на
    несуществующую группу). E2E-данные удалены.
  - плагин: `LabProject.group_id`, `createProject`/`updateProject` шлют `group_id`;
    форма проекта (create+edit) — select «Группа (видимость)» («— Публичный —» + группы);
    **автоподстановка** группы проекта в поле «Группа» формы заявки при создании
    (смена проекта в форме переустанавливает группу; при редактировании заявки
    существующее значение не трогается).
  - замечание: первая сборка на сервере упала на отсутствующем `context` в `projects.go` —
    добавлен импорт (класс багов как у `groups.go` 2026-08-18).
- `manifest.json`/`package.json`: 0.1.3 → **0.1.4**. `npx tsc --noEmit` EXIT=0;
  `npm run build` OK. Коммит/пуш — по подтверждению пользователя (дано).

### 2026-08-18 — v0.1.3 (генеральная сборка: правки + справка) + git
- В версию собрано: редактирование проектов (✎ + `updateProject`), фикс «undefined»-заявок
  (миграция с save, `pruneSyncedNotInServer`, защита `methodName`), **добавление методов**
  (блок «➕ Добавить методы», `parent_id`, превью-номера; сервер — см. lab-service/AGENTS.md),
  справка (кнопка «?», `Заявки на испытания — инструкция.md` из `src/ui/help.ts`).
- `manifest.json`/`package.json`: 0.1.2 → **0.1.3**. `npx tsc --noEmit` EXIT=0;
  `npm run build` OK. Коммит/пуш — по подтверждению пользователя.

### 2026-08-18 — ДИЗАЙН: декомпозиция заявки на под-заявки по методам (согласован, реализуется)
- Дизайн: `docs/superpowers/specs/2026-08-18-sbe-requests-per-method-design.md`.
- Решения (согласованы с пользователем): 1 заявка = 1 метод (`method_id`/`customer_number`/
  `lab_number` прямо в `requests`, таблица `request_methods` упраздняется); группа под-заявок
  с общим NNN связывается только через одинаковые `number_seq`+`number_year` (без шапки);
  создание — один запрос → N под-заявок; раскатка существующих мульти-методных заявок
  (файлы копируются во все под-заявки, результаты ЛИМС — по `(request_id, method_id)`);
  offline-push передаёт общий `group_key`, сервер присваивает один NNN группе;
  в таблице под-заявки — отдельные строки.
- Статус: ✅ реализация завершена 2026-08-18 — сервер задеплоен + E2E (см. lab-service/AGENTS.md),
  плагин обновлён (типы `LabRequest` без `methods[]` → `method_id`/`customer_number`/`lab_number`
  + опц. `group_key`; миграция кэша `migrateLegacyRequests` — легaси `methods[]` делятся на
  под-заявки, синхронизированные мульти-методные выпадают до пулла; push шлёт `method_id` +
  `group_key`, N под-заявок одного создания получают один NNN на сервере; таблица — строки
  под-заявок с колонкой «Метод», карточка — один метод + два номера; в форме метод
  фиксирован (только чтение), создание с N методами = N под-заявок). tsc/build OK.

### 2026-08-18 — декомпозиция заявки на под-заявки по методам (код готов, версия не поднята)

### 2026-08-18 — добавление методов к заявке (под-заявки с тем же номером) + справка
- **Добавление методов** (только статус `new` и присвоенный номер): в форме редактирования
  блок «➕ Добавить методы» — отмеченные методы создают под-заявки с тем же NNN.
  Реализация: `LabRequest.parent_id`; push шлёт `parent_id`; сервер переиспользует
  NNN родителя (`reuseParentNumber`, only parent owner/admin + status new, иначе — новый NNN);
  черновикам рендерятся превью-номера (`buildDraftNumbers`, `requestNumber` — показ номера
  родителя до синхронизации). Типы `LabRequest`/`PushResponse` согласованы.
  Серверные правки и E2E — см. lab-service/AGENTS.md. tsc/build OK.
- **Справка**: кнопка «?» рядом с «🔄» открывает заметку `Заявки на испытания — инструкция.md`
  (создаётся в корне вольта при отсутствии из встроенной копии `src/ui/help.ts`).
  Инструкция подробно описывает заполнение заявок (объект ЕКН/экспериментальный, методы,
  нумерация, статусы, синхронизация, группы, права).

### 2026-08-18 — фиксы после перезагрузки + редактирование проектов
- **Баг «заявка как undefined»**: устаревшие строки кэша (`methods[]`, без `method_id`)
  рендерились как `#undefined` в колонке «Метод». Причина — миграция кэша меняла данные
  только в памяти и не сохраняла файл. Исправлено: `migrateLegacyRequests` возвращает
  признак изменений, `init()` персистит их; после pull `pruneSyncedNotInServer` удаляет
  синхронизированные заявки, которых больше нет на сервере; `methodName()` защищён
  от невалидного id (возвращает «—»).
- **Редактирование проектов**: в дереве проектов кнопка «✎» (владелец/admin) →
  `showEditProjectForm` (код/название/описание), `sync.service.updateProject`
  (`PATCH /projects/{id}`). tsc EXIT=0, build OK.

### 2026-08-18 — v0.1.2 (пересборка за sbe-core: sbe-lims в service-map) + git
- `sbe-core`: добавлены `SbeLimsApi` и `'sbe-lims'` в `SbeServiceMap` — пересборка `main.js`,
  исходники плагина не менялись. Версия 0.1.1 → **0.1.2** (manifest + package.json).
- `npx tsc --noEmit` EXIT=0; `npm run build` OK. Коммит и пуш сделаны.
- Git-репозиторий `Epyur/sbe-requests` создан 2026-08-18 (init-коммит, запушен).

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
- Git-репозиторий `Epyur/sbe-requests` — создан см. выше (v0.1.2).

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

### 2026-08-18 — v0.1.1 (адаптация формы заявки под практику, Этап 1-3 плана 2026-08-18-sbe-requests-form-adaptation-plan)
- **Сервер (lab-service, задеплоен + E2E)**:
  - миграции: `labs.type` (internal/external), `methods.determinable_indicators` (JSONB),
    `requests.priority`/`test_purpose`/`external_lab_id`/`ekn`;
  - `requests.go`: новые поля в create/update/load/pull/push; **автопроект-ЕКН** —
    при `ekn` без проекта создаётся/переиспользуется проект с `code=ekn` (is_ekn=true);
  - `references.go`: `Lab.type`, `Method.determinable_indicators` (list/create);
  - фикс: после создания автопроекта в tx `loadProjectInfo` через пул не видел
    незакоммиченный проект → задаётся `pi.code = ekn` напрямую.
  - E2E: внешняя лаба FAER, метод GG-M3 с показателями, объект с ЕКН (batch_number,
    ekn_snapshot), автопроект 068863 + переиспользование, экспериментальный образец,
    pull с новыми полями — всё зелёное.
- **Плагин**:
  - `types/requests.ts`: `Lab.type`, `LabMethod.determinable_indicators`,
    `ObjectCharacteristics` (ekn/batch_number/sample_id/sample_type/thickness_mm/
    target_indicator/ekn_snapshot), `LabRequest.priority/test_purpose/external_lab_id/ekn`;
  - `sync.service.ts`: push с новыми полями, `getEknProduct(ekn)` (sbe-ekn, fallback null);
  - `requests-view.ts`: форма — ЕКН-блок (подсказки из `getService('sbe-ekn').search()`,
    снимок, номер партии) / блок «Экспериментальный образец» (название/тип/толщина/
    идентификатор/целевой показатель), приоритет, цель испытания, чекбокс «внешняя
    лаборатория» → select внешних, определяемые показатели из выбранных методов;
    карточка — новые поля;
  - `styles.css`: `tn-req-ekn-*`, `tn-req-object-section`.
  - tsc EXIT=0, build OK (main.js 61KB).
- **Интеграция sbe-ekn**: подсказки по ЕКН и снимок через `getService('sbe-ekn')`;
  при недоступности sbe-ekn заявка создаётся (ЕКН вручную, снимок пуст).
- **Доработки по требованию пользователя (v0.1.1)**:
  - поле **«Наименование заявки» удалено** — названием заявки становится наименование
    объекта исследования (в таблице/карточке/форме показывается объект, не title);
    если по ЕКН нет данных в PIM — предлагается заполнить название и целевые
    характеристики вручную (обязательно);
  - **поле «Номер партии»** появляется при вводе/выборе ЕКН (скрывается при очистке);
  - **«Цель испытания»**: добавлен пункт «Текущий контроль» (`quality_control`),
    сделан по умолчанию (для новых заявок).
  - tsc EXIT=0, build OK (main.js 63KB). Версия manifest/package: **0.1.1**.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 инлайн-стилей, `window.setTimeout` корректен,
  все `catch(e: unknown)` + `errorMessage()`.
- `npx tsc --noEmit` EXIT=0, `npm run build` OK (без предупреждений).