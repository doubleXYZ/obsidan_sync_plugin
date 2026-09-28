import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import YandexDiskSyncPlugin from "../main";
import { extractOAuthToken, normalizeRemotePath } from "../utils";

export class YandexSyncSettingsTab extends PluginSettingTab {
	public constructor(app: App, private readonly plugin: YandexDiskSyncPlugin) {
		super(app, plugin);
	}

	public display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Синхронизация с Yandex.Disk" });
		containerEl.createEl("p", {
			text: "Плагин рассчитан на Android и использует только API Obsidian. Он синхронизирует файлы внутри отдельной папки этого OAuth-приложения на Yandex.Disk.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Шаг 1. Зарегистрировать приложение")
			.setDesc("Откройте страницу Яндекс OAuth, создайте приложение и выберите право «Доступ к папке приложения на Диске».")
			.addButton((button) =>
				button.setButtonText("Открыть регистрацию").onClick(() => {
					window.open("https://oauth.yandex.ru/client/new", "_blank");
				}),
			);

		new Setting(containerEl)
			.setName("Шаг 2. Client ID OAuth-приложения")
			.setDesc("Публичный идентификатор приложения. Для этой версии выберите право «Доступ к папке приложения на Диске» (cloud_api:disk.app_folder).")
			.addText((text) =>
				text
					.setPlaceholder("Идентификатор приложения")
					.setValue(this.plugin.settings.oauthClientId)
					.onChange(async (value) => {
						this.plugin.settings.oauthClientId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Получить токен")
			.setDesc("Откроется страница Яндекса. После подтверждения скопируйте access_token или весь URL результата — плагин извлечёт токен сам.")
			.addButton((button) =>
				button.setButtonText("Открыть Яндекс OAuth").onClick(() => {
					const clientId = this.plugin.settings.oauthClientId.trim();
					if (!clientId) {
						new Notice("Сначала укажите Client ID OAuth-приложения.");
						return;
					}
					window.open(
						`https://oauth.yandex.ru/authorize?response_type=token&client_id=${encodeURIComponent(clientId)}`,
						"_blank",
					);
				}),
			);

		new Setting(containerEl)
			.setName("OAuth-токен Yandex.Disk")
			.setDesc("Секрет доступа. Вставьте access_token либо весь URL результата OAuth. Client secret сюда не вводится и для Android-плагина не нужен.")
			.addText((text) => {
				text.inputEl.type = "password";
				return text
					.setPlaceholder("access_token")
					.setValue(this.plugin.settings.yandexToken)
					.onChange(async (value) => {
						this.plugin.settings.yandexToken = extractOAuthToken(value);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Папка на Yandex.Disk")
			.setDesc("Подпапка внутри папки приложения. Укажите app:/ObsidianVault. Доступа к остальному Диску у плагина нет.")
			.addText((text) =>
				text
					.setPlaceholder("app:/ObsidianVault")
					.setValue(this.plugin.settings.remotePath)
					.onChange(async (value) => {
						this.plugin.settings.remotePath = normalizeRemotePath(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Исключения")
			.setDesc("Имена или шаблоны через запятую. Папки указывайте со слешем в конце: .obsidian/, .trash/, .git/.")
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.excludePatterns.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split(",")
							.map((item) => item.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Максимальный размер файла, МБ")
			.setDesc("На Android крупные передачи могут расходовать много памяти. Файлы сверх лимита пропускаются и при загрузке, и при скачивании.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxFileSizeMB))
					.onChange(async (value) => {
						const size = Number(value);
						if (Number.isFinite(size) && size > 0) {
							this.plugin.settings.maxFileSizeMB = size;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Стратегия при конфликтах")
			.setDesc("Если файл изменился на обеих сторонах: «Новее выигрывает» — по дате изменения; «Локальная»/«Удалённая» — всегда приоритет одной стороны.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("newer-wins", "Новее выигрывает")
					.addOption("local-wins", "Всегда локальная версия")
					.addOption("remote-wins", "Всегда удалённая версия")
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy = value as typeof this.plugin.settings.conflictStrategy;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Сбросить состояние синхронизации")
			.setDesc("Удалить кэш метаданных (sync-state.json). Следующая синхронизация сравнит все файлы заново. Файлы не удаляются.")
			.addButton((button) =>
				button.setButtonText("Сбросить").onClick(async () => {
					await this.plugin.resetSyncState();
					new Notice("Состояние синхронизации сброшено.");
				}),
			);

		new Setting(containerEl)
			.setName("Проверить подключение")
			.setDesc("Проверяет токен и доступ к папке приложения без изменения файлов. Требуется cloud_api:disk.app_folder.")
			.addButton((button) =>
				button.setButtonText("Проверить").onClick(async () => {
					button.setDisabled(true).setButtonText("Проверка…");
					try {
						await this.plugin.checkConnection();
						new Notice("Подключение к Yandex.Disk успешно проверено.");
					} catch (error) {
						new Notice(`Не удалось подключиться: ${this.plugin.errorMessage(error)}`);
					} finally {
						button.setDisabled(false).setButtonText("Проверить");
					}
				}),
			);

		if (this.plugin.settings.lastSync) {
			const summary = this.plugin.settings.lastSync;
			const directionLabel =
				summary.direction === "push" ? "загрузка" : summary.direction === "pull" ? "скачивание" : "синхронизация";
			const statParts: string[] = [];
			if (summary.uploaded) {
				statParts.push(`загружено ↑${summary.uploaded}`);
			}
			if (summary.downloaded) {
				statParts.push(`скачано ↓${summary.downloaded}`);
			}
			if (summary.renamed) {
				statParts.push(`переименовано ⇄${summary.renamed}`);
			}
			if (summary.deleted) {
				statParts.push(`удалено 🗑${summary.deleted}`);
			}
			statParts.push(`пропущено ${summary.filesSkipped}`);
			containerEl.createEl("h3", { text: "Последняя синхронизация" });
			containerEl.createEl("p", {
				text: `${new Date(summary.timestamp).toLocaleString("ru-RU")}: ${directionLabel}. ${statParts.join(", ")}.`,
			});
		}
	}
}