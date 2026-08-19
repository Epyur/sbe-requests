/** Типы модуля «Заявки на испытания» SBE. Модель совместима с lab-service (server_back/lab-service). */

/** Лаборатория (справочник). type: internal | external. */
export interface Lab {
  id: number;
  code: string;
  name: string;
  description: string;
  type: string;
  created_at: string;
  updated_at: string;
}

/** Метод испытаний (привязан к лаборатории lab_id). */
export interface LabMethod {
  id: number;
  code: string;
  name: string;
  lab_id: number;
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
  /** Целевой показатель (без ЕКН). */
  target_indicator?: string;
  /** Снимок данных из sbe-ekn: {name, thickness, sto_number, sto_name}. */
  ekn_snapshot?: {
    name: string;
    thickness: string;
    sto_number: string;
    sto_name: string;
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
  /** Внешняя лаборатория (0 = внутренняя; >0 = labs.id с type=external). */
  external_lab_id: number;
  /** Номер ЕКН (для автопроекта, если проект не выбран). */
  ekn: string;
  /** Номер из legacy-системы (email-трекер LPITrack, «LPIZAYAVKINAPRO-<N>») —
   * для заявок переходного периода миграции; у новых заявок пусто. */
  external_id: string;
  /** Метод испытаний (1 заявка = 1 метод). */
  method_id: number;
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