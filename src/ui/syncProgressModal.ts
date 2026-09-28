import { App, Modal } from "obsidian";
import { SyncProgress } from "../types";
import { formatFileSize } from "../utils";

export class SyncProgressModal extends Modal {
	private statusEl!: HTMLElement;
	private detailsEl!: HTMLElement;
	private progressBarEl!: HTMLElement;
	private actionButtonEl!: HTMLButtonElement;
	private cancelHandler: (() => void) | null = null;
	private closedByUser = false;
	private latestProgress: SyncProgress | null = null;
	private finished = false;

	public constructor(app: App, directionLabel: string) {
		super(app);
		this.setTitle(`${directionLabel} — Yandex.Disk`);
	}

	public onOpen(): void {
		this.contentEl.empty();
		this.statusEl = this.contentEl.createEl("p", { text: "Подготовка синхронизации…", cls: "yandex-sync-status" });
		const progressContainer = this.contentEl.createDiv({ cls: "yandex-sync-progress" });
		this.progressBarEl = progressContainer.createDiv({ cls: "yandex-sync-progress-bar" });
		this.detailsEl = this.contentEl.createEl("p", { cls: "yandex-sync-details" });

		this.actionButtonEl = this.contentEl.createEl("button", { text: "Отменить", cls: "mod-warning" });
		this.actionButtonEl.addEventListener("click", () => {
			if (this.finished) {
				this.close();
				return;
			}
			this.actionButtonEl.disabled = true;
			this.actionButtonEl.setText("Отмена…");
			this.cancelHandler?.();
		});

		if (this.latestProgress) {
			this.renderProgress(this.latestProgress);
		}
	}

	public setCancelHandler(handler: () => void): void {
		this.cancelHandler = handler;
	}

	public reopen(): void {
		if (this.closedByUser) {
			this.closedByUser = false;
			this.open();
		}
	}

	public update(progress: SyncProgress): void {
		this.latestProgress = progress;
		if (!this.statusEl) {
			return;
		}
		this.renderProgress(progress);
	}

	private renderProgress(progress: SyncProgress): void {
		const percentage = progress.total === 0 ? 0 : Math.round((progress.current / progress.total) * 100);
		this.progressBarEl.style.width = `${percentage}%`;
		if (progress.status === "error") {
			this.statusEl.setText("Ошибка синхронизации");
		} else if (progress.status === "cancelled") {
			this.statusEl.setText(`Операция отменена: ${progress.current} из ${progress.total} файлов`);
		} else if (progress.status === "completed") {
			this.statusEl.setText(`Готово: ${progress.current} из ${progress.total} файлов`);
		} else if (progress.total === 0 && progress.currentFileName) {
			this.statusEl.setText(progress.currentFileName);
		} else {
			this.statusEl.setText(`${progress.current} из ${progress.total} файлов (${percentage}%)`);
		}
		if (progress.status === "error") {
			this.detailsEl.setText(progress.message ?? "Неизвестная ошибка");
		} else if (progress.currentFileName) {
			this.detailsEl.setText(
				`${progress.currentFileName} · ${formatFileSize(progress.currentFileSize)} · всего ${formatFileSize(progress.completedBytes)} из ${formatFileSize(progress.totalBytes)}`,
			);
		} else {
			this.detailsEl.setText(progress.message ?? "");
		}

		if (progress.status === "completed" || progress.status === "cancelled" || progress.status === "error") {
			this.finished = true;
			this.actionButtonEl.disabled = false;
			this.actionButtonEl.setText("Закрыть");
			this.actionButtonEl.removeClass("mod-warning");
		}
	}

	public onClose(): void {
		this.closedByUser = true;
		this.contentEl.empty();
	}
}
