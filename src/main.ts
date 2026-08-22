import { Plugin, WorkspaceLeaf } from 'obsidian';
import { RequestsDatabase } from './database/requests-db';
import { RequestsSyncService } from './services/sync.service';
import { RequestsView, SBE_REQUESTS_VIEW_TYPE } from './ui/requests-view';
import { RequestsSettingsTab } from './ui/settings-tab';
import { getService, publishService, unpublishService } from '../../sbe-core/src/bridge';
import { errorMessage } from '../../sbe-core/src/utils/errors';
import type { SbeRequestsApi } from '../../sbe-core/src/types';

export interface SbeRequestsSettings {
  apiUrl: string;
  /** Последняя версия, о которой опубликована новость в ЦУП (2026-08-22,
   * см. announceUpdate ниже) — не даёт публиковать новость на каждый запуск. */
  lastAnnouncedVersion?: string;
}

const DEFAULT_SETTINGS: SbeRequestsSettings = {
  apiUrl: 'https://epyur.fvds.ru',
};

export default class SbeRequestsPlugin extends Plugin {
  settings!: SbeRequestsSettings;
  requestsDb!: RequestsDatabase;
  syncService!: RequestsSyncService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.requestsDb = new RequestsDatabase(this.app);
    await this.requestsDb.init();
    this.syncService = new RequestsSyncService(this.requestsDb, () => this.settings.apiUrl);

    this.registerView(
      SBE_REQUESTS_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new RequestsView(leaf, this),
    );

    this.addSettingTab(new RequestsSettingsTab(this.app, this));

    publishService<SbeRequestsApi>('sbe-requests', {
      open: async () => {
        await this.activateView();
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });

    if (this.settings.lastAnnouncedVersion !== this.manifest.version) {
      void this.announceUpdateSafely(
        'В карточке заявки теперь показываются результаты испытания — по смысловым разделам, ' +
        'как в ЛИМС. Раньше результаты здесь вообще не отображались.',
      );
    }
  }

  onunload(): void {
    unpublishService('sbe-requests');
  }

  /** Публикует в ЦУП («Новости») сообщение об обновлении плагина — один раз на
   * версию (см. правило в корневом AGENTS.md, добавлено 2026-08-22). Никогда
   * не должно мешать загрузке плагина, если ЦУП недоступен. */
  private async announceUpdateSafely(summary: string): Promise<void> {
    try {
      const apstore = await getService('sbe-apstore');
      await apstore.announceUpdate({
        appId: this.manifest.id,
        appName: this.manifest.name,
        version: this.manifest.version,
        summary,
      });
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn(`${this.manifest.name}: не удалось опубликовать новость об обновлении:`, errorMessage(e));
    }
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<SbeRequestsSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SBE_REQUESTS_VIEW_TYPE)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: SBE_REQUESTS_VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }
}