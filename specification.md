# specification.md — sbe-requests (Заявки на испытания)

SBE-плагин «Заявки на испытания». Клиент lab-service (сервер — канон, локально — кэш).
База URL по умолчанию: `https://epyur.fvds.ru`. JWT для `app_id=lab` берётся из ЦУП СБЕ
(`getService('sbe-apstore').auth.getToken('lab')`).

## API (lab-service, `/api/lab/*`)

| Метод | Путь | Роль | Тело / ответ |
|---|---|---|---|
| GET | `/health` | — | `{"status":"ok"}` |
| GET | `/labs` `/methods` `/objects` | viewer | `{"labs":[...]}` / `{"methods":[...]}` / `{"objects":[...]}` |
| POST | `/labs` `/methods` | admin | `{code,name,description}` / `{code,name,lab_id,description}` → `{id}` |
| POST | `/objects` | editor | `{name,description,characteristics}` → `{id}` |
| GET | `/projects` | viewer | `{"projects":[...]}` (все) |
| POST | `/projects` | editor | `{parent_id,code,name,description,is_ekn}` → `{id}`; 409 code exists |
| PATCH | `/projects/{id}` | editor+/владелец | `{parent_id,code,name,description,is_ekn}` → `{ok}` |
| GET | `/requests` | viewer | `{"requests":[...]}` (только видимые) |
| POST | `/requests` | editor | `{title,description,object_id,project_id,group_id,method_ids}` → `{request}` |
| GET | `/requests/{id}` | viewer (видимость) | `{"request":{...}}`; 403 если не видно |
| PATCH | `/requests/{id}` | editor+/владелец | `{title,description,object_id,project_id,group_id,method_ids}` → `{request}` |
| POST | `/requests/{id}/status` | editor | `{status}` (new/processing/completed) → `{ok}` |
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
Lab      { id, code, name, description, created_at, updated_at }
LabMethod{ id, code, name, lab_id, description, created_at, updated_at }
LabObject{ id, name, description, characteristics: Record<string,unknown>, created_at, updated_at }
LabProject{ id, parent_id, code, name, description, is_ekn, owner_email, created_at, updated_at }
GroupMember{ email, role }
LabGroup  { id, name, owner_email, members: GroupMember[], created_at, updated_at }
RequestMethod{ method_id, customer_number, lab_number }
RequestFile{ file_key, file_name, file_size, file_url }
LabRequest{ id, number_seq, number_year, title, description, object_id, project_id, group_id,
            owner_email, status, methods: RequestMethod[], files: RequestFile[],
            created_at, updated_at, sync_status }
```

PushRequest (тело `POST /sync/push`, заявки): `{id, client_id, title, description, object_id,
project_id, group_id, status, updated_at, method_ids}`. `id=0` — новая заявка (сервер присваивает
NNN и номера, отвечает в `created` с `client_id` и полной заявкой — клиент заменяет локальную
запись через `replaceLocalRequest`).

## Нумерация (сервер, аддендум спеки §9)

- NNN — единый сквозной счётчик по году (не зависит от проекта), простое значение (1, 2, 3, ...).
- Заказчику: `{projectID}-{NNN}/{yyyy}-{labID}-{methodID}` (projectID = `projects.code`, вне проекта — `0`).
- Лаборатории: `{NNN}/{yyyy}-{methodID}` (labID НЕ входит).
- Номера резервируются при создании заявки/метода и не пересчитываются.

## Локальная БД

`yourbase/sbe_requests/requests_data.json`:
`{ requests: LabRequest[], projects: LabProject[], groups: LabGroup[], labs: Lab[], methods: LabMethod[], objects: LabObject[] }`

- `sync()`: push всех `sync_status='local'` → pull → merge (заявки LWW по `updated_at`,
  справочники/проекты/группы — полная замена слепком). Новые заявки пушатся с `id=0` +
  `client_id`; серверные версии из `created` заменяют локальные записи
  (`replaceLocalRequest(client_id, request)` — подхватываются настоящий id и номера).
- Права/участники/статусы/справочники/файлы — через отдельные endpoints (не через sync).

## Роли

`viewer`(1) < `editor`(2) < `admin`(3). Просмотр — viewer; создание/правка заявок, справочников
(objects), проектов, групп, статусы — editor+; labs/methods и права — admin. Правка заявки —
только владелец или admin (сервер). Участники групп — владелец группы или admin.
Общий доступ `{app}_common_access` даёт роль по умолчанию (viewer/editor).

**Лаборатории и методы в плагине — только чтение** (наполняются в ЛИМС; в заявку и в справочник
подтягиваются оттуда). Создание labs/methods из плагина заявок недоступно.

## Файлы (S3)

Загрузка: `POST /api/lab/file` (multipart `request_id` + `file`), ответ содержит
`file_key`/`file_url` (бакет `sbe-doc`, ключ `lab/{uuid}/main-{name}`). Скачивание — прямой
`file_url` (публичная ссылка S3) или `GET /api/lab/file?key=`.

## UI

- Вьюха «Заявки на испытания» (тип `sbe-requests-view`): дерево проектов (с фильтром
  «Без проекта») + таблица заявок (колонки: **Номер заявки** = customer_number первого метода,
  Объект, Статус, Обновлено; название заявки — подпись под номером), карточка заявки
  (методы с номерами, файлы, смена статуса, правка), группы (создание, участники),
  справочники (labs/methods — только чтение, objects — создание editor).
- Настройки: `apiUrl` + раздел «Права доступа» (роли + общий доступ, admin).