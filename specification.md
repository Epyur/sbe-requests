# specification.md — sbe-requests (Заявки на испытания)

SBE-плагин «Заявки на испытания». Клиент lab-service (сервер — канон, локально — кэш).
База URL по умолчанию: `https://epyur.fvds.ru`. JWT для `app_id=lab` берётся из ЦУП СБЕ
(`getService('sbe-apstore').auth.getToken('lab')`).

## API (lab-service, `/api/lab/*`)

| Метод | Путь | Роль | Тело / ответ |
|---|---|---|---|
| GET | `/health` | — | `{"status":"ok"}` |
| GET | `/labs` `/methods` `/objects` | viewer | `{"labs":[...]}` / `{"methods":[...]}` / `{"objects":[...]}` |
| POST | `/labs` | superadmin | `{code,name,description,type?}` → `{id}` (создание — только в sbe-lims) |
| POST | `/methods` | admin | `{code,name,lab_ids: number[],description,determinable_indicators?}` → `{id}` (минимум одна лаба; метод может принадлежать нескольким, 2026-08-19) |
| POST | `/objects` | editor | `{name,description,characteristics}` → `{id}` |
| PATCH | `/objects/{id}` | editor | `{name?,description?,characteristics?}` → `{ok}` (2026-08-24; `characteristics`, если передан, заменяется ЦЕЛИКОМ, не мержится) |
| GET | `/projects` | viewer | `{"projects":[...]}` (видимые: публичные + свои + по группе + admin; включены предки видимых) |
| POST | `/projects` | editor | `{parent_id,code,name,description,is_ekn,group_id}` → `{id}`; 409 code exists; 400 group not found |
| PATCH | `/projects/{id}` | editor+/владелец | `{parent_id,code,name,description,is_ekn,group_id}` → `{ok}` (0 = «отвязать» группу) |
| GET | `/requests` | viewer | `{"requests":[...]}` (только видимые) |
| POST | `/requests` | editor | `{title,description,object_id,project_id,group_id,priority,test_purpose,ekn,external_id,methods:[{method_id,lab_id}]}` → `{requests:[...]}`; `lab_id` — обязана быть в `method.lab_ids` (400 иначе); при `ekn` без проекта — автопроект (code=ekn) |
| GET | `/requests/{id}` | viewer (видимость) | `{"request":{...}}`; 403 если не видно |
| PATCH | `/requests/{id}` | editor+/владелец | `{title,description,object_id,project_id,group_id,priority,test_purpose,ekn,external_id}` → `{request}` (метод/лаба фиксируются при создании, не редактируются) |
| POST | `/requests/{id}/status` | editor | `{status}` (new/processing/completed) → `{ok}` |
| POST | `/requests/{id}/protocol?template=ui&format=html` | viewer | `{html, docx_base64: "", generated_at}` — HTML результатов испытания (read-only блок в карточке заявки), тот же вид, что в карточке ЛИМС; см. `sbe-lims/specification.md` для формы блоков (2026-08-23, заменил JSON-эндпоинт `.../short-view`) |
| POST | `/requests/{id}/protocol?template=protocol&format=full` | viewer | `{html: "", docx_base64, generated_at}` — полный протокол в DOCX (2026-08-24, кнопка «📄 Скачать протокол (Word)» в карточке заявки, `getProtocolDocx()`) |
| GET | `/requests/{id}/export.xlsx` | editor | `{xlsx_base64}` — таблица всех данных заявки: серии + агрегаты/статистика (2026-08-24, кнопка «📊 Скачать таблицу (Excel)», `getExportXlsx()`; см. `lab-service/AGENTS.md` — `excelize`) |
| GET | `/groups` | viewer | `{"groups":[...]}` (мои + где участник) |
| POST | `/groups` | editor | `{name}` → `{id}` |
| POST | `/groups/{id}/members` | владелец/admin | `{email,role}` (viewer/editor) → `{ok}` |
| DELETE | `/groups/{id}/members/{email}` | владелец/admin | → `{ok}` |
| GET | `/sync/pull` | viewer | `{"requests","projects","groups","labs","methods","objects"}` |
| POST | `/sync/push` | editor | `{requests:[PushRequest]}` → `{inserted,updated,created:[{client_id,request}]}` |
| POST | `/file` | editor | multipart (`request_id`, `file`) → `{file_key,file_name,file_size,file_url,request_id}` |
| GET | `/file?key=` | viewer | бинарный файл |
| GET | `/permissions/me` | viewer | `{email,role,hasAccess}` |
| GET/POST | `/permissions` | admin | `{permissions:[{email,role}]}` / `{email,role}` |
| GET/POST | `/common-access` | admin | `{level}` / `{level}` (viewer/editor/пусто) |

