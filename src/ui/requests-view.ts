import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type SbeRequestsPlugin from '../main';
import type { LabProject, LabRequest } from '../types/requests';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';
import { REQUESTS_HELP_MD, REQUESTS_HELP_PATH } from './help';

export const SBE_REQUESTS_VIEW_TYPE = 'sbe-requests-view';

const STATUS_LABELS: Record<string, string> = {
  new: '🟢 Новая',
  received: '🔵 Принята',
  processing: '🟡 В работе',
  completed: '✅ Завершена',
};

/** Ключи разделов дерева навигации (фасад, как в sbe-lims). */
type NavKey = 'requests' | 'groups' | 'references';

interface NavItem {
  key: NavKey;
  label: string;
  sub: string;
}

interface NavGroup {
  id: string;
  icon: string;
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'req',
    icon: '📋',
    label: 'Заявки',
    items: [
      { key: 'requests', label: 'Все заявки', sub: 'Доступные вам заявки' },
    ],
  },
  {
    id: 'ctl',
    icon: '⚙️',
    label: 'Управление',
    items: [
      { key: 'groups', label: 'Группы', sub: 'Группы участников' },
      { key: 'references', label: 'Справочники', sub: 'Лаборатории, методы, объекты' },
    ],
  },
];

const PAGE_META: Record<NavKey, { title: string; sub: string }> = {
  requests: { title: 'Все заявки', sub: 'Доступные вам заявки' },
  groups: { title: 'Группы', sub: 'Группы участников и видимость заявок' },
  references: { title: 'Справочники', sub: 'Лаборатории, методы испытаний, объекты исследования' },
};

export class RequestsView extends ItemView {
  plugin: SbeRequestsPlugin;
  private containerElContent!: HTMLElement;
  private bodyEl!: HTMLElement;
  private navEl!: HTMLElement;
  private pageTitleEl!: HTMLElement;
  private pageSubEl!: HTMLElement;
  private crumbEl!: HTMLElement;
  private collapseLabel!: HTMLElement;
  private projectsEl!: HTMLElement;
  private key: NavKey = 'requests';
  private collapsed = false;
  private searchQuery = '';
  private searchTimeout: number | null = null;
  /** null — фильтр выключен (все заявки); 0 — только «Без проекта»; >0 — конкретный проект. */
  private selectedProjectId: number | null = null;
  private myRole = '';
  private myEmail = '';

  constructor(leaf: WorkspaceLeaf, plugin: SbeRequestsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SBE_REQUESTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'LogicLAB.Заявки';
  }

  getIcon(): string {
    return 'clipboard-list';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-req-container');
    this.containerElContent = container.createDiv({ cls: 'tn-req-app' });

    try {
      const me = await this.plugin.syncService.getMyPermission();
      this.myRole = me.hasAccess ? me.role : '';
      this.myEmail = me.email;
    } catch (e: unknown) {
      console.warn('Заявки: не удалось получить роль:', errorMessage(e));
      this.myRole = '';
      this.myEmail = '';
    }
    this.buildShell();
    this.syncNavActive();
    await this.renderPage();
  }

  refresh(): void {
    void this.renderPage();
  }

  // ---- Каркас ----

  private buildShell(): void {
    // шапка
    const topbar = this.containerElContent.createDiv({ cls: 'tn-req-topbar' });
    topbar.createDiv({ cls: 'tn-req-module-title', text: 'LogicLAB.Заявки' });
    this.crumbEl = topbar.createDiv({ cls: 'tn-req-crumb' });
    const spacer = topbar.createDiv({ cls: 'tn-req-spacer' });
    spacer.empty();
    if (this.canEdit) {
      const createBtn = topbar.createEl('button', { text: '＋ Создать', cls: 'tn-req-create' });
      createBtn.addEventListener('click', () => this.showCreateForm());
    }

    // главная область: сайдбар + контент
    const main = this.containerElContent.createDiv({ cls: 'tn-req-main' });

    const sidebar = main.createDiv({ cls: 'tn-req-sidebar' });

    // сворачивание
    const collapseBtn = sidebar.createDiv({ cls: 'tn-req-collapse' });
    collapseBtn.createSpan({ text: '▧' });
    this.collapseLabel = collapseBtn.createSpan({ cls: 'tn-req-collapse-lbl', text: 'Свернуть' });
    collapseBtn.addEventListener('click', () => this.toggleCollapse());

    // дерево навигации
    this.navEl = sidebar.createDiv({ cls: 'tn-req-nav' });
    this.buildNav();
    this.renderSidebarProjects();

    // панель управления: синхронизация и справка
    const actions = sidebar.createDiv({ cls: 'tn-req-sidebar-actions' });
    const syncBtn = actions.createEl('button', { cls: 'tn-req-nav-action' });
    syncBtn.createSpan({ text: '🔄' });
    syncBtn.createSpan({ cls: 'tn-req-nav-lbl', text: 'Синхронизация' });
    syncBtn.addEventListener('click', () => { void this.syncAndRender(); });
    const helpBtn = actions.createEl('button', { cls: 'tn-req-nav-action' });
    helpBtn.createSpan({ text: '?' });
    helpBtn.createSpan({ cls: 'tn-req-nav-lbl', text: 'Справка' });
    helpBtn.setAttr('title', 'Инструкция по заполнению заявок');
    helpBtn.addEventListener('click', () => { void this.openHelp(); });

    const content = main.createDiv({ cls: 'tn-req-content' });
    this.pageTitleEl = content.createEl('h1', { cls: 'tn-req-page-title' });
    this.pageSubEl = content.createDiv({ cls: 'tn-req-page-sub' });
    this.bodyEl = content.createDiv();
  }

