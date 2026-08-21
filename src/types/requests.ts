/** Типы модуля «Заявки на испытания» SBE. Модель совместима с lab-service (server_back/lab-service). */

/** Лаборатория (справочник). type: internal | external. Внешняя лаба не существует
 * самостоятельно — parent_lab_id указывает на внутреннюю (0 у внутренних). */
export interface Lab {
  id: number;
  code: string;
  name: string;
  description: string;
  type: string;
  parent_lab_id: number;
  created_at: string;
  updated_at: string;
}

/** Метод испытаний. Может принадлежать нескольким лабораториям (2026-08-19,
 * method_labs many-to-many, заменяет старую единичную lab_id) — при создании
 * заявки нужно выбрать ОДНУ конкретную из lab_ids (см. LabRequest.lab_id). */
export interface LabMethod {
  id: number;
  code: string;
  name: string;
  lab_ids: number[];
  description: string;
  determinable_indicators: string[];
  created_at: string;
  updated_at: string;
}

/** Характеристики объекта исследования (objects.characteristics JSONB). */
export interface ObjectCharacteristics {
  /** Номер ЕКН (серийная продукция). */
  ekn?: string;
  /** Номер партии (обязателен при ЕКН, целое число). */
  batch_number?: number;
  /** Идентификатор образца (без ЕКН, число/текст). */
  sample_id?: string;
  /** Тип образца: series | experimental. */
  sample_type?: string;
  /** Толщина образца, мм (без ЕКН). */
  thickness_mm?: string;
  /** УСТАРЕЛО (2026-08-21) — свободный ввод убран из формы, заменён на
   * target_indicators (выбор из списка метода, по методу). Оставлено в типе
   * только для чтения старых заявок/объектов из email_ingest.go, где поле
   * по-прежнему пишется как aim_indicator из письма. */
  target_indicator?: string;
  /** Целевой показатель по методу: methodId → одно значение из
   * method.determinable_indicators (2026-08-21, обязателен при наличии у
   * метода определяемых показателей — предзаполняется из ekn_snapshot.fire_groups,
   * если распознано, иначе выбирается пользователем вручную). */
  target_indicators?: Record<string, string>;
  /** Снимок данных из sbe-ekn: {name, thickness, sto_number, sto_name} +
   * группы пожарной классификации из QRC (fire_groups, 2026-08-21) — только
   * значения, которые реально удалось извлечь (см. sync.service.getEknProduct). */
  ekn_snapshot?: {
    name: string;
    thickness: string;
    sto_number: string;
    sto_name: string;
    fire_groups?: {
      flame_group?: string;
      flammability_gr?: string;
      flame_spread_gr?: string;
    };
  };
}

/** Объект исследования (характеристики — JSONB). */
export interface LabObject {
  id: number;
  name: string;
  description: string;
  characteristics: ObjectCharacteristics;
  created_at: string;
  updated_at: string;
}

/** Проект / подпроект (дерево через parent_id). code — уникальный ИД проекта. */
export interface LabProject {
  id: number;
  parent_id: number;
  code: string;
  name: string;
  description: string;
  is_ekn: boolean;
  group_id: number;
  owner_email: string;
  created_at: string;
  updated_at: string;
}

/** Участник группы. */
export interface GroupMember {
  email: string;
  role: string;
}

/** Группа участников (видимость заявок группы). */
export interface LabGroup {
  id: number;
  name: string;
  owner_email: string;
  members: GroupMember[];
  created_at: string;
  updated_at: string;
}

/** Файл заявки (в S3). */
export interface RequestFile {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
}

/** Заявка на испытания. 1 заявка = 1 метод (метод и номера прямо в строке).
 * Под-заявки одной группы делят общий NNN (одинаковые number_seq + number_year).
 * group_key — только для новых локальных заявок (объединяет под-заявки одного
 * создания в офлайне, чтобы сервер выделил один NNN на группу). updated_at — для LWW. */
export interface LabRequest {
  id: number;
  number_seq: number;
  number_year: number;
  title: string;
  description: string;
  object_id: number;
  project_id: number;
  group_id: number;
  owner_email: string;
  status: string;
  /** Приоритет: normal | critical | blocker. */
  priority: string;
  /** Цель испытания: quality_control | rnd | certification | declaration. */
  test_purpose: string;
  /** Номер ЕКН (для автопроекта, если проект не выбран). */
  ekn: string;
  /** Номер из legacy-системы (email-трекер LPITrack, «LPIZAYAVKINAPRO-<N>») —
   * для заявок переходного периода миграции; у новых заявок пусто. */
  external_id: string;
  /** Метод испытаний (1 заявка = 1 метод). */
  method_id: number;
  /** Конкретная лаборатория из lab_ids метода, выбранная при создании (2026-08-19,
   * заменяет старую external_lab_id — методы теперь могут принадлежать нескольким
   * лабам, поэтому заявка обязана явно зафиксировать одну; может быть внешней). */
  lab_id: number;
  /** Номер заказчику: {projectCode}-{NNN}/{yyyy}-{labCode}-{methodCode}. */
  customer_number: string;
  /** Номер лаборатории: {NNN}/{yyyy}-{methodCode}. */
  lab_number: string;
  /** Общий ключ группы под-заявок (только у новых локальных). */
  group_key?: string;
  /** Родительская заявка: под-заявка создаётся добавлением метода и делит
   * её NNN (только пока родитель в статусе new). Только у локальных черновиков. */
  parent_id?: number;
  files: RequestFile[];
  created_at: string;
  updated_at: string;
  sync_status: 'local' | 'synced';
}

/** Локальная БД плагина. */
export interface RequestsDbData {
  requests: LabRequest[];
  projects: LabProject[];
  groups: LabGroup[];
  labs: Lab[];
  methods: LabMethod[];
  objects: LabObject[];
}

/** Ответ сервера на pull — полный слепок для кэша. */
export interface PullResponse {
  requests: LabRequest[];
  projects: LabProject[];
  groups: LabGroup[];
  labs: Lab[];
  methods: LabMethod[];
  objects: LabObject[];
}

/** Ответ сервера на push: количество вставленных/обновлённых + созданные заявки (для замены локальных). */
export interface PushResponse {
  inserted: number;
  updated: number;
  created: Array<{ client_id: number; group_key?: string; request: LabRequest }>;
}

/** Ответ сервера на загрузку файла. */
export interface UploadFileResponse {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
  request_id: number;
}