## Модели (JSON, соответствуют Go-структурам lab-service)

```ts
Lab      { id, code, name, description, type: 'internal'|'external',
           parent_lab_id,  // только у внешних (обязателен при создании); 0 у внутренних —
                            // внешняя лаба не существует самостоятельно, см. lab-service/AGENTS.md
           created_at, updated_at }
LabMethod{ id, code, name,
           lab_ids: number[],  // может принадлежать нескольким лабам (method_labs, 2026-08-19);
                                // при создании заявки выбирается ОДНА конкретная (см. LabRequest.lab_id)
           description, determinable_indicators: string[], created_at, updated_at }
ObjectCharacteristics {
  ekn?: string;                    // номер ЕКН (серийная)
  batch_number?: number;           // номер партии (обязателен при ЕКН, целое)
  sample_id?: string;              // идентификатор образца (без ЕКН)
  sample_type?: 'series'|'experimental';
  thickness_mm?: string;
  target_indicator?: string;       // УСТАРЕЛО — пишут только email_ingest.go/import_history.go (aim_indicator письма), форма его больше не читает/не пишет
  target_indicators?: Record<string, string>;  // methodId -> значение из determinable_indicators (2026-08-21, форма)
  ekn_snapshot?: { name, thickness, sto_number, sto_name, fire_groups?: { flame_group?, flammability_gr?, flame_spread_gr? } };   // снимок sbe-ekn, fire_groups — с 2026-08-21
}
LabObject{ id, name, description, characteristics: ObjectCharacteristics, created_at, updated_at }
LabProject{ id, parent_id, code, name, description, is_ekn, group_id, owner_email, created_at, updated_at }
GroupMember{ email, role }
LabGroup  { id, name, owner_email, members: GroupMember[], created_at, updated_at }
RequestFile{ file_key, file_name, file_size, file_url }
LabRequest{ id, number_seq, number_year, title, description, object_id, project_id, group_id,
            owner_email, status: 'new'|'received'|'processing'|'completed',
            priority: 'normal'|'critical'|'blocker',
            test_purpose: ''|'quality_control'|'rnd'|'certification'|'declaration',
            ekn: string,
            external_id: string,  // номер legacy email-трекера («LPIZAYAVKINAPRO-<N>»);
                                   // у новых заявок пусто, только для миграции
            method_id: number,
            lab_id: number,  // конкретная лаба из method.lab_ids, зафиксирована при создании
                              // (заменяет старую external_lab_id — упразднена 2026-08-19)
            customer_number: string, lab_number: string,
            group_key?: string,   // только у локальных новых под-заявок одного создания
            parent_id?: number,   // только у локальных черновиков «добавление метода»
            // Системные атрибуты (2026-08-23) — испытатель/даты/условия среды, общие
            // для ЛЮБОГО метода; заполняются автоматически из письма-результата
            // email-импорта на сервере (не через этот плагин). См. sbe-lims/AGENTS.md,
            // «Правило: системные атрибуты». Пусто/0, пока не пришли.
            inventor_id: number, report_date: string, samples_in_date: string,
            exp_date: string, amb_temp: string, amb_pres: string, amb_moist: string,
            files: RequestFile[], created_at, updated_at, sync_status }
```

Примечания:
- `title` = наименование объекта исследования (поле «Наименование заявки» в форме НЕ вводится);
  если по ЕКН нет данных в PIM — заказчик заполняет название и целевые характеристики вручную
  (обязательно), и они становятся названием заявки.
- `test_purpose`: по умолчанию `quality_control` («Текущий контроль») для новых заявок.
- **1 заявка = 1 метод** (декомпозиция, `docs/superpowers/specs/2026-08-18-sbe-requests-per-method-design.md`):
  метод и оба номера лежат прямо в строке `requests`, таблица `request_methods` упразднена.
  Под-заявки одного «создания» делят общий NNN (`number_seq`+`number_year`) и связываются
  только им (без шапки); у локальных новых под-заявок — общий `group_key` (сервер выделяет
  один NNN на группу).

