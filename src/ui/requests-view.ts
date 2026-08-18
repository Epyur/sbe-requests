import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeRequestsPlugin from '../main';
import type { LabProject, LabRequest, RequestMethod } from '../types/requests';
import { getService } from '../../../sbe-core/src/bridge';
import { errorMessage } from '../../../sbe-core/src/utils/errors';

export const SBE_REQUESTS_VIEW_TYPE = 'sbe-requests-view';

const STATUS_LABELS: Record<string, string> = {
  new: '🟢 Новая',
  processing: '🟡 В работе',
  completed: '✅ Завершена',
};

export class RequestsView extends ItemView {
  plugin: SbeRequestsPlugin;
  private containerElContent!: HTMLElement;
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
    return 'Заявки на испытания';
  }

  getIcon(): string {
    return 'clipboard-list';
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.addClass('tn-req-container');
    this.containerElContent = container.createDiv();
    try {
      const me = await this.plugin.syncService.getMyPermission();
      this.myRole = me.hasAccess ? me.role : '';
      this.myEmail = me.email;
    } catch (e: unknown) {
      console.warn('Заявки: не удалось получить роль:', errorMessage(e));
      this.myRole = '';
      this.myEmail = '';
    }
    await this.syncAndRender();
  }

  /** Роль editor/admin — можно создавать/редактировать заявки и справочники. */
  private get canEdit(): boolean {
    return this.myRole === 'editor' || this.myRole === 'admin';
  }

  private get isAdmin(): boolean {
    return this.myRole === 'admin';
  }

  refresh(): void {
    this.renderView();
  }

  private renderView(): void {
    const container = this.containerElContent;
    container.empty();

    const header = container.createDiv({ cls: 'tn-req-header' });
    header.createEl('h3', { text: '📋 Заявки на испытания' });
    if (this.canEdit) {
      const createBtn = header.createEl('button', { text: '➕ Новая заявка', cls: 'tn-btn tn-btn-primary' });
      createBtn.addEventListener('click', () => this.showCreateForm());
    }
    const groupsBtn = header.createEl('button', { text: '👥 Группы', cls: 'tn-btn tn-btn-ghost' });
    groupsBtn.addEventListener('click', () => this.renderGroupsView());
    const refBtn = header.createEl('button', { text: '📚 Справочники', cls: 'tn-btn tn-btn-ghost' });
    refBtn.addEventListener('click', () => this.renderReferencesView());
    const syncBtn = header.createEl('button', { text: '🔄', cls: 'tn-btn tn-btn-ghost' });
    syncBtn.addEventListener('click', () => { void this.syncAndRender(); });

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

    const layout = container.createDiv({ cls: 'tn-req-layout' });

    // Дерево проектов (левая колонка)
    const treeDiv = layout.createDiv({ cls: 'tn-req-tree' });
    const treeTitle = treeDiv.createDiv({ cls: 'tn-req-tree-title' });
    treeTitle.setText('Проекты');
    if (this.canEdit) {
      const addProject = treeTitle.createEl('button', { text: '＋', cls: 'tn-btn tn-btn-ghost tn-req-btn-sm' });
      addProject.addEventListener('click', () => this.showCreateProjectForm());
    }
    this.renderProjectTree(treeDiv);

    // Список заявок (правая колонка)
    const listDiv = layout.createDiv({ cls: 'tn-req-list' });
    const requests = this.filteredRequests();
    if (requests.length === 0) {
      const empty = listDiv.createDiv({ cls: 'tn-req-meta tn-req-p24' });
      empty.setText('Нет заявок. Нажмите «➕ Новая заявка», чтобы создать.');
      return;
    }

    const table = listDiv.createEl('table', { cls: 'tn-table' });
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    const headers = ['Номер заявки', 'Объект', 'Статус', 'Обновлено'];
    for (const h of headers) headerRow.createEl('th').setText(h);

    const tbody = table.createEl('tbody');
    requests.sort((a, b) => (b.number_year - a.number_year) || (b.number_seq - a.number_seq));
    for (const r of requests) {
      const row = tbody.createEl('tr', { cls: 'tn-req-row' });
      row.addEventListener('click', () => this.renderRequestDetail(r));

      const numCell = row.createEl('td');
      const firstMethod = r.methods && r.methods.length > 0 ? r.methods[0] : null;
      numCell.setText(firstMethod?.customer_number || '—');
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
      if (depth > 0) row.style.paddingLeft = `${8 + depth * 14}px`;
      row.setText(label);
      if (this.selectedProjectId === projectId) row.addClass('tn-req-tree-selected');
      row.addEventListener('click', () => {
        this.selectedProjectId = projectId;
        this.renderView();
      });
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
    const container = this.containerElContent;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    container.createEl('h3', { text: this.objectName(req.object_id) || req.title });

    const meta = container.createDiv({ cls: 'tn-req-meta tn-req-mb12' });
    meta.createDiv({ text: `№ ${req.number_seq}/${req.number_year}` });
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

    if (req.methods && req.methods.length > 0) {
      const methodsDiv = container.createDiv({ cls: 'tn-req-mb12' });
      methodsDiv.createDiv({ cls: 'tn-req-meta', text: 'Методы испытаний:' });
      const mTable = methodsDiv.createEl('table', { cls: 'tn-table' });
      const mThead = mTable.createEl('thead');
      const mHr = mThead.createEl('tr');
      mHr.createEl('th').setText('Метод');
      mHr.createEl('th').setText('Номер заказчику');
      mHr.createEl('th').setText('Номер лаборатории');
      const mTbody = mTable.createEl('tbody');
      for (const m of req.methods) {
        const row = mTbody.createEl('tr');
        row.createEl('td').setText(this.methodName(m.method_id));
        row.createEl('td').setText(m.customer_number || '—');
        row.createEl('td').setText(m.lab_number || '—');
      }

      const indicators = this.indicatorsForMethods(req.methods.map(m => m.method_id));
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
    const m = this.plugin.requestsDb.getMethods().find(md => md.id === methodId);
    return m ? `${m.code}${m.name ? ' — ' + m.name : ''}` : `#${methodId}`;
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
    const container = this.containerElContent;
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

    // Методы (чекбоксы, сгруппированы по лабораториям)
    const methodsLabel = container.createEl('label', { text: 'Методы испытаний', cls: 'tn-req-label' });
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
    const selected = new Set(existing ? existing.methods.map(m => m.method_id) : []);
    for (const [labId, list] of methodsByLab) {
      const lab = labById.get(labId);
      const labDiv = methodsDiv.createDiv({ cls: 'tn-req-meta tn-req-mb4' });
      labDiv.setText(`🏢 ${lab ? `${lab.code} — ${lab.name}` : `Лаборатория #${labId}`}`);
      for (const m of list) {
        const wrapper = methodsDiv.createEl('label', { cls: 'tn-req-filter-label' });
        const cb = wrapper.createEl('input', { attr: { type: 'checkbox', value: String(m.id) }, cls: 'tn-req-cb' });
        cb.checked = selected.has(m.id);
        cb.addEventListener('change', () => this.updateIndicators(methodsDiv, indicatorsDiv));
        wrapper.createEl('span').setText(` ${m.code} — ${m.name}`);
      }
    }

    // Определяемые показатели (из выбранных методов)
    const indicatorsLabel = container.createEl('label', { text: 'Определяемые показатели', cls: 'tn-req-label' });
    const indicatorsDiv = container.createDiv({ cls: 'tn-req-methods tn-req-mb12' });
    this.updateIndicators(methodsDiv, indicatorsDiv);

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
          existing.methods = methodIds.map(mid => {
            const prev = existing.methods.find(m => m.method_id === mid);
            return prev ? { ...prev } : { method_id: mid, customer_number: '', lab_number: '' };
          });
          existing.sync_status = 'local';
          existing.updated_at = now;
          this.plugin.requestsDb.update(existing.id, existing);
          await this.plugin.requestsDb.save();
          new Notice('Заявка обновлена (будет отправлена при синхронизации)');
          this.renderRequestDetail(existing);
        } else {
          const newReq: LabRequest = {
            id: Date.now() + Math.floor(Math.random() * 1000),
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
            methods: methodIds.map(mid => ({ method_id: mid, customer_number: '', lab_number: '' })),
            files: [],
            created_at: now,
            updated_at: now,
            sync_status: 'local',
          };
          this.plugin.requestsDb.add(newReq);
          await this.plugin.requestsDb.save();
          new Notice('Заявка создана (будет отправлена при синхронизации)');
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
  private updateIndicators(methodsDiv: HTMLElement, indicatorsDiv: HTMLElement): void {
    const checked = Array.from(methodsDiv.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
      .map(cb => Number(cb.value));
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
    const container = this.containerElContent;
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

  // ---- Группы ----

  private renderGroupsView(): void {
    const container = this.containerElContent;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    const header = container.createDiv({ cls: 'tn-req-header' });
    header.createEl('h3', { text: '👥 Группы' });
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
    const container = this.containerElContent;
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
    const container = this.containerElContent;
    container.empty();

    const backBtn = container.createEl('button', { text: '← Назад', cls: 'tn-btn tn-btn-ghost' });
    backBtn.addEventListener('click', () => this.renderView());

    const header = container.createDiv({ cls: 'tn-req-header' });
    header.createEl('h3', { text: '📚 Справочники' });

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
    const container = this.containerElContent;
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
      this.renderView();
    } catch (e: unknown) {
      new Notice(`Заявки: синхронизация не выполнена — ${errorMessage(e)}`);
      this.renderView();
    }
  }
}

export type { RequestMethod };