  private buildNav(): void {
    this.navEl.empty();
    for (const group of NAV_GROUPS) {
      const grpBtn = this.navEl.createEl('button', { cls: 'tn-req-grp' });
      grpBtn.createSpan({ cls: 'tn-req-grp-ico', text: group.icon });
      grpBtn.createSpan({ cls: 'tn-req-grp-lbl', text: group.label });
      grpBtn.createSpan({ cls: 'tn-req-grp-chev', text: '▶' });
      grpBtn.addEventListener('click', () => {
        grpBtn.classList.toggle('open');
        grpBtn.classList.toggle('active');
      });

      const submenu = this.navEl.createDiv({ cls: 'tn-req-submenu' });
      for (const item of group.items) {
        const a = submenu.createEl('a', { cls: 'tn-req-nav-item', attr: { href: '#' } });
        a.createSpan({ cls: 'tn-req-nav-lbl', text: item.label });
        a.dataset.key = item.key;
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          this.key = item.key;
          this.syncNavActive();
          void this.renderPage();
        });
      }
    }

    const firstGroup = this.navEl.querySelector('.tn-req-grp');
    if (firstGroup) {
      firstGroup.classList.add('open', 'active');
    }
    this.syncNavActive();
  }

  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.containerElContent.classList.toggle('collapsed', this.collapsed);
    if (this.collapseLabel) {
      this.collapseLabel.setText(this.collapsed ? 'Развернуть' : 'Свернуть');
    }
  }

  private syncNavActive(): void {
    this.navEl.querySelectorAll('.tn-req-nav-item').forEach((el) => {
      const navEl = el as HTMLElement;
      navEl.classList.toggle('active', navEl.dataset.key === this.key);
    });
  }

  /** Дерево проектов в сайдбаре (под навигацией). */
  private renderSidebarProjects(): void {
    this.projectsEl = this.navEl.createDiv({ cls: 'tn-req-projects' });
    this.rerenderSidebar();
  }

  private rerenderSidebar(): void {
    if (!this.projectsEl) return;
    this.projectsEl.empty();
    const projectsTitle = this.projectsEl.createDiv({ cls: 'tn-req-projects-title' });
    projectsTitle.createEl('span', { text: 'Проекты' });
    if (this.canEdit) {
      const addProject = projectsTitle.createEl('button', { text: '＋', cls: 'tn-btn tn-btn-ghost tn-req-btn-sm' });
      addProject.addEventListener('click', () => this.showCreateProjectForm());
    }
    this.renderProjectTree(this.projectsEl);
  }

  // ---- Страница ----

  private async renderPage(): Promise<void> {
    const meta = PAGE_META[this.key];
    this.crumbEl.setText(meta.title);
    this.pageTitleEl.setText(meta.title);
    this.pageSubEl.setText(meta.sub);

    this.bodyEl.empty();
    if (this.key === 'requests') {
      this.renderView();
    } else if (this.key === 'groups') {
      this.renderGroupsView();
    } else {
      this.renderReferencesView();
    }
  }

  /** Роль editor/admin — можно создавать/редактировать заявки и справочники. */
  private get canEdit(): boolean {
    return this.myRole === 'editor' || this.myRole === 'admin';
  }

  private get isAdmin(): boolean {
    return this.myRole === 'admin';
  }

  private renderView(): void {
    const container = this.bodyEl;
    container.empty();

    const searchInput = container.createEl('input', {
      attr: { type: 'text', placeholder: '🔍 Поиск по названию...' },
      cls: 'tn-req-input tn-req-mb8',
    });
    searchInput.value = this.searchQuery;
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (this.searchTimeout) window.clearTimeout(this.searchTimeout);
      this.searchTimeout = window.setTimeout(() => this.renderView(), 400);
    });

    // Список заявок
    const listDiv = container.createDiv({ cls: 'tn-req-list' });
    const requests = this.filteredRequests();
    if (requests.length === 0) {
      const empty = listDiv.createDiv({ cls: 'tn-req-meta tn-req-p24' });
      empty.setText('Нет заявок. Нажмите «＋ Создать», чтобы создать.');
      return;
    }

    const table = listDiv.createEl('table', { cls: 'tn-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const headers = ['Номер заявки', 'Метод', 'Объект', 'Статус', 'Обновлено'];
    for (const h of headers) headerRow.createEl('th').setText(h);

    const tbody = table.createEl('tbody');
    requests.sort((a, b) => (b.number_year - a.number_year) || (b.number_seq - a.number_seq));
    for (const r of requests) {
      const row = tbody.createEl('tr', { cls: 'tn-req-row' });
      row.addEventListener('click', () => this.renderRequestDetail(r));

      const numCell = row.createEl('td');
      numCell.setText(r.customer_number || '—');
      row.createEl('td').setText(this.methodName(r.method_id));
      row.createEl('td').setText(this.objectName(r.object_id));
      row.createEl('td').setText(STATUS_LABELS[r.status] || r.status);
      row.createEl('td').setText(this.formatDate(r.updated_at));
    }
  }

  /** Дерево проектов: «Без проекта» + корневые проекты (рекурсивно). */
  private renderProjectTree(container: HTMLElement): void {
    const projects = this.plugin.requestsDb.getProjects();
    const childrenOf = new Map<number, LabProject[]>();
    const roots: LabProject[] = [];
    for (const p of projects) {
      if (p.parent_id > 0) {
        const list = childrenOf.get(p.parent_id) || [];
        list.push(p);
        childrenOf.set(p.parent_id, list);
      } else {
        roots.push(p);
      }
    }
    const sortByName = (list: LabProject[]): LabProject[] =>
      [...list].sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code));
    for (const p of sortByName(roots)) childrenOf.set(p.id, sortByName(childrenOf.get(p.id) || []));

    const item = (label: string, projectId: number, depth: number, isRoot: boolean): void => {
      const row = container.createDiv({ cls: 'tn-req-tree-item' });
      if (depth > 0) row.dataset.depth = String(depth);
      row.createEl('span', { text: label });
      if (this.selectedProjectId === projectId) row.addClass('tn-req-tree-selected');
      row.addEventListener('click', () => {
        this.selectedProjectId = projectId;
        this.key = 'requests';
        this.syncNavActive();
        this.rerenderSidebar();
        void this.renderPage();
      });
      if (projectId > 0 && this.canEdit) {
        const proj = this.plugin.requestsDb.getProjects().find(p => p.id === projectId);
        if (proj && (proj.owner_email === this.myEmail || this.isAdmin)) {
          const editBtn = row.createEl('button', { text: '✎', cls: 'tn-btn tn-btn-ghost tn-req-btn-sm tn-req-tree-edit' });
          editBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.showEditProjectForm(proj);
          });
        }
      }
    };

    item('🗂 Без проекта', 0, 0, true);
    for (const root of roots) {
      item(`${root.code}${root.name ? ' — ' + root.name : ''}`, root.id, 0, true);
      this.renderSubtree(childrenOf, root.id, 1, item);
    }
  }

  private renderSubtree(
    childrenOf: Map<number, LabProject[]>,
    parentId: number,
    depth: number,
    item: (label: string, projectId: number, depth: number, isRoot: boolean) => void,
  ): void {
    const kids = childrenOf.get(parentId) || [];
    for (const k of kids) {
      item(`${k.code}${k.name ? ' — ' + k.name : ''}`, k.id, depth, false);
      this.renderSubtree(childrenOf, k.id, depth + 1, item);
    }
  }

  private filteredRequests(): LabRequest[] {
    let requests = this.plugin.requestsDb.getAll();
    const q = this.searchQuery.trim().toLowerCase();
    if (q) requests = requests.filter(r =>
      r.title.toLowerCase().includes(q) || this.objectName(r.object_id).toLowerCase().includes(q));
    if (this.selectedProjectId === 0) {
      requests = requests.filter(r => r.project_id <= 0);
    } else if (this.selectedProjectId !== null) {
      requests = requests.filter(r => r.project_id === this.selectedProjectId);
    }
    return requests;
  }

  private objectName(objectId: number): string {
    const obj = this.plugin.requestsDb.getObjects().find(o => o.id === objectId);
    return obj ? obj.name : '—';
  }

  private projectName(projectId: number): string {
    if (projectId <= 0) return 'Без проекта';
    const p = this.plugin.requestsDb.getProjects().find(pr => pr.id === projectId);
    return p ? `${p.code}${p.name ? ' — ' + p.name : ''}` : '—';
  }

  /** Группа проекта (0 — публичный/не задана). */
  private projectGroupId(projectId: number): number {
    const p = this.plugin.requestsDb.getProjects().find(pr => pr.id === projectId);
    return p ? (p.group_id || 0) : 0;
  }

  private groupName(groupId: number): string {
    if (groupId <= 0) return 'Без группы';
    const g = this.plugin.requestsDb.getGroups().find(gr => gr.id === groupId);
    return g ? g.name : '—';
  }

  private formatDate(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }

  // ---- Карточка заявки ----

  private renderRequestDetail(req: LabRequest): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: this.objectName(req.object_id) || req.title });

    const meta = container.createDiv({ cls: 'tn-req-meta tn-req-mb12' });
    meta.createDiv({ text: `№ ${this.requestNumber(req)}` });
    meta.createDiv({ text: `📁 Проект: ${this.projectName(req.project_id)}` });
    meta.createDiv({ text: `👥 Группа: ${this.groupName(req.group_id)}` });
    meta.createDiv({ text: `🔬 Объект: ${this.objectName(req.object_id)}` });
    if (req.ekn) meta.createDiv({ text: `🔢 ЕКН: ${req.ekn}` });
    const obj = this.plugin.requestsDb.getObjects().find(o => o.id === req.object_id);
    const chars = obj?.characteristics;
    if (chars) {
      if (chars.batch_number !== undefined) meta.createDiv({ text: `📦 Номер партии: ${chars.batch_number}` });
      if (chars.sample_id) meta.createDiv({ text: `🏷 Идентификатор образца: ${chars.sample_id}` });
    }
    meta.createDiv({ text: `⚡ Приоритет: ${this.priorityLabel(req.priority)}` });
    if (req.test_purpose) meta.createDiv({ text: `🎯 Цель испытания: ${this.purposeLabel(req.test_purpose)}` });
    if (req.external_lab_id > 0) meta.createDiv({ text: `🏭 Внешняя лаборатория: ${this.labName(req.external_lab_id)}` });
    meta.createDiv({ text: `👤 Владелец: ${req.owner_email || '—'}` });
    meta.createDiv({ text: `📅 Создана: ${this.formatDate(req.created_at)}` });
    meta.createDiv({ text: `📅 Обновлена: ${this.formatDate(req.updated_at)}` });
    const statusDiv = meta.createDiv();
    statusDiv.setText(`Статус: ${STATUS_LABELS[req.status] || req.status}`);

    if (req.description) {
      container.createDiv({ cls: 'tn-req-meta tn-req-mb12' }).createDiv({ text: `📝 ${req.description}` });
    }

    if (req.method_id > 0) {
      const methodsDiv = container.createDiv({ cls: 'tn-req-mb12' });
      methodsDiv.createDiv({ cls: 'tn-req-meta tn-req-mb4', text: `🔬 Метод испытаний: ${this.methodName(req.method_id)}` });
      const mTable = methodsDiv.createEl('table', { cls: 'tn-table' });
      const mThead = mTable.createEl('thead');
      const mHr = mThead.createEl('tr');
      mHr.createEl('th').setText('Номер заказчику');
      mHr.createEl('th').setText('Номер лаборатории');
      const mTbody = mTable.createEl('tbody');
      const mRow = mTbody.createEl('tr');
      mRow.createEl('td').setText(req.customer_number || '—');
      mRow.createEl('td').setText(req.lab_number || '—');

      const indicators = this.indicatorsForMethods([req.method_id]);
      if (indicators.length > 0) {
        const indDiv = methodsDiv.createDiv({ cls: 'tn-req-meta tn-req-mt8' });
        indDiv.setText(`Определяемые показатели: ${indicators.join(', ')}`);
      }
    }

    if (req.files && req.files.length > 0) {
      const filesDiv = container.createDiv({ cls: 'tn-req-mb12' });
      filesDiv.createDiv({ cls: 'tn-req-meta', text: `Файлы (${req.files.length}):` });
      for (const f of req.files) {
        const row = filesDiv.createEl('div', { cls: 'tn-req-meta' });
        row.createEl('a', { href: f.file_url, attr: { target: '_blank' } }).setText(`📎 ${f.file_name}`);
      }
    }

    if (this.canEdit) {
      const fileLabel = container.createEl('label', { text: 'Прикрепить файл', cls: 'tn-req-label' });
      fileLabel.addClass('tn-req-mb8');
      const fileInput = container.createEl('input', { attr: { type: 'file' }, cls: 'tn-req-mb8' });
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        try {
          const buf = await file.arrayBuffer();
          const res = await this.plugin.syncService.uploadFile(buf, file.name, req.id);
          req.files.push({ file_key: res.file_key, file_name: res.file_name, file_size: res.file_size, file_url: res.file_url });
          req.sync_status = 'local';
          req.updated_at = new Date().toISOString();
          await this.plugin.requestsDb.save();
          new Notice('Файл загружен');
          this.renderRequestDetail(req);
        } catch (e: unknown) {
          new Notice(`Ошибка загрузки файла: ${errorMessage(e)}`);
        }
      });
    }

    const btnRow = container.createDiv({ cls: 'tn-req-header tn-req-mt12' });

    if (this.canEdit) {
      const statusSelect = btnRow.createEl('select', { cls: 'tn-req-select tn-req-status-select' });
      statusSelect.createEl('option', { value: 'new', text: '🟢 Новая' });
      statusSelect.createEl('option', { value: 'received', text: '🔵 Принята' });
      statusSelect.createEl('option', { value: 'processing', text: '🟡 В работе' });
      statusSelect.createEl('option', { value: 'completed', text: '✅ Завершена' });
      statusSelect.value = req.status;
      statusSelect.addEventListener('change', async () => {
        try {
          await this.plugin.syncService.setRequestStatus(req.id, statusSelect.value);
          req.status = statusSelect.value;
          await this.plugin.requestsDb.save();
          new Notice('Статус обновлён');
          this.renderRequestDetail(req);
        } catch (e: unknown) {
          new Notice(`Ошибка: ${errorMessage(e)}`);
          statusSelect.value = req.status;
        }
      });

      const editBtn = btnRow.createEl('button', { text: '✏️ Редактировать', cls: 'tn-btn tn-btn-ghost' });
      editBtn.addEventListener('click', () => this.showEditForm(req));
    }
  }

  private methodName(methodId: number): string {
    if (!methodId || methodId <= 0) return '—';
    const m = this.plugin.requestsDb.getMethods().find(md => md.id === methodId);
    return m ? `${m.code}${m.name ? ' — ' + m.name : ''}` : `#${methodId}`;
  }

  /** Номер заявки для отображения. У черновика-под-заявки (number_seq = 0,
   * есть parent_id) показывается номер родителя, чей NNN она разделит. */
  private requestNumber(req: LabRequest): string {
    if (req.number_seq > 0) return `${req.number_seq}/${req.number_year}`;
    if (req.parent_id) {
      const parent = this.plugin.requestsDb.getById(req.parent_id);
      if (parent && parent.number_seq > 0) return `${parent.number_seq}/${parent.number_year}`;
    }
    return '—';
  }

  private projectCode(projectId: number): string {
    if (projectId <= 0) return '0';
    const p = this.plugin.requestsDb.getProjects().find(pr => pr.id === projectId);
    return p ? p.code : '0';
  }

  /** Превью номеров под-заявки (как сервер buildNumbers): тот же NNN, что у родителя,
   * но код нового метода. Нужно, чтобы в таблице черновик сразу показывал номера. */
  private buildDraftNumbers(req: LabRequest): { customer: string; lab: string } | null {
    if (!req.parent_id) return null;
    const parent = this.plugin.requestsDb.getById(req.parent_id);
    if (!parent || parent.number_seq <= 0) return null;
    const m = this.plugin.requestsDb.getMethods().find(md => md.id === req.method_id);
    if (!m) return null;
    const l = this.plugin.requestsDb.getLabs().find(lb => lb.id === m.lab_id);
    const labCode = l ? l.code : '';
    const seq = parent.number_seq;
    const year = parent.number_year;
    return {
      customer: `${this.projectCode(req.project_id)}-${seq}/${year}-${labCode}-${m.code}`,
      lab: `${seq}/${year}-${m.code}`,
    };
  }

  private priorityLabel(priority: string): string {
    switch (priority) {
      case 'critical': return 'Критичный';
      case 'blocker': return 'Блокер (остановить исполнение других заявок)';
      case 'normal': return 'Средний';
      default: return priority || 'Средний';
    }
  }

  private purposeLabel(purpose: string): string {
    switch (purpose) {
      case 'quality_control': return 'Текущий контроль';
      case 'rnd': return 'НИОКР';
      case 'certification': return 'Сертификация';
      case 'declaration': return 'Декларирование';
      default: return purpose || '—';
    }
  }

  private labName(labId: number): string {
    const l = this.plugin.requestsDb.getLabs().find(lb => lb.id === labId);
    return l ? `${l.code}${l.name ? ' — ' + l.name : ''}` : `#${labId}`;
  }

  /** Объединение определяемых показателей выбранных методов (уникальные). */
  private indicatorsForMethods(methodIds: number[]): string[] {
    const methods = this.plugin.requestsDb.getMethods();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of methodIds) {
      const m = methods.find(md => md.id === id);
      if (m && Array.isArray(m.determinable_indicators)) {
        for (const ind of m.determinable_indicators) {
          if (ind && !seen.has(ind)) {
            seen.add(ind);
            out.push(ind);
          }
        }
      }
    }
    return out;
  }

  // ---- Форма создания/редактирования заявки ----

  private showCreateForm(): void {
    this.showRequestForm(null);
  }

  private showEditForm(req: LabRequest): void {
    this.showRequestForm(req);
  }

  private showRequestForm(existing: LabRequest | null): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => existing ? this.renderRequestDetail(existing) : this.renderView());

    container.createEl('h3', { text: existing ? `✏️ Редактировать: ${this.objectName(existing.object_id) || existing.title}` : '✉️ Новая заявка' });

    const descLabel = container.createEl('label', { text: 'Описание', cls: 'tn-req-label' });
    const descInput = container.createEl('textarea', { cls: 'tn-req-textarea' });
    if (existing) descInput.value = existing.description;

    // Приоритет
    const priorityLabel = container.createEl('label', { text: 'Приоритет', cls: 'tn-req-label' });
    const prioritySelect = container.createEl('select', { cls: 'tn-req-select' });
    prioritySelect.createEl('option', { value: 'normal', text: 'Средний' });
    prioritySelect.createEl('option', { value: 'critical', text: 'Критичный' });
    prioritySelect.createEl('option', { value: 'blocker', text: 'Блокер (остановить исполнение других заявок)' });
    prioritySelect.value = existing ? existing.priority : 'normal';

    // Цель испытания
    const purposeLabel = container.createEl('label', { text: 'Цель испытания', cls: 'tn-req-label' });
    const purposeSelect = container.createEl('select', { cls: 'tn-req-select' });
    purposeSelect.createEl('option', { value: 'quality_control', text: 'Текущий контроль' });
    purposeSelect.createEl('option', { value: 'rnd', text: 'НИОКР' });
    purposeSelect.createEl('option', { value: 'certification', text: 'Сертификация' });
    purposeSelect.createEl('option', { value: 'declaration', text: 'Декларирование' });
    purposeSelect.value = existing && existing.test_purpose ? existing.test_purpose : 'quality_control';

    // Внешняя лаборатория
    const externalLabLabel = container.createEl('label', { cls: 'tn-req-filter-label tn-req-mb4' });
    const externalLabCb = externalLabLabel.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-req-cb' });
    externalLabLabel.createEl('span').setText(' Провести испытания во внешней лаборатории');
    const externalLabs = this.plugin.requestsDb.getLabs().filter(l => l.type === 'external');
    const externalLabSelect = container.createEl('select', { cls: 'tn-req-select tn-req-mb8' });
    externalLabSelect.createEl('option', { value: '0', text: '— Выберите внешнюю лабораторию —' });
    for (const l of externalLabs) {
      externalLabSelect.createEl('option', { value: String(l.id), text: `${l.code}${l.name ? ' — ' + l.name : ''}` });
    }
    externalLabSelect.hide();
    const existingExternal = existing ? existing.external_lab_id : 0;
    if (existingExternal > 0) {
      externalLabCb.checked = true;
      externalLabSelect.show();
      externalLabSelect.value = String(existingExternal);
    }
    externalLabCb.addEventListener('change', () => {
      if (externalLabCb.checked) externalLabSelect.show();
      else {
        externalLabSelect.hide();
        externalLabSelect.value = '0';
      }
    });

    // Объект исследования: ЕКН или экспериментальный образец
    const objectSection = container.createDiv({ cls: 'tn-req-object-section' });
    objectSection.createEl('h4', { text: '🔬 Объект исследования' });

    const eknLabel = objectSection.createEl('label', { text: 'ЕКН (серийная продукция)', cls: 'tn-req-label' });
    const eknInput = objectSection.createEl('input', { attr: { type: 'text', placeholder: 'Номер ЕКН (например, 068863). Оставьте пустым для экспериментального образца.' }, cls: 'tn-req-input' });
    const eknHints = objectSection.createDiv({ cls: 'tn-req-ekn-hints' });
    const eknSnapshot = objectSection.createDiv({ cls: 'tn-req-ekn-snapshot tn-req-meta tn-req-mb8' });

    const batchLabel = objectSection.createEl('label', { text: 'Номер партии (обязателен при ЕКН)', cls: 'tn-req-label' });
    const batchInput = objectSection.createEl('input', { attr: { type: 'number', min: '0', step: '1' }, cls: 'tn-req-input tn-req-mb8' });

    // Если по ЕКН нет данных в ПИМ — заказчик заполняет название и целевые характеристики сам
    const eknManualLabel = objectSection.createEl('label', { text: 'Данные по ЕКН не найдены в справочнике. Укажите название и целевые характеристики материала:', cls: 'tn-req-label tn-req-mb4' });
    const eknManualDiv = objectSection.createDiv();
    const eknNameLabel = eknManualDiv.createEl('label', { text: 'Название материала', cls: 'tn-req-label' });
    const eknNameInput = eknManualDiv.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });
    const eknTargetLabel = eknManualDiv.createEl('label', { text: 'Целевые характеристики', cls: 'tn-req-label' });
    const eknTargetInput = eknManualDiv.createEl('textarea', { cls: 'tn-req-textarea tn-req-mb8' });

    const expLabel = objectSection.createEl('label', { text: 'Экспериментальный образец (без ЕКН)', cls: 'tn-req-label tn-req-mb4' });
    const expDiv = objectSection.createDiv();
    const expNameLabel = expDiv.createEl('label', { text: 'Название материала', cls: 'tn-req-label' });
    const expNameInput = expDiv.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });
    const expTypeLabel = expDiv.createEl('label', { text: 'Тип объекта', cls: 'tn-req-label' });
    const expTypeSelect = expDiv.createEl('select', { cls: 'tn-req-select' });
    expTypeSelect.createEl('option', { value: 'series', text: 'Серийный выпуск' });
    expTypeSelect.createEl('option', { value: 'experimental', text: 'Экспериментальный продукт' });
    const expThickLabel = expDiv.createEl('label', { text: 'Толщина образца, мм', cls: 'tn-req-label' });
    const expThickInput = expDiv.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });
    const expIdLabel = expDiv.createEl('label', { text: 'Идентификатор образца', cls: 'tn-req-label' });
    const expIdInput = expDiv.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });
    const expTargetLabel = expDiv.createEl('label', { text: 'Целевой показатель', cls: 'tn-req-label' });
    const expTargetInput = expDiv.createEl('textarea', { cls: 'tn-req-textarea' });

    // Объект из существующей заявки
    const existingObj = existing ? this.plugin.requestsDb.getObjects().find(o => o.id === existing.object_id) : null;
    const existingChars = existingObj?.characteristics || {};

    // Наполнение из существующей заявки
    const existingIsEkn = !!existingChars.ekn || !!existing?.ekn;
    if (existingIsEkn) {
      eknInput.value = existing?.ekn || existingChars.ekn || '';
      if (existingChars.batch_number !== undefined) batchInput.value = String(existingChars.batch_number);
      expDiv.hide();
      const snap = existingChars.ekn_snapshot;
      if (snap && snap.name) {
        eknSnapshot.setText(`📄 ${snap.name}${snap.thickness ? ' · ' + snap.thickness : ''}${snap.sto_number ? ' · ' + snap.sto_number : ''}`);
        eknManualLabel.hide();
        eknManualDiv.hide();
      } else {
        eknSnapshot.setText('Данные по ЕКН не загружены из справочника');
        if (existingObj) eknNameInput.value = existingObj.name;
        if (existingChars.target_indicator) eknTargetInput.value = existingChars.target_indicator;
        eknManualLabel.show();
        eknManualDiv.show();
      }
    } else {
      if (existingObj) expNameInput.value = existingObj.name;
      expTypeSelect.value = existingChars.sample_type || 'experimental';
      if (existingChars.thickness_mm) expThickInput.value = existingChars.thickness_mm;
      if (existingChars.sample_id) expIdInput.value = existingChars.sample_id;
      if (existingChars.target_indicator) expTargetInput.value = existingChars.target_indicator;
      batchLabel.hide();
      batchInput.hide();
      eknManualLabel.hide();
      eknManualDiv.hide();
    }

    // Поиск ЕКН через sbe-ekn (подсказки)
    let eknTimer: number | null = null;
    eknInput.addEventListener('input', () => {
      const q = eknInput.value.trim();
      eknHints.empty();
      eknSnapshot.setText('');
      if (q) {
        expDiv.hide();
        batchLabel.show();
        batchInput.show();
      } else {
        expDiv.show();
        batchLabel.hide();
        batchInput.hide();
      }
      if (eknTimer) window.clearTimeout(eknTimer);
      eknTimer = window.setTimeout(() => {
        if (!q) return;
        void this.searchEkn(q, eknHints, (product) => {
          eknInput.value = product.ekn;
          eknHints.empty();
          eknSnapshot.setText(`📄 ${product.name}${product.thickness ? ' · ' + product.thickness : ''}${product.sto_number ? ' · ' + product.sto_number : ''}`);
          expDiv.hide();
          batchLabel.show();
          batchInput.show();
          eknManualLabel.hide();
          eknManualDiv.hide();
          new Notice(`ЕКН ${product.ekn}: данные материала загружены из справочника`);
        });
      }, 400);
    });

    // Проект
    const projectLabel = container.createEl('label', { text: 'Проект', cls: 'tn-req-label' });
    const projectSelect = container.createEl('select', { cls: 'tn-req-select' });
    const projectList = this.plugin.requestsDb.getProjects();
    projectSelect.createEl('option', { value: '0', text: '— Без проекта —' });
    for (const p of projectList) {
      projectSelect.createEl('option', { value: String(p.id), text: `${p.code}${p.name ? ' — ' + p.name : ''}` });
    }
    if (existing) projectSelect.value = String(existing.project_id);
    else if (this.selectedProjectId !== null && this.selectedProjectId > 0) projectSelect.value = String(this.selectedProjectId);

    // Группа
    const groupLabel = container.createEl('label', { text: 'Группа (видимость)', cls: 'tn-req-label' });
    const groupSelect = container.createEl('select', { cls: 'tn-req-select' });
    groupSelect.createEl('option', { value: '0', text: '— Без группы —' });
    for (const g of this.plugin.requestsDb.getGroups()) {
      groupSelect.createEl('option', { value: String(g.id), text: g.name });
    }
    if (existing) groupSelect.value = String(existing.group_id);
    else {
      // Новая заявка: подставляем группу выбранного проекта, если она задана.
      const autoGroupId = this.projectGroupId(Number(projectSelect.value));
      if (autoGroupId > 0) groupSelect.value = String(autoGroupId);
      projectSelect.addEventListener('change', () => {
        const gid = this.projectGroupId(Number(projectSelect.value));
        if (gid > 0) groupSelect.value = String(gid);
      });
    }

    // Методы (чекбоксы, сгруппированы по лабораториям)
    const methodsLabel = container.createEl('label', { text: existing ? 'Метод испытаний (текущий)' : 'Методы испытаний', cls: 'tn-req-label' });
    const methodsDiv = container.createDiv({ cls: 'tn-req-methods tn-req-mb12' });
    const methods = this.plugin.requestsDb.getMethods();
    const labs = this.plugin.requestsDb.getLabs();
    const labById = new Map(labs.map(l => [l.id, l]));
    const methodsByLab = new Map<number, typeof methods>();
    for (const m of methods) {
      const key = m.lab_id;
      const list = methodsByLab.get(key) || [];
      list.push(m);
      methodsByLab.set(key, list);
    }
    const selected = new Set(existing ? [existing.method_id] : []);
    // Добавление методов доступно только к заявке в статусе «Новая» с присвоенным номером.
    const canAdd = !!(existing && existing.status === 'new' && existing.number_seq > 0);
    const usedMethodIds = new Set<number>();
    if (existing && existing.number_seq > 0) {
      for (const r of this.plugin.requestsDb.getAll()) {
        if (r.number_seq === existing.number_seq && r.number_year === existing.number_year && r.method_id > 0) {
          usedMethodIds.add(r.method_id);
        }
      }
    }
    for (const [labId, list] of methodsByLab) {
      const lab = labById.get(labId);
      const labDiv = methodsDiv.createDiv({ cls: 'tn-req-meta tn-req-mb4' });
      labDiv.setText(`🏢 ${lab ? `${lab.code} — ${lab.name}` : `Лаборатория #${labId}`}`);
      for (const m of list) {
        const wrapper = methodsDiv.createEl('label', { cls: 'tn-req-filter-label' });
        const cb = wrapper.createEl('input', { attr: { type: 'checkbox', value: String(m.id) }, cls: 'tn-req-cb' });
        cb.checked = selected.has(m.id);
        if (existing) {
          // Метод заявки фиксирован: 1 заявка = 1 метод (меняется только созданием новой заявки).
          cb.disabled = true;
        }
        cb.addEventListener('change', () => this.updateIndicators(methodsDiv, addDiv, indicatorsDiv));
        wrapper.createEl('span').setText(` ${m.code} — ${m.name}`);
      }
    }

    // Добавление методов к существующей заявке: каждая добавленная под-заявка
    // получает тот же номер (NNN), но новый метод (сервер переиспользует NNN).
    const addLabel = container.createEl('label', { text: '➕ Добавить методы (создаст под-заявки с тем же номером)', cls: 'tn-req-label' });
    const addDiv = container.createDiv({ cls: 'tn-req-methods tn-req-mb12' });
    if (canAdd) {
      const addable = methods.filter(m => !usedMethodIds.has(m.id));
      if (addable.length === 0) {
        addDiv.createDiv({ cls: 'tn-req-meta' }).setText('Все методы уже добавлены к этой заявке');
      }
      for (const m of addable) {
        const wrapper = addDiv.createEl('label', { cls: 'tn-req-filter-label' });
        const cb = wrapper.createEl('input', { attr: { type: 'checkbox', value: String(m.id) }, cls: 'tn-req-cb' });
        cb.addEventListener('change', () => this.updateIndicators(methodsDiv, addDiv, indicatorsDiv));
        wrapper.createEl('span').setText(` ${m.code} — ${m.name}`);
      }
    } else {
      addLabel.hide();
      addDiv.hide();
    }

    // Определяемые показатели (из выбранных методов)
    const indicatorsLabel = container.createEl('label', { text: 'Определяемые показатели', cls: 'tn-req-label' });
    const indicatorsDiv = container.createDiv({ cls: 'tn-req-methods tn-req-mb12' });
    this.updateIndicators(methodsDiv, addDiv, indicatorsDiv);

    const btnRow = container.createDiv({ cls: 'tn-req-header tn-req-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => existing ? this.renderRequestDetail(existing) : this.renderView());

    saveBtn.addEventListener('click', async () => {
      const ekn = eknInput.value.trim();
      const isEknMode = !!ekn;

      // Собираем характеристики объекта исследования
      let objectId = 0;
      let objectName = '';
      if (isEknMode) {
        const batchStr = batchInput.value.trim();
        if (!batchStr || !/^\d+$/.test(batchStr)) {
          new Notice('Введите номер партии (целое число) — обязателен при ЕКН');
          return;
        }
        const snapshot = await this.plugin.syncService.getEknProduct(ekn);
        const manualName = eknNameInput.value.trim();
        if (!snapshot) {
          if (!manualName) {
            new Notice('Данные по ЕКН не найдены в справочнике. Укажите название материала и целевые характеристики.');
            return;
          }
          objectName = manualName;
          if (!eknTargetInput.value.trim()) {
            new Notice('Укажите целевые характеристики материала');
            return;
          }
        } else {
          objectName = snapshot.name || `ЕКН ${ekn}`;
        }
        const characteristics: Record<string, unknown> = {
          ekn,
          batch_number: Number(batchStr),
          sample_type: 'series',
        };
        if (snapshot) characteristics.ekn_snapshot = snapshot;
        if (manualName) characteristics.name_manual = manualName;
        if (eknTargetInput.value.trim()) characteristics.target_indicator = eknTargetInput.value.trim();
        objectId = await this.plugin.syncService.createObject(objectName, '', characteristics);
      } else {
        const expName = expNameInput.value.trim();
        if (!expName) { new Notice('Введите название материала (или укажите ЕКН)'); return; }
        const sampleId = expIdInput.value.trim();
        if (!sampleId) { new Notice('Введите идентификатор образца'); return; }
        objectName = expName;
        const characteristics: Record<string, unknown> = {
          sample_id: sampleId,
          sample_type: expTypeSelect.value,
        };
        if (expThickInput.value.trim()) characteristics.thickness_mm = expThickInput.value.trim();
        if (expTargetInput.value.trim()) characteristics.target_indicator = expTargetInput.value.trim();
        objectId = await this.plugin.syncService.createObject(objectName, '', characteristics);
      }
      if (objectId <= 0) { new Notice('Не удалось создать объект исследования'); return; }

      const methodIds = Array.from(methodsDiv.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
        .map(cb => Number(cb.value)).filter(v => v > 0);
      if (methodIds.length === 0) { new Notice('Выберите хотя бы один метод'); return; }

      const priority = prioritySelect.value || 'normal';
      const testPurpose = purposeSelect.value || '';
      const externalLabId = externalLabCb.checked ? Number(externalLabSelect.value) || 0 : 0;

      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      cancelBtn.setAttr('disabled', 'true');

      try {
        const now = new Date().toISOString();
        if (existing) {
          existing.title = objectName;
          existing.description = descInput.value.trim();
          existing.object_id = objectId;
          existing.project_id = Number(projectSelect.value);
          existing.group_id = Number(groupSelect.value);
          existing.priority = priority;
          existing.test_purpose = testPurpose;
          existing.external_lab_id = externalLabId;
          existing.ekn = isEknMode ? ekn : '';
          existing.sync_status = 'local';
          existing.updated_at = now;
          this.plugin.requestsDb.update(existing.id, existing);

          // Добавление методов: каждая под-заявка наследует поля и получает тот же NNN
          // (сервер переиспользует номер родителя, пока он в статусе new).
          const addedIds = Array.from(methodsDiv.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked:not(:disabled)'))
            .map(cb => Number(cb.value)).filter(v => v > 0);
          let addedCount = 0;
          if (addedIds.length > 0) {
            addedIds.forEach((mid, i) => {
              const draft: LabRequest = {
                id: -(Date.now() + i),
                number_seq: 0,
                number_year: 0,
                parent_id: existing.id,
                title: objectName,
                description: descInput.value.trim(),
                object_id: objectId,
                project_id: Number(projectSelect.value),
                group_id: Number(groupSelect.value),
                owner_email: this.myEmail,
                status: 'new',
                priority,
                test_purpose: testPurpose,
                external_lab_id: externalLabId,
                ekn: isEknMode ? ekn : '',
                method_id: mid,
                customer_number: '',
                lab_number: '',
                files: [],
                created_at: now,
                updated_at: now,
                sync_status: 'local',
              };
              const nums = this.buildDraftNumbers(draft);
              if (nums) {
                draft.customer_number = nums.customer;
                draft.lab_number = nums.lab;
              }
              this.plugin.requestsDb.add(draft);
              addedCount++;
            });
          }
          await this.plugin.requestsDb.save();
          new Notice(addedCount > 0
            ? `Заявка обновлена; добавлено под-заявок по методам: ${addedCount} (отправятся при синхронизации)`
            : 'Заявка обновлена (будет отправлена при синхронизации)');
          this.renderRequestDetail(existing);
        } else {
          // Один запрос → N под-заявок с общим group_key (сервер выделит один NNN группе).
          const groupKey = String(Date.now()) + '-' + Math.floor(Math.random() * 1000);
          const base: Partial<LabRequest> = {
            number_seq: 0,
            number_year: 0,
            title: objectName,
            description: descInput.value.trim(),
            object_id: objectId,
            project_id: Number(projectSelect.value),
            group_id: Number(groupSelect.value),
            owner_email: this.myEmail,
            status: 'new',
            priority,
            test_purpose: testPurpose,
            external_lab_id: externalLabId,
            ekn: isEknMode ? ekn : '',
            files: [],
            created_at: now,
            updated_at: now,
            sync_status: 'local',
          };
          methodIds.forEach((mid, i) => {
            const newReq: LabRequest = {
              ...(base as LabRequest),
              id: i === 0 ? Date.now() + Math.floor(Math.random() * 1000) : -(Date.now() + i),
              method_id: mid,
              customer_number: '',
              lab_number: '',
              group_key: methodIds.length > 1 ? groupKey : undefined,
            };
            this.plugin.requestsDb.add(newReq);
          });
          await this.plugin.requestsDb.save();
          new Notice(methodIds.length > 1
            ? `Заявка создана как ${methodIds.length} под-заявки (по методу), будут отправлены при синхронизации`
            : 'Заявка создана (будет отправлена при синхронизации)');
          this.renderView();
        }
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Сохранить');
        saveBtn.removeAttribute('disabled');
        cancelBtn.removeAttribute('disabled');
      }
    });
  }

  /** Поиск ЕКН через sbe-ekn: подсказки, выбор карточки. */
  private async searchEkn(
    query: string,
    hintsEl: HTMLElement,
    onPick: (product: { ekn: string; name: string; thickness: string; sto_number: string; sto_name: string }) => void,
  ): Promise<void> {
    try {
      const eknService = await getService('sbe-ekn');
      const results = await eknService.search(query);
      hintsEl.empty();
      for (const r of results.slice(0, 8)) {
        const item = hintsEl.createDiv({ cls: 'tn-req-ekn-hint' });
        item.createDiv({ cls: 'tn-req-ekn-hint-code' }).setText(r.ekn);
        item.createDiv({ cls: 'tn-req-meta' }).setText(r.name || '—');
        item.addEventListener('click', () => {
          onPick({ ekn: r.ekn, name: r.name, thickness: r.thickness, sto_number: r.sto_number, sto_name: r.sto_name });
        });
      }
    } catch (e: unknown) {
      console.warn('Заявки: не удалось найти ЕКН в sbe-ekn:', errorMessage(e));
    }
  }

  /** Перерисовывает чекбоксы определяемых показателей по выбранным методам. */
  private updateIndicators(methodsDiv: HTMLElement, addDiv: HTMLElement, indicatorsDiv: HTMLElement): void {
    const checked: number[] = [];
    for (const src of [methodsDiv, addDiv]) {
      for (const cb of Array.from(src.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))) {
        checked.push(Number(cb.value));
      }
    }
    const indicators = this.indicatorsForMethods(checked);
    indicatorsDiv.empty();
    if (indicators.length === 0) {
      indicatorsDiv.createDiv({ cls: 'tn-req-meta' }).setText('Показатели появятся после выбора методов');
      return;
    }
    for (const ind of indicators) {
      const wrapper = indicatorsDiv.createEl('label', { cls: 'tn-req-filter-label' });
      const cb = wrapper.createEl('input', { attr: { type: 'checkbox', value: ind }, cls: 'tn-req-cb' });
      cb.checked = true;
      wrapper.createEl('span').setText(` ${ind}`);
    }
  }

  // ---- Форма создания проекта ----

  private showCreateProjectForm(): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: '📁 Новый проект' });

    const parentLabel = container.createEl('label', { text: 'Родительский проект (для подпроекта)', cls: 'tn-req-label' });
    const parentSelect = container.createEl('select', { cls: 'tn-req-select' });
    parentSelect.createEl('option', { value: '0', text: '— Корневой проект —' });
    for (const p of this.plugin.requestsDb.getProjects()) {
      parentSelect.createEl('option', { value: String(p.id), text: `${p.code}${p.name ? ' — ' + p.name : ''}` });
    }

    const codeLabel = container.createEl('label', { text: 'Код проекта (уникальный)', cls: 'tn-req-label' });
    const codeInput = container.createEl('input', { attr: { type: 'text', placeholder: 'Например: ЕКН-2026-001' }, cls: 'tn-req-input' });

    const nameLabel = container.createEl('label', { text: 'Название', cls: 'tn-req-label' });
    const nameInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });

    const descLabel = container.createEl('label', { text: 'Описание', cls: 'tn-req-label' });
    const descInput = container.createEl('textarea', { cls: 'tn-req-textarea' });

    const eknWrapper = container.createEl('label', { cls: 'tn-req-filter-label tn-req-mb8' });
    const eknCb = eknWrapper.createEl('input', { attr: { type: 'checkbox' }, cls: 'tn-req-cb' });
    eknWrapper.createEl('span').setText(' Проект ЕКН (серийная продукция)');

    const groupLabel = container.createEl('label', { text: 'Группа (видимость)', cls: 'tn-req-label' });
    const groupSelect = container.createEl('select', { cls: 'tn-req-select' });
    groupSelect.createEl('option', { value: '0', text: '— Публичный —' });
    for (const g of this.plugin.requestsDb.getGroups()) {
      groupSelect.createEl('option', { value: String(g.id), text: g.name });
    }

    const btnRow = container.createDiv({ cls: 'tn-req-header tn-req-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Создать проект', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderView());

    saveBtn.addEventListener('click', async () => {
      const code = codeInput.value.trim();
      if (!code) { new Notice('Введите код проекта'); return; }
      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      try {
        await this.plugin.syncService.createProject({
          parent_id: Number(parentSelect.value),
          code,
          name: nameInput.value.trim(),
          description: descInput.value.trim(),
          is_ekn: eknCb.checked,
          group_id: Number(groupSelect.value),
        });
        new Notice('Проект создан');
        await this.syncAndRender();
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Создать проект');
        saveBtn.removeAttribute('disabled');
      }
    });
  }

  private showEditProjectForm(project: LabProject): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: `📁 Проект: ${project.code}` });

    const nameLabel = container.createEl('label', { text: 'Название', cls: 'tn-req-label' });
    const nameInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });
    nameInput.value = project.name || '';

    const descLabel = container.createEl('label', { text: 'Описание', cls: 'tn-req-label' });
    const descInput = container.createEl('textarea', { cls: 'tn-req-textarea' });
    descInput.value = project.description || '';

    const codeLabel = container.createEl('label', { text: 'Код проекта (уникальный)', cls: 'tn-req-label' });
    const codeInput = container.createEl('input', { attr: { type: 'text', placeholder: 'Например: ЕКН-2026-001' }, cls: 'tn-req-input' });
    codeInput.value = project.code;

    const groupLabel = container.createEl('label', { text: 'Группа (видимость)', cls: 'tn-req-label' });
    const groupSelect = container.createEl('select', { cls: 'tn-req-select' });
    groupSelect.createEl('option', { value: '0', text: '— Публичный —' });
    for (const g of this.plugin.requestsDb.getGroups()) {
      groupSelect.createEl('option', { value: String(g.id), text: g.name });
    }
    groupSelect.value = String(project.group_id || 0);

    const btnRow = container.createDiv({ cls: 'tn-req-header tn-req-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Сохранить', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderView());

    saveBtn.addEventListener('click', async () => {
      const code = codeInput.value.trim();
      if (!code) { new Notice('Введите код проекта'); return; }
      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      try {
        await this.plugin.syncService.updateProject(project.id, {
          code,
          name: nameInput.value.trim(),
          description: descInput.value.trim(),
          group_id: Number(groupSelect.value),
        });
        new Notice('Проект обновлён');
        await this.syncAndRender();
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Сохранить');
        saveBtn.removeAttribute('disabled');
      }
    });
  }

  // ---- Группы ----

  private renderGroupsView(): void {
    const container = this.bodyEl;
    container.empty();

    const header = container.createDiv({ cls: 'tn-req-header' });
    if (this.canEdit) {
      const addBtn = header.createEl('button', { text: '➕ Создать группу', cls: 'tn-btn tn-btn-primary' });
      addBtn.addEventListener('click', () => this.showCreateGroupForm());
    }

    const groups = this.plugin.requestsDb.getGroups();
    if (groups.length === 0) {
      container.createDiv({ cls: 'tn-req-meta tn-req-p24' }).setText('Нет групп. Создайте группу, чтобы делить заявки с коллегами.');
      return;
    }

    for (const g of groups) {
      const card = container.createDiv({ cls: 'tn-req-group-card tn-req-mb12' });
      const cardHeader = card.createDiv({ cls: 'tn-req-flex tn-req-mb8' });
      cardHeader.createEl('strong', { text: g.name });
      cardHeader.createDiv({ cls: 'tn-req-meta' }).setText(`Владелец: ${g.owner_email}`);
      const isOwner = g.owner_email === this.myEmail || this.isAdmin;

      const mTable = card.createEl('table', { cls: 'tn-table' });
      const mThead = mTable.createEl('thead');
      const mHr = mThead.createEl('tr');
      mHr.createEl('th').setText('Email');
      mHr.createEl('th').setText('Роль');
      if (isOwner) mHr.createEl('th').setText('Действия');
      const mTbody = mTable.createEl('tbody');
      for (const m of g.members) {
        const row = mTbody.createEl('tr');
        row.createEl('td').setText(m.email);
        row.createEl('td').setText(m.role === 'editor' ? 'Редактор' : 'Просмотр');
        if (isOwner) {
          const actionsCell = row.createEl('td');
          const removeBtn = actionsCell.createEl('button', { text: '✖', cls: 'tn-btn tn-btn-ghost tn-req-btn-sm' });
          removeBtn.addEventListener('click', async () => {
            try {
              await this.plugin.syncService.removeGroupMember(g.id, m.email);
              new Notice(`Участник ${m.email} удалён`);
              await this.syncAndRender();
              this.renderGroupsView();
            } catch (e: unknown) {
              new Notice(`Ошибка: ${errorMessage(e)}`);
            }
          });
        }
      }

      if (isOwner) {
        const addRow = card.createDiv({ cls: 'tn-req-flex tn-req-mt8' });
        const emailInput = addRow.createEl('input', { attr: { type: 'text', placeholder: 'email@tn.ru' }, cls: 'tn-req-input tn-req-member-input' });
        const roleSelect = addRow.createEl('select', { cls: 'tn-req-select tn-req-member-select' });
        roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
        roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
        const addMemberBtn = addRow.createEl('button', { text: '➕ Добавить', cls: 'tn-btn tn-btn-primary' });
        addMemberBtn.addEventListener('click', async () => {
          const email = emailInput.value.trim();
          if (!email) { new Notice('Введите email'); return; }
          try {
            await this.plugin.syncService.addGroupMember(g.id, email, roleSelect.value);
            new Notice(`Участник ${email} добавлен`);
            await this.syncAndRender();
            this.renderGroupsView();
          } catch (e: unknown) {
            new Notice(`Ошибка: ${errorMessage(e)}`);
          }
        });
      }
    }
  }

  private showCreateGroupForm(): void {
    const container = this.bodyEl;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderGroupsView());

    container.createEl('h3', { text: '👥 Новая группа' });

    const nameLabel = container.createEl('label', { text: 'Название группы', cls: 'tn-req-label' });
    const nameInput = container.createEl('input', { attr: { type: 'text' }, cls: 'tn-req-input' });

    const btnRow = container.createDiv({ cls: 'tn-req-header tn-req-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Создать группу', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderGroupsView());

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { new Notice('Введите название группы'); return; }
      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      try {
        await this.plugin.syncService.createGroup(name);
        new Notice('Группа создана');
        await this.syncAndRender();
        this.renderGroupsView();
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Создать группу');
        saveBtn.removeAttribute('disabled');
      }
    });
  }

  // ---- Справочники ----

  private renderReferencesView(): void {
    const container = this.bodyEl;
    container.empty();

    const header = container.createDiv({ cls: 'tn-req-header' });
    if (this.canEdit) {
      const objectBtn = header.createEl('button', { text: '➕ Объект', cls: 'tn-btn tn-btn-ghost' });
      objectBtn.addEventListener('click', () => this.showCreateObjectForm());
    }

    this.renderTable(container, 'Лаборатории', 'lab', this.plugin.requestsDb.getLabs());
    this.renderTable(container, 'Методы', 'method', this.plugin.requestsDb.getMethods());
    this.renderTable(container, 'Объекты', 'object', this.plugin.requestsDb.getObjects());
  }

  private renderTable(
    container: HTMLElement,
    title: string,
    kind: 'lab' | 'method' | 'object',
    items: Array<{ id: number; code?: string; name: string; lab_id?: number; description?: string }>,
  ): void {
    const section = container.createDiv({ cls: 'tn-req-mb12' });
    section.createDiv({ cls: 'tn-req-meta tn-req-mb4' }).setText(title);
    const table = section.createEl('table', { cls: 'tn-table' });
    const thead = table.createEl('thead');
    const hr = thead.createEl('tr');
    hr.createEl('th').setText('Код');
    hr.createEl('th').setText('Название');
    if (kind === 'method') hr.createEl('th').setText('Лаборатория');
    hr.createEl('th').setText('Описание');
    const tbody = table.createEl('tbody');
    if (items.length === 0) {
      const row = tbody.createEl('tr');
      const td = row.createEl('td', { cls: 'tn-req-p24' });
      td.setAttr('colspan', kind === 'method' ? '4' : '3');
      td.setText('Пусто');
      return;
    }
    for (const it of items) {
      const row = tbody.createEl('tr');
      row.createEl('td').setText(it.code || '—');
      row.createEl('td').setText(it.name || '—');
      if (kind === 'method') {
        const lab = this.plugin.requestsDb.getLabs().find(l => l.id === it.lab_id);
        row.createEl('td').setText(lab ? lab.code : '—');
      }
      row.createEl('td').setText(it.description || '—');
    }
  }

  private showCreateObjectForm(): void {
    const container = this.bodyEl;
    container.empty();
    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderReferencesView());
    container.createEl('h3', { text: '🔬 Новый объект' });

    const nameInput = this.labeledInput(container, 'Название', '');
    const descInput = this.labeledTextarea(container, 'Описание');

    const btnRow = container.createDiv({ cls: 'tn-req-header tn-req-mt12' });
    const saveBtn = btnRow.createEl('button', { text: '💾 Создать', cls: 'tn-btn tn-btn-primary' });
    const cancelBtn = btnRow.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost' });
    cancelBtn.addEventListener('click', () => this.renderReferencesView());

    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { new Notice('Введите название объекта'); return; }
      saveBtn.setText('⏳');
      saveBtn.setAttr('disabled', 'true');
      try {
        await this.plugin.syncService.createObject(name, descInput.value.trim(), {});
        new Notice('Объект создан');
        await this.syncAndRender();
        this.renderReferencesView();
      } catch (e: unknown) {
        new Notice(`Ошибка: ${errorMessage(e)}`);
        saveBtn.setText('💾 Создать');
        saveBtn.removeAttribute('disabled');
      }
    });
  }

  private labeledInput(container: HTMLElement, label: string, placeholder: string): HTMLInputElement {
    container.createEl('label', { text: label, cls: 'tn-req-label' });
    return container.createEl('input', { attr: { type: 'text', placeholder }, cls: 'tn-req-input' });
  }

  private labeledTextarea(container: HTMLElement, label: string): HTMLTextAreaElement {
    container.createEl('label', { text: label, cls: 'tn-req-label' });
    return container.createEl('textarea', { cls: 'tn-req-textarea' });
  }

  async syncAndRender(): Promise<void> {
    try {
      await this.plugin.syncService.sync();
      this.rerenderSidebar();
      await this.renderPage();
    } catch (e: unknown) {
      new Notice(`Заявки: синхронизация не выполнена — ${errorMessage(e)}`);
      this.rerenderSidebar();
      await this.renderPage();
    }
  }

  /** Открывает справку по заполнению заявок. Если заметки нет в вольте — создаёт её. */
  private async openHelp(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      if (!(await adapter.exists(REQUESTS_HELP_PATH))) {
        await adapter.write(REQUESTS_HELP_PATH, REQUESTS_HELP_MD);
      }
      const file = this.app.vault.getAbstractFileByPath(REQUESTS_HELP_PATH);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(file);
      } else {
        new Notice('Не удалось найти файл справки');
      }
    } catch (e: unknown) {
      new Notice(`Не удалось открыть справку: ${errorMessage(e)}`);
    }
  }
}