PushRequest (тело `POST /sync/push`, заявки): `{id, client_id, group_key, parent_id, title,
description, object_id, project_id, group_id, status, priority, test_purpose,
ekn, external_id, updated_at, method_id, lab_id}`. `lab_id` — конкретная лаба из
`method.lab_ids`, обязательна при создании (заменяет старую `external_lab_id`, 2026-08-19).
`id=0` — новая заявка: без `parent_id` сервер
присваивает NNN (под-заявки с одинаковым `group_key` получают один NNN); с `parent_id` —
**под-заявка делит NNN родителя** (только родитель в статусе `new`, владелец/admin; иначе —
новый NNN). Ответ `{inserted, updated, created:[{client_id, group_key, request}]}` — клиент
заменяет локальные записи через `replaceLocalRequest(client_id, request)`.

## Автопроект-ЕКН (сервер)

ЕКН и проект — независимые сущности. Если при создании/обновлении заявки `ekn` задан,
а `project_id = 0` — сервер создаёт проект с `code = ekn` (is_ekn=true) или переиспользует
существующий с таким кодом; заявка привязывается к нему. При явно выбранном проекте
автопроект не создаётся.

## Нумерация (сервер, аддендум спеки §9)

- NNN — единый сквозной счётчик по году (не зависит от проекта), простое значение (1, 2, 3, ...).
- Заказчику: `{projectID}-{NNN}/{yyyy}-{labID}-{methodID}` (projectID = `projects.code`, вне проекта — `0`).
- Лаборатории: `{NNN}/{yyyy}-{methodID}` (labID НЕ входит).
- Номера резервируются при создании заявки/метода. **Единственный пересчёт
  (2026-09-21): смена проекта у заявки** — сервер пересобирает номер заказчику
  под новый код проекта (`rebuildCustomerNumber` в `lab-service`, зовётся и из
  `PATCH /requests/{id}`, и из `sync/push`). Номер лаборатории не меняется —
  кода проекта в нём нет. Плагин перед сохранением показывает пару «было →
  стало» и спрашивает подтверждение.

## Локальная БД

`yourbase/sbe_requests/requests_data.json`:
`{ requests: LabRequest[], projects: LabProject[], groups: LabGroup[], labs: Lab[], methods: LabMethod[], objects: LabObject[] }`

- `sync()`: push всех `sync_status='local'` → pull → merge (заявки LWW по `updated_at`,
  справочники/проекты/группы — полная замена слепком). Новые заявки пушатся с `id=0` +
  `client_id`; серверные версии из `created` заменяют локальные записи
  (`replaceLocalRequest(client_id, request)` — подхватываются настоящий id и номера).
- Права/участники/статусы/справочники/файлы — через отдельные endpoints (не через sync).

## Роли

`viewer`(1) < `editor`(2) < `admin`(3) < `superadmin`(4, добавлена 2026-08-19 для ЛИМС —
см. lab-service/AGENTS.md). В этом плагине superadmin не имеет своих ДОПОЛНИТЕЛЬНЫХ
привилегий сверх admin (кроме назначения/снятия роли superadmin другим), но **должен
проходить все editor/admin-проверки клиента** — он строго выше admin по рангу.
⚠️ Именно это было упущено при первом введении роли (2026-08-19): `canEdit`/`isAdmin`
в `requests-view.ts` проверяли точное совпадение `'editor'`/`'admin'`, из-за чего
superadmin (владелец приложения) не видел кнопку создания заявки и терял доступ к
файлам/статусам/группам — исправлено (см. историю v0.1.10). Просмотр — viewer;
создание/правка заявок, справочников (objects), проектов, групп, статусы — editor+;
labs/methods и права — admin+; создание лабораторий (`POST /labs`, используется в
ЛИМС, не в этом плагине) — только superadmin. Правка заявки — только владелец или
admin+ (сервер). Участники групп — владелец группы или admin+. Общий доступ
`{app}_common_access` даёт роль по умолчанию (viewer/editor).

**Лаборатории и методы в плагине — только чтение** (наполняются в ЛИМС; в заявку и в справочник
подтягиваются оттуда). Создание labs/methods из плагина заявок недоступно.

## Файлы (S3)

Загрузка: `POST /api/lab/file` (multipart `request_id` + `file`), ответ содержит
`file_key`/`file_url` (бакет `sbe-doc`, ключ `lab/{uuid}/main-{name}`). **Бакет
приватный** — `file_url` не открывается напрямую (ошибка доступа к S3, найдено
2026-08-19); скачивание — только через `GET /api/lab/file?key=` (JWT, сервер сам
читает S3 своими учётными данными). Плагин: `downloadFile()` → сохранение в
`yourbase/sbe_requests/files/` → открытие в Obsidian или системным приложением
(`downloadAndOpen()`, тот же паттерн, что в `sbe-documents`).

