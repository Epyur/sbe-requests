import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SbeRequestsPlugin from '../main';

export class RequestsSettingsTab extends PluginSettingTab {
  plugin: SbeRequestsPlugin;

  constructor(app: App, plugin: SbeRequestsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setHeading()
      .setName('Сервер');

    new Setting(containerEl)
      .setName('Адрес сервера (apiUrl)')
      .setDesc('База URL lab-service, например https://epyur.fvds.ru. JWT берётся из ЦУП СБЕ — отдельный токен не нужен.')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setHeading()
      .setName('Права доступа');

    const permsDiv = containerEl.createDiv({ cls: 'tn-req-meta' });
    permsDiv.setText('Загрузка…');
    void this.renderPermissions(permsDiv);
  }

  /** Вкладка «Права доступа»: только admin/superadmin может просматривать и менять роли.
   * Роль superadmin (выше admin, см. lab-service/AGENTS.md) относится к тому же
   * общему `lab_permissions` — сервер сам не даст назначить/снять superadmin никому
   * кроме действующего superadmin, здесь только не блокируем панель по точному
   * сравнению строки. */
  private async renderPermissions(container: HTMLElement): Promise<void> {
    const roleLabels: Record<string, string> = {
      viewer: 'Просмотр',
      editor: 'Редактор',
      admin: 'Администратор',
      superadmin: 'Супер-администратор',
    };
    try {
      const me = await this.plugin.syncService.getMyPermission();
      if (!me.hasAccess) {
        container.setText('Нет доступа к серверу. Запросите ключ в ЦУП и получите доступ у администратора.');
        return;
      }
      if (me.role !== 'admin' && me.role !== 'superadmin') {
        container.setText(`Ваша роль: ${roleLabels[me.role] || me.role}. Только администратор может управлять правами.`);
        return;
      }
      container.empty();

      // Общий доступ
      const commonDiv = container.createDiv({ cls: 'tn-req-mb8' });
      const commonLabel = commonDiv.createDiv({ cls: 'tn-req-meta', text: 'Общий доступ (для всех, кому не назначена роль):' });
      const commonSelect = commonDiv.createEl('select', { cls: 'tn-req-select' });
      commonSelect.createEl('option', { value: '', text: 'Нет общего доступа' });
      commonSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
      commonSelect.createEl('option', { value: 'editor', text: 'Редактор' });
      commonSelect.value = await this.plugin.syncService.getCommonAccess();
      commonSelect.addEventListener('change', async () => {
        try {
          await this.plugin.syncService.setCommonAccess(commonSelect.value);
          new Notice('Общий доступ обновлён');
        } catch (e: unknown) {
          new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      commonDiv.appendChild(commonLabel);
      commonDiv.appendChild(commonSelect);

      const perms = await this.plugin.syncService.listPermissions();
      const table = container.createEl('table', { cls: 'tn-table' });
      const thead = table.createEl('thead');
      const hr = thead.createEl('tr');
      hr.createEl('th').setText('Email');
      hr.createEl('th').setText('Роль');
      hr.createEl('th').setText('Действия');
      const tbody = table.createEl('tbody');
      for (const p of perms) {
        const row = tbody.createEl('tr');
        row.createEl('td').setText(p.email);
        const roleCell = row.createEl('td');
        const isOwner = p.email === me.email;
        if (isOwner) {
          roleCell.setText(`${roleLabels[p.role] || p.role} (это вы)`);
        } else {
          const roleSelect = roleCell.createEl('select', { cls: 'tn-req-select' });
          roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
          roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
          roleSelect.createEl('option', { value: 'admin', text: 'Администратор' });
          if (me.role === 'superadmin') {
            roleSelect.createEl('option', { value: 'superadmin', text: 'Супер-администратор' });
          }
          roleSelect.value = p.role;
          roleSelect.addEventListener('change', async () => {
            try {
              await this.plugin.syncService.setPermission(p.email, roleSelect.value);
              new Notice(`Роль ${p.email} обновлена`);
            } catch (e: unknown) {
              new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
        const actionsCell = row.createEl('td');
        if (!isOwner) {
          const removeBtn = actionsCell.createEl('button', { text: '✖ Убрать', cls: 'tn-btn tn-btn-ghost' });
          removeBtn.addEventListener('click', async () => {
            try {
              await this.plugin.syncService.setPermission(p.email, '');
              new Notice(`Доступ ${p.email} отозван`);
              container.empty();
              container.setText('Загрузка…');
              void this.renderPermissions(container);
            } catch (e: unknown) {
              new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
      }
      const addRow = tbody.createEl('tr');
      const emailCell = addRow.createEl('td');
      const emailInput = emailCell.createEl('input', { attr: { type: 'text', placeholder: 'email@tn.ru' }, cls: 'tn-req-input' });
      const roleCell = addRow.createEl('td');
      const roleSelect = roleCell.createEl('select', { cls: 'tn-req-select' });
      roleSelect.createEl('option', { value: 'viewer', text: 'Просмотр' });
      roleSelect.createEl('option', { value: 'editor', text: 'Редактор' });
      roleSelect.createEl('option', { value: 'admin', text: 'Администратор' });
      if (me.role === 'superadmin') {
        roleSelect.createEl('option', { value: 'superadmin', text: 'Супер-администратор' });
      }
      const actionCell = addRow.createEl('td');
      const addBtn = actionCell.createEl('button', { text: '➕ Добавить', cls: 'tn-btn tn-btn-primary' });
      addBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        if (!email) { new Notice('Введите email'); return; }
        try {
          await this.plugin.syncService.setPermission(email, roleSelect.value);
          new Notice(`Доступ выдан: ${email}`);
          container.empty();
          container.setText('Загрузка…');
          void this.renderPermissions(container);
        } catch (e: unknown) {
          new Notice(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    } catch (e: unknown) {
      container.setText(`Не удалось загрузить права: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}