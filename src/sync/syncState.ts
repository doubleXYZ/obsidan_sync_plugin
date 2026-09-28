import { App } from "obsidian";
import { FileMetadata, SyncStateFile } from "../types";

const STATE_FILENAME = "sync-state.json";
const STATE_VERSION = 1;

/**
 * Persistent metadata about files as of the last successful sync.
 * Stored in the plugin folder — excluded from vault syncing because
 * `.obsidian/` is in the default exclude patterns.
 */
export class SyncStateStore {
	private state: SyncStateFile | null = null;

	public constructor(
		private readonly app: App,
		private readonly pluginId: string,
	) {}

	private get statePath(): string {
		return `.obsidian/plugins/${this.pluginId}/${STATE_FILENAME}`;
	}

	public async load(): Promise<SyncStateFile> {
		if (this.state) {
			return this.state;
		}
		const empty: SyncStateFile = { version: STATE_VERSION, lastSyncTimestamp: 0, files: {} };
		try {
			const exists = await this.app.vault.adapter.exists(this.statePath);
			if (exists) {
				const raw = await this.app.vault.adapter.read(this.statePath);
				const parsed = JSON.parse(raw) as SyncStateFile;
				if (parsed.version === STATE_VERSION && parsed.files) {
					this.state = parsed;
					return parsed;
				}
			}
		} catch (error) {
			console.warn("Yandex.Disk Sync: failed to read sync state, starting fresh", error);
		}
		this.state = empty;
		return empty;
	}

	public async save(): Promise<void> {
		if (!this.state) {
			return;
		}
		try {
			await this.app.vault.adapter.write(this.statePath, JSON.stringify(this.state));
		} catch (error) {
			console.warn("Yandex.Disk Sync: failed to save sync state", error);
		}
	}

	public async reset(): Promise<void> {
		this.state = { version: STATE_VERSION, lastSyncTimestamp: 0, files: {} };
		await this.save();
	}

	public get(path: string): FileMetadata | undefined {
		return this.state?.files[path];
	}

	public set(path: string, metadata: FileMetadata): void {
		if (this.state) {
			this.state.files[path] = metadata;
		}
	}

	public remove(path: string): void {
		if (this.state) {
			delete this.state.files[path];
		}
	}

	public all(): Record<string, FileMetadata> {
		return this.state?.files ?? {};
	}

	public async touchTimestamp(): Promise<void> {
		if (this.state) {
			this.state.lastSyncTimestamp = Date.now();
			await this.save();
		}
	}

	public async isEmpty(): Promise<boolean> {
		const state = await this.load();
		return Object.keys(state.files).length === 0;
	}
}