## UI

- Вьюха «Заявки на испытания» (тип `sbe-requests-view`): дерево проектов (с фильтром
  «Без проекта») + таблица заявок (колонки: **Номер заявки** = customer_number первого метода,
  Объект, Статус, Обновлено; название заявки — подпись под номером), карточка заявки
  (методы с номерами, определяемые показатели, файлы, смена статуса, правка), группы
  (создание, участники), справочники (labs/methods — только чтение, objects — создание editor).
  Карточка заявки, если `external_id` не пуст (заявки переходного периода миграции),
  показывает строку «📧 Внешний идентификатор: LPIZAYAVKINAPRO-{external_id}» (2026-08-21) —
  префикс восстанавливается только для отображения, в БД хранится без него (см. `external_id`
  в разделе «Модели» ниже).
- **Панель фильтров** над списком заявок (2026-09-04): дата создания «от/до»,
  метод, статус (Все / Активные / Завершённые), **важность** (Все / Обычный /
  Критический / Блокирующий — 2026-09-21), название объекта, идентификатор
  (customer/lab/external/ID), партия, заказчик. Все непустые поля комбинируются
  по И; фильтрация целиком клиентская — сервер query-параметров для списка
  заявок не принимает. Такая же панель в ЛИМС и в веб-портале.
- Справочник «Объекты»: у каждой строки кнопка **«→ Заявки»** (2026-08-21) — переход к
  списку заявок, отфильтрованному по этому объекту (баннер с кнопкой сброса). Понадобилось
  после объединения дублей объектов в lab-service (469 → 134 объекта, объекты-плейсхолдеры
  «Без названия» объединены в один — без этой кнопки не отличить заявки друг от друга).
- **Форма заявки** (адаптация под практику, 2026-08-18):
  - **Объект исследования**: поле «ЕКН» — подсказки по частичному совпадению
    (`getService('sbe-ekn').search()`) + точный запрос при полном 6-значном номере
    (`getEknProduct`, 2026-08-21). Найден — автозаполнение названия/толщины
    («📄 Найдено в справочнике: …»), обязательный «Номер партии» (целое), тип
    объекта автоматически — «Серийный выпуск». Не найден — «⚠️ Неизвестный
    продукт, введите название»: заказчик указывает название/толщину сам, при
    сохранении заявки они отправляются в справочник ЕКН (`saveManualEknProduct` →
    `sbe-ekn` → `POST /api/ekn/manual/{ekn}`, непроверенная в QRC запись — см.
    `server_back/ekn-service/AGENTS.md`) — следующая заявка с тем же ЕКН подставит
    название автоматически. Поля названия/толщины общие для ЕКН и без ЕКН — не
    пропадают при вводе номера (только пропадает надпись «Экспериментальный образец
    (без ЕКН)» и поле «Идентификатор образца»). Если ЕКН пуст — блок
    «Экспериментальный образец»: название материала (обяз.), тип объекта
    (Серийный/Экспериментальный), толщина мм, идентификатор образца (обяз.).
  - **Важность** (Обычный / Критический / Блокирующий — подписи стандартизированы
    2026-09-21, один набор на плагин, ЛИМС и портал; в базе прежние значения
    `normal`/`critical`/`blocker`), **Цель испытания** (Текущий контроль —
    по умолчанию / НИОКР / Сертификация / Декларирование).
  - **Смена проекта у существующей заявки** спрашивает подтверждение с парой
    «было → стало» по номеру заказчика (2026-09-21): код проекта — первая часть
    номера, и сервер пересоберёт его (`rebuildCustomerNumber`). Предпросмотр
    считает общая с порталом формула `sbe-core/src/utils/request-number.ts`;
    записывает номер только сервер. Номер лаборатории не меняется.
  - Пустой справочник проектов или групп показывает под выпадающим списком
    строку «Справочник … не загружен — нажмите «Синхронизировать»», а в консоль
    пишет размеры кэша и время последней удачной синхронизации (2026-09-21).
  - **Методы** (группы по лабораториям; метод с несколькими `lab_ids` показывается под
    каждой своей лабой отдельной строкой — чекбокс кодирует пару `"methodId:labId"`,
    выбор пары фиксирует, где именно выполняется испытание; заменяет старый отдельный
    чекбокс «внешняя лаборатория», 2026-08-19, см. `lab-service/AGENTS.md`) +
    **Целевой показатель** (2026-08-21, было «Определяемые показатели» — просто
    информационный список без действия) — обязательный **одиночный** выбор
    (radio), отдельная группа значений из `method.determinable_indicators`
    **на каждый выбранный метод** (общий выбор между методами не имеет смысла —
    у ГГ/ГВ/РП разные шкалы). Предзаполняется из карточки ЕКН, если QRC хранит
    цель для этого метода (`groups.fire_characteristics.flame_group` → ГГ,
    `.flammability_gr` → ГВ, `.flame_spread_gr` → РП, значения вида «Г4»/«В2»/
    «РП1»; методы МП/КП/КИ — только ручной выбор). Не распознано — по умолчанию
    ничего не выбрано, сохранение заблокировано, пока не выбран показатель для
    каждого метода с непустым `determinable_indicators`. Хранится в
    `objects.characteristics.target_indicators: {methodId: значение}` (не в
    `target_indicator` — тот теперь используется только заявками из
    email-ingestion/исторического переноса, см. «Модели» ниже). При создании с
    несколькими методами формируется N под-заявок с общим NNN (общий
    `group_key`), каждая со своей парой метод+лаба.
  - **Редактирование заявки**: только статус `new`. Метод и лаба зафиксированы; блок
    **«➕ Добавить методы (создаст под-заявки с тем же номером)»** — отмеченные
    пары метод+лаба создают под-заявки с `parent_id` (делят NNN родителя;
    `requestNumber`/`buildDraftNumbers` показывают превью номера до синхронизации).
- Кнопка **«?»** рядом с «🔄» — открывает справку `Заявки на испытания — инструкция.md`
  (создаётся в корне вольта из `src/ui/help.ts`, если отсутствует). Редактирование проекта —
  кнопка «✎» в дереве проектов (владелец/admin, `PATCH /projects/{id}`).
- **Видимость проектов по группе** (2026-08-19): проект с `group_id` видят только члены
  этой группы + владелец + admin (сервер фильтрует `/projects` и `/sync/pull`; предки
  видимых проектов включаются, чтобы дерево не рвалось). В форме проекта — select
  «Группа (видимость)» («— Публичный —» = 0). При создании заявки в проекте с группой
  поле «Группа (видимость)» формы автоматически подставляется группой проекта
  (смена проекта в форме переустанавливает его группу; при редактировании заявки
  существующее значение не трогается).
- **Полный номер заявки везде** (2026-08-24, по прямому запросу пользователя): заголовок
  карточки заявки и имена скачиваемых файлов (Word/Excel) показывают `customer_number`
  (`{projectID}-{NNN}/{yyyy}-{labID}-{methodID}`) — единственную форму со всеми тремя
  кодами; короткий `NNN/yyyy` — только fallback для черновика, которому сервер ещё не
  присвоил номер (`requestNumber()`).
- **Краткий вид результатов** (блок в карточке заявки) обёрнут классом `.tn-protocol-html`
  (2026-08-24) — границы и центрирование таблиц результатов, зеркалит серверный `<style>`
  из `protocol.go`, который сюда не доходит (вставляется только `doc.body.innerHTML`).
- **Скачивание отчёта прямо со страницы заявок** (2026-08-24, по прямому запросу
  пользователя — раньше Word был доступен только в ЛИМС, Excel не было вообще нигде):
  в карточке заявки кнопки «📄 Скачать протокол (Word)» и «📊 Скачать таблицу
  (Excel)» (серии + агрегаты/статистика), общий хелпер `downloadBase64File`
  (`sbe-core/src/utils/download.ts`).
  **С 2026-10-19** «Скачать протокол» отдаёт ИИ-отчёт на бланке —
  `GET /api/lab/requests/{id}/report.docx` (`getReport()`, тот же документ, что
  кнопка «📄 ИИ-отчёт» в ЛИМС), файл `report_<номер>.docx`. Кнопка доступна всем,
  кому видна заявка (владелец/участник группы/сотрудник лабы — `requireLabRead`
  на сервере), а не только editor+; Excel-выгрузка остаётся editor+.
- Настройки: `apiUrl` + раздел «Права доступа» (роли + общий доступ, admin).