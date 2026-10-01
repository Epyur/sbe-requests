import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import type { RequestsDatabase } from '../database/requests-db';
import type {
  AuditLogEntry, LabRequest, ProtocolResponse, PullResponse, PushOutcome, PushResponse, UploadFileResponse,
} from '../types/requests';

export interface SyncResult {
  pushed: number;
  pulled: number;
}

/** Читает значение группы пожарной классификации из сырого ответа QRC
 * (product.data.groups.fire_characteristics.<field>.value) — например
 * flame_group="Г4" (Группа горючести). Данные из sbe-ekn типизированы как
 * `unknown` (кросс-плагинная граница), поэтому только безопасный разбор. */
function readFireGroupValue(data: unknown, field: string): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const groups = (data as Record<string, unknown>).groups;
  if (!groups || typeof groups !== 'object') return undefined;
  const fire = (groups as Record<string, unknown>).fire_characteristics;
  if (!fire || typeof fire !== 'object') return undefined;
  const attr = (fire as Record<string, unknown>)[field];
  if (!attr || typeof attr !== 'object') return undefined;
  const value = (attr as Record<string, unknown>).value;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Синхронизация с lab-service через JWT из ЦУП. Сервер — канон, локально — кэш. */
export class RequestsSyncService {
  private db: RequestsDatabase;
  private getApiUrl: () => string;
  private syncInFlight: Promise<SyncResult> | null = null;

  constructor(db: RequestsDatabase, getApiUrl: () => string) {
    this.db = db;
    this.getApiUrl = getApiUrl;
  }

  get baseUrl(): string {
    return this.getApiUrl().trim().replace(/\/+$/, '');
  }

  async sync(): Promise<SyncResult> {
    if (this.syncInFlight) return this.syncInFlight;
    const running = this.syncOnce();
    this.syncInFlight = running;
    try {
      return await running;
    } finally {
      if (this.syncInFlight === running) this.syncInFlight = null;
    }
  }

  private async syncOnce(): Promise<SyncResult> {
    const token = await this.getToken();
    const dirty = this.db.getAll().filter(r => r.sync_status === 'local');
    let pushed = 0;
    if (dirty.length > 0) {
      const snapshots = new Map(dirty.map(r => [r.id, r.updated_at]));
      const res = await this.push(token, dirty);
      pushed = res.inserted + res.updated;
      const outcomes = new Map<number, PushOutcome>();
      for (const outcome of res.outcomes) outcomes.set(outcome.client_id, outcome);
      for (const r of dirty) {
        const outcome = outcomes.get(r.id);
        if (!outcome || snapshots.get(r.id) !== r.updated_at) continue;
        if (outcome.status === 'created' && outcome.request) {
          this.db.replaceLocalRequest(r.id, outcome.request);
        } else if (outcome.status === 'updated') {
          r.sync_status = 'synced';
        }
      }
      await this.db.save();
    }
    const pulled = await this.pull(token);
    this.db.mergeRequestsFromServer(pulled.requests);
    this.db.pruneSyncedNotInServer(new Set(pulled.requests.map(r => r.id)));
    this.db.replaceReferenceData(pulled);
    await this.db.save();
    return { pushed, pulled: pulled.requests.length };
  }

  /** Только pull + merge (для обновления кэша без пуша). */
  async pullAndMerge(): Promise<number> {
    const token = await this.getToken();
    const pulled = await this.pull(token);
    this.db.mergeRequestsFromServer(pulled.requests);
    this.db.pruneSyncedNotInServer(new Set(pulled.requests.map(r => r.id)));
    this.db.replaceReferenceData(pulled);
    await this.db.save();
    return pulled.requests.length;
  }

  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('lab');
  }

  /** Сервер принимает только заявки (push-слепок), справочники/проекты/группы — только с pull. */
  private async push(token: string, requests: LabRequest[]): Promise<PushResponse> {
    const payload = requests.map(r => ({
      id: r.sync_status === 'local' && r.number_seq === 0 ? 0 : r.id,
      client_id: r.id,
      group_key: r.group_key || '',
      parent_id: r.parent_id || 0,
      title: r.title,
      description: r.description,
      object_id: r.object_id,
      project_id: r.project_id,
      group_id: r.group_id,
      status: r.status,
      priority: r.priority,
      test_purpose: r.test_purpose,
      ekn: r.ekn,
      external_id: r.external_id || '',
      updated_at: r.updated_at,
      method_id: r.method_id,
      lab_id: r.lab_id,
    }));
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/sync/push`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ requests: payload }),
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as PushResponse;
      return {
        inserted: data.inserted || 0,
        updated: data.updated || 0,
        created: Array.isArray(data.created) ? data.created : [],
        outcomes: Array.isArray(data.outcomes) ? data.outcomes : [],
      };
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе push:', errorMessage(e));
      throw new Error('Сервер вернул не JSON при синхронизации');
    }
  }

  private async pull(token: string): Promise<PullResponse> {
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/sync/pull`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as PullResponse;
      return {
        requests: Array.isArray(data.requests) ? data.requests : [],
        projects: Array.isArray(data.projects) ? data.projects : [],
        groups: Array.isArray(data.groups) ? data.groups : [],
        labs: Array.isArray(data.labs) ? data.labs : [],
        methods: Array.isArray(data.methods) ? data.methods : [],
        objects: Array.isArray(data.objects) ? data.objects : [],
      };
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе pull:', errorMessage(e));
      return { requests: [], projects: [], groups: [], labs: [], methods: [], objects: [] };
    }
  }

  /** Возвращает роль текущего пользователя ({email, role, hasAccess}). */
  async getMyPermission(): Promise<{ email: string; role: string; hasAccess: boolean }> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/permissions/me`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as { email: string; role: string; hasAccess: boolean };
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе permissions/me:', errorMessage(e));
      return { email: '', role: '', hasAccess: false };
    }
  }

  /** Список прав (для admin). */
  async listPermissions(): Promise<Array<{ email: string; role: string }>> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/permissions`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { permissions?: Array<{ email: string; role: string }> };
      return Array.isArray(data.permissions) ? data.permissions : [];
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе permissions:', errorMessage(e));
      return [];
    }
  }

  /** Устанавливает/отзывает роль (для admin). role='' — отозвать. */
  async setPermission(email: string, role: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/permissions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    });
    this.assertOk(res);
  }

  /** Создаёт объект исследования (editor). Возвращает id. */
  async createObject(name: string, description: string, characteristics: Record<string, unknown>): Promise<number> {
    return this.createReference('/api/lab/objects', { name, description, characteristics });
  }

  /** Обновляет объект исследования (editor) — characteristics заменяются целиком,
   * не мержатся (2026-08-24; см. requests-view.ts renderRequestForm — вызывается
   * вместо createObject при редактировании заявки с уже привязанным объектом,
   * иначе каждое редактирование заводило новый "осиротевший" объект). */
  async updateObject(id: number, data: { name?: string; description?: string; characteristics?: Record<string, unknown> }): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/objects/${id}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    this.assertOk(res);
  }

  /** Получает данные продукта по ЕКН из sbe-ekn. При недоступности — null (не блокирует заявку). */
  async getEknProduct(ekn: string): Promise<import('../types/requests').ObjectCharacteristics['ekn_snapshot'] | null> {
    try {
      const eknService = await getService('sbe-ekn');
      const product = await eknService.getProduct(ekn);
      const fireGroups: Record<string, string> = {};
      const flameGroup = readFireGroupValue(product.data, 'flame_group');
      const flammabilityGr = readFireGroupValue(product.data, 'flammability_gr');
      const flameSpreadGr = readFireGroupValue(product.data, 'flame_spread_gr');
      if (flameGroup) fireGroups.flame_group = flameGroup;
      if (flammabilityGr) fireGroups.flammability_gr = flammabilityGr;
      if (flameSpreadGr) fireGroups.flame_spread_gr = flameSpreadGr;
      return {
        name: product.name,
        thickness: product.thickness,
        sto_number: product.sto_number,
        sto_name: product.sto_name,
        ...(Object.keys(fireGroups).length > 0 ? { fire_groups: fireGroups } : {}),
      };
    } catch (e: unknown) {
      console.warn('Заявки: не удалось получить данные ЕКН из sbe-ekn:', errorMessage(e));
      return null;
    }
  }

  /** Сохраняет в справочнике ЕКН карточку продукта, не найденного там на
   * момент оформления заявки (данные, введённые заказчиком вручную) — чтобы
   * при следующей заявке с тем же ЕКН название подставлялось автоматически.
   * Не блокирует сохранение заявки при ошибке (та же логика, что getEknProduct). */
  async saveManualEknProduct(ekn: string, name: string, thickness: string): Promise<void> {
    try {
      const eknService = await getService('sbe-ekn');
      await eknService.setManualProduct(ekn, name, thickness);
    } catch (e: unknown) {
      console.warn('Заявки: не удалось сохранить ручную карточку ЕКН в sbe-ekn:', errorMessage(e));
    }
  }

  /** Создаёт проект/подпроект (editor). Возвращает id. */
  async createProject(data: {
    parent_id: number; code: string; name: string; description: string; is_ekn: boolean; group_id: number;
    mail_trigger_ekn: string; mail_trigger_sender: string;
  }): Promise<number> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/projects`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    this.assertOk(res);
    try {
      const parsed = JSON.parse(res.text) as { id?: number };
      return parsed.id || 0;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе projects:', errorMessage(e));
      throw new Error('Сервер вернул не JSON при создании проекта');
    }
  }

  /** Обновляет проект/подпроект (владелец/admin). Пустые поля не меняются на сервере
   * (кроме description/mail_trigger_*, которые перезаписываются как есть). */
  async updateProject(id: number, data: {
    code?: string; name?: string; description?: string; group_id?: number; parent_id?: number;
    mail_trigger_ekn?: string; mail_trigger_sender?: string;
  }): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/projects/${id}`,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    this.assertOk(res);
  }

  /** Удаляет проект/подпроект (владелец/admin). Сервер отвечает 409 с русским
   * сообщением, если на проект ещё ссылаются заявки или подпроекты —
   * assertOk() уже прокидывает текст ошибки сервера, не только код. */
  async deleteProject(id: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/projects/${id}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Создаёт группу (editor). Возвращает id. */
  async createGroup(name: string): Promise<number> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/groups`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });
    this.assertOk(res);
    try {
      const parsed = JSON.parse(res.text) as { id?: number };
      return parsed.id || 0;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе groups:', errorMessage(e));
      throw new Error('Сервер вернул не JSON при создании группы');
    }
  }

  /** Добавляет участника в группу (владелец/admin). role: viewer|editor. */
  async addGroupMember(groupId: number, email: string, role: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/groups/${groupId}/members`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, role }),
    });
    this.assertOk(res);
  }

  /** Удаляет участника из группы (владелец/admin). */
  async removeGroupMember(groupId: number, email: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/groups/${groupId}/members/${encodeURIComponent(email)}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Удаляет группу (владелец/admin). Сервер отвечает 409 с русским сообщением,
   * если на группу ещё ссылаются заявки или проекты — см. deleteProject. */
  async deleteGroup(id: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/groups/${id}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Краткий вид результатов метода заявки (read-only) — тот же эндпоинт, что
   * и остальные виды документа в ЛИМС, но kind="ui"&format="html" (html
   * приходит готовым, плейсхолдеры уже резолвлены сервером — не тратим время
   * на сборку DOCX только для предпросмотра). Заявки на испытания раньше
   * вообще не показывали результаты метода. */
  async getProtocolHTML(requestId: number): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/protocol?template=ui&format=html`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const parsed = JSON.parse(res.text) as ProtocolResponse;
      return parsed.html;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе protocol:', errorMessage(e));
      throw new Error('Сервер вернул не JSON для результатов метода');
    }
  }

  /** Полный протокол (template=protocol, format=full — с DOCX) — для кнопки
   * «Скачать протокол (Word)» прямо со страницы заявок (2026-08-24, по
   * прямому запросу пользователя: раньше DOCX было доступно только в ЛИМС). */
  async getProtocolDocx(requestId: number): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/protocol?template=protocol&format=full`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const parsed = JSON.parse(res.text) as ProtocolResponse;
      return parsed.docx_base64;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе protocol:', errorMessage(e));
      throw new Error('Сервер вернул не JSON для протокола');
    }
  }

  /** Таблица всех данных заявки (серии + агрегаты/статистика) в Excel
   * (2026-08-24, по прямому запросу пользователя). */
  async getExportXlsx(requestId: number): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/export.xlsx`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const parsed = JSON.parse(res.text) as { xlsx_base64: string };
      return parsed.xlsx_base64;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе export.xlsx:', errorMessage(e));
      throw new Error('Сервер вернул не JSON для выгрузки Excel');
    }
  }

  /** Сменяет статус заявки (editor). status: new|processing|completed. */
  async setRequestStatus(requestId: number, status: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/status`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status }),
    });
    this.assertOk(res);
  }

  private async createReference(path: string, body: Record<string, unknown>): Promise<number> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}${path}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    this.assertOk(res);
    try {
      const parsed = JSON.parse(res.text) as { id?: number };
      return parsed.id || 0;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе reference:', errorMessage(e));
      throw new Error('Сервер вернул не JSON при создании справочника');
    }
  }

  /** Текущий уровень общего доступа (для admin). */
  async getCommonAccess(): Promise<string> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/common-access`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { level?: string };
      return data.level || '';
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе common-access:', errorMessage(e));
      return '';
    }
  }

  /** Устанавливает уровень общего доступа (для admin). level='' — отключить. */
  async setCommonAccess(level: string): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/common-access`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ level }),
    });
    this.assertOk(res);
  }

  /** Скачивает файл из S3 через сервис (GET /api/lab/file?key=...) — бакет sbe-doc
   * приватный, прямой file_url из ответа сервера недоступен из браузера/Electron
   * напрямую (см. sbe-documents/AGENTS.md, тот же фикс). */
  async downloadFile(fileKey: string): Promise<ArrayBuffer> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/file?key=${encodeURIComponent(fileKey)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, 120000);
    this.assertOk(res);
    return res.arrayBuffer;
  }

  /** Загружает файл заявки в S3 через сервис. Возвращает file_key/file_url. */
  async uploadFile(data: ArrayBuffer, fileName: string, requestId: number): Promise<UploadFileResponse> {
    const token = await this.getToken();
    const boundary = '----sbe-requests-' + Date.now().toString(36);
    const body = this.buildMultipart(data, fileName, boundary, String(requestId));
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/file`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    }, 120000);
    this.assertOk(res);
    try {
      return JSON.parse(res.text) as UploadFileResponse;
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе file:', errorMessage(e));
      throw new Error('Сервер вернул не JSON при загрузке файла');
    }
  }

  /** Журнал изменений заявки/результатов (2026-08-29, WP8) — смена статуса +
   * создание/правка серий результатов, newest-first, без пагинации (см. спеку). */
  async listAuditLog(requestId: number): Promise<AuditLogEntry[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/audit-log`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { entries?: AuditLogEntry[] };
      return Array.isArray(data.entries) ? data.entries : [];
    } catch (e: unknown) {
      console.warn('Заявки: не JSON в ответе audit-log:', errorMessage(e));
      return [];
    }
  }

  private buildMultipart(data: ArrayBuffer, fileName: string, boundary: string, requestId: string): ArrayBuffer {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="request_id"\r\n\r\n${requestId}\r\n`));
    parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(new Uint8Array(data));
    parts.push(enc.encode(`\r\n--${boundary}--\r\n`));

    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out.buffer;
  }

  private assertOk(res: { status: number; text: string }): void {
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Запросите новый ключ в ЦУП.');
    if (res.status === 403) throw new Error('Нет прав доступа к заявкам. Обратитесь к администратору.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
  }

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('Заявки: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  /** requestUrl в Obsidian не имеет таймаута — без обёртки зависший сервер не даст ответа никогда. */
  private async request(
    param: RequestUrlParam,
    timeoutMs = 30000,
  ): Promise<{ status: number; text: string; arrayBuffer: ArrayBuffer }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text, arrayBuffer: response.arrayBuffer };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}
