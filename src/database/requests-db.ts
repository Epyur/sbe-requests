import { App } from 'obsidian';
import type {
  Lab, LabGroup, LabMethod, LabObject, LabProject, LabRequest, RequestsDbData,
} from '../types/requests';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

const DB_DIR = 'yourbase/sbe_requests';
const DB_PATH = 'yourbase/sbe_requests/requests_data.json';

const EMPTY_DATA: RequestsDbData = {
  requests: [],
  projects: [],
  groups: [],
  labs: [],
  methods: [],
  objects: [],
};

/** Локальная БД заявок (кэш; сервер — каноническое хранилище). */
export class RequestsDatabase {
  private app: App;
  private data: RequestsDbData = { ...EMPTY_DATA, requests: [], projects: [], groups: [], labs: [], methods: [], objects: [] };

  constructor(app: App) {
    this.app = app;
  }

  async init(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const exists = await adapter.exists(DB_PATH);
      if (exists) {
        const content = await adapter.read(DB_PATH);
        const parsed = JSON.parse(content) as Partial<RequestsDbData>;
        this.data = {
          requests: Array.isArray(parsed.requests) ? parsed.requests : [],
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
          labs: Array.isArray(parsed.labs) ? parsed.labs : [],
          methods: Array.isArray(parsed.methods) ? parsed.methods : [],
          objects: Array.isArray(parsed.objects) ? parsed.objects : [],
        };
        // Миграция могла удалить/разделить заявки — сразу персистим, иначе
        // устаревшие строки (legacy methods[]) остаются в файле и рендерятся
        // как undefined (метод заявки теперь лежит в самой строке).
        if (this.migrateLegacyRequests()) {
          await this.save();
        }
      }
    } catch (e: unknown) {
      console.error('Заявки: не удалось прочитать БД:', errorMessage(e));
    }
  }

  /** Одноразовая миграция кэша: легaси-заявки с `methods[]` (старая модель) →
   * N под-заявок, где `method_id`/`customer_number`/`lab_number` в самой строке.
   * Идемпотентна: после конвертации у записи нет поля `methods`.
   * Возвращает true, если данные изменились (нужен save). */
  private migrateLegacyRequests(): boolean {
    interface LegacyMethod { method_id: number; customer_number: string; lab_number: string; }
    type LegacyRequest = LabRequest & { methods?: LegacyMethod[] };

    if (!this.data.requests.some(r => Array.isArray((r as LegacyRequest).methods) && ((r as LegacyRequest).methods?.length ?? 0) > 0)) {
      return false;
    }

    const migrated: LabRequest[] = [];
    let dropped = 0;
    let converted = 0;
    for (const raw of this.data.requests) {
      const legacy = raw as LegacyRequest;
      const methods = Array.isArray(legacy.methods) ? legacy.methods : [];
      if (methods.length === 0) {
        migrated.push(raw);
        continue;
      }
      const base = { ...legacy };
      delete (base as Partial<LegacyRequest>).methods;

      // Уже синхронизированные со старой моделью мульти-методные заявки на сервере
      // раскатываются в новые под-заявки с новыми id — локальная копия устарела,
      // её заменяет pull. Держим только синхронизированные однометодные.
      if (base.sync_status === 'synced') {
        if (methods.length === 1) {
          base.method_id = methods[0].method_id;
          base.customer_number = methods[0].customer_number;
          base.lab_number = methods[0].lab_number;
          migrated.push(base);
          converted++;
        } else {
          dropped++;
        }
        continue;
      }

      // Локальная (не отправленная) мульти-методная заявка — делим на N под-заявок
      // с общим group_key: сервер выделит один NNN на всю группу.
      const groupKey = String(Date.now()).slice(0, 3) + Math.floor(Math.random() * 1000);
      const firstId = base.id;
      methods.forEach((m, i) => {
        const sub = {
          ...base,
          id: i === 0 ? firstId : -(Date.now() + i),
          method_id: m.method_id,
          customer_number: m.customer_number,
          lab_number: m.lab_number,
          group_key: methods.length > 1 ? groupKey : undefined,
        };
        const clean = { ...sub };
        delete (clean as Partial<LegacyRequest>).methods;
        migrated.push(clean as LabRequest);
        converted++;
      });
    }

    if (dropped > 0) {
      console.warn('Заявки: кэш обновлён под модель «1 заявка = 1 метод»; синхронизированные мульти-методные заявки будут перечитаны с сервера при pull.');
    }
    this.data.requests = migrated;
    return dropped > 0 || converted > 0;
  }

  /** Убирает синхронизированные заявки, которых больше нет на сервере (сервер — канон).
   * Локально-изменённые (`sync_status === 'local'`) не трогает. Возвращает число удалённых. */
  pruneSyncedNotInServer(serverIds: Set<number>): number {
    const keep: LabRequest[] = [];
    let removed = 0;
    for (const r of this.data.requests) {
      if (r.sync_status === 'synced' && !serverIds.has(r.id)) {
        removed++;
        continue;
      }
      keep.push(r);
    }
    if (removed > 0) {
      this.data.requests = keep;
    }
    return removed;
  }

  private async ensureDataDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const exists = await adapter.exists(DB_DIR);
    if (!exists) {
      await adapter.mkdir(DB_DIR);
    }
  }

  async save(): Promise<void> {
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.write(DB_PATH, JSON.stringify(this.data, null, 2));
    } catch (e: unknown) {
      console.error('Заявки: не удалось сохранить БД:', errorMessage(e));
    }
  }

  getAll(): LabRequest[] {
    return this.data.requests;
  }

  getById(id: number): LabRequest | undefined {
    return this.data.requests.find(r => r.id === id);
  }

  getProjects(): LabProject[] {
    return this.data.projects;
  }

  getGroups(): LabGroup[] {
    return this.data.groups;
  }

  getLabs(): Lab[] {
    return this.data.labs;
  }

  getMethods(): LabMethod[] {
    return this.data.methods;
  }

  getObjects(): LabObject[] {
    return this.data.objects;
  }

  add(req: LabRequest): void {
    const idx = this.data.requests.findIndex(r => r.id === req.id);
    if (idx !== -1) {
      this.data.requests[idx] = req;
    } else {
      this.data.requests.push(req);
    }
  }

  update(id: number, updates: Partial<LabRequest>): void {
    const idx = this.data.requests.findIndex(r => r.id === id);
    if (idx !== -1) {
      this.data.requests[idx] = { ...this.data.requests[idx], ...updates };
    }
  }

  delete(id: number): void {
    this.data.requests = this.data.requests.filter(r => r.id !== id);
  }

  /** Заменяет локальную запись (по её клиентскому id) на серверную версию с присвоенными id/номерами. */
  replaceLocalRequest(clientId: number, server: LabRequest): void {
    const idx = this.data.requests.findIndex(r => r.id === clientId);
    if (idx !== -1) {
      this.data.requests[idx] = { ...server, sync_status: 'synced' };
    }
  }

  /** Удаляет дубликаты по id, оставляя самую свежую запись. */
  dedupe(): number {
    const seen = new Map<number, number>();
    const keep: LabRequest[] = [];
    let removed = 0;
    for (const r of this.data.requests) {
      const existing = seen.get(r.id);
      if (existing === undefined) {
        seen.set(r.id, keep.length);
        keep.push(r);
        continue;
      }
      const prev = keep[existing];
      if (this.compareTime(r.updated_at, prev.updated_at) >= 0) {
        keep[existing] = r;
      }
      removed++;
    }
    this.data.requests = keep;
    return removed;
  }

  /** Слияние заявок с сервера (канон). Сервер авторитетен при равном/новом updated_at. */
  mergeRequestsFromServer(serverRequests: LabRequest[]): void {
    for (const s of serverRequests) {
      const local = this.getById(s.id);
      if (!local) {
        this.add({ ...s, sync_status: 'synced' });
        continue;
      }
      if (this.compareTime(s.updated_at, local.updated_at) >= 0) {
        this.data.requests[this.data.requests.indexOf(local)] = { ...s, sync_status: 'synced' };
      }
    }
  }

  /** Заменяет справочники/проекты/группы слепком с сервера (они каноничны целиком). */
  replaceReferenceData(pull: Pick<RequestsDbData, 'projects' | 'groups' | 'labs' | 'methods' | 'objects'>): void {
    this.data.projects = Array.isArray(pull.projects) ? pull.projects : this.data.projects;
    this.data.groups = Array.isArray(pull.groups) ? pull.groups : this.data.groups;
    this.data.labs = Array.isArray(pull.labs) ? pull.labs : this.data.labs;
    this.data.methods = Array.isArray(pull.methods) ? pull.methods : this.data.methods;
    this.data.objects = Array.isArray(pull.objects) ? pull.objects : this.data.objects;
  }

  private compareTime(a: string, b: string): number {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta === tb ? 0 : ta > tb ? 1 : -1;
  }
}