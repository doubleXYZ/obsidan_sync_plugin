import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
	public constructor(
		app: App,
		private readonly title: string,
		private readonly text: string,
		private readonly confirmText: string,
		private readonly onConfirm: () => void,
		private readonly onCancel?: () => void,
	) {
		super(app);
	}

	public onOpen(): void {
		this.setTitle(this.title);
		const textEl = this.contentEl.createEl("p", { cls: "yandex-sync-confirm-text" });
		textEl.setText(this.text);
		textEl.style.whiteSpace = "pre-wrap";
		const buttons = this.contentEl.createDiv({ cls: "yandex-sync-confirm-buttons" });
		buttons.createEl("button", { text: "Отмена" }).addEventListener("click", () => {
			this.close();
			this.onCancel?.();
		});
		buttons.createEl("button", { text: this.confirmText, cls: "mod-warning" }).addEventListener("click", () => {
			this.close();
			this.onConfirm();
		});
	}

	public onClose(): void {
		this.contentEl.empty();
	}
}