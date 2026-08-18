/** Типы модуля «Заявки на испытания» SBE. Модель совместима с lab-service (server_back/lab-service). */

/** Лаборатория (справочник). */
export interface Lab {
  id: number;
  code: string;
  name: string;
  description: string;
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
  created_at: string;
  updated_at: string;
}

/** Объект исследования (характеристики — JSONB). */
export interface LabObject {
  id: number;
  name: string;
  description: string;
  characteristics: Record<string, unknown>;
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

/** Метод заявки с присвоенными номерами. */
export interface RequestMethod {
  method_id: number;
  customer_number: string;
  lab_number: string;
}

/** Файл заявки (в S3). */
export interface RequestFile {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
}

/** Заявка на испытания. updated_at — для LWW (сервер авторитетен). */
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
  methods: RequestMethod[];
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
  created: Array<{ client_id: number; request: LabRequest }>;
}

/** Ответ сервера на загрузку файла. */
export interface UploadFileResponse {
  file_key: string;
  file_name: string;
  file_size: number;
  file_url: string;
  request_id: number;
}