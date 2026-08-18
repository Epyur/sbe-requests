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
      }
    } catch (e: unknown) {
      console.error('Заявки: не удалось прочитать БД:', errorMessage(e));
    }
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