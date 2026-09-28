import { App, TFile, normalizePath } from "obsidian";
import { computeHash } from "./hashUtils";
import { PlanAction, SyncPlan, buildSyncPlan } from "./sync/syncPlanner";
import { SyncStateStore } from "./sync/syncState";
import { RemoteResource, SyncDirection, SyncProgress, SyncResult, YandexSyncSettings } from "./types";
import { dirname, isExcluded, joinRemotePath, normalizeRemotePath, toErrorMessage } from "./utils";
import { YandexDiskClient } from "./yandexDiskClient";

type ProgressCallback = (progress: SyncProgress) => void;

interface LocalSnapshotEntry {
	path: string;
	mtime: number;
	size: number;
	hash: string;
}

export class SyncEngine {
	private cancelled = false;
	private readonly client: YandexDiskClient;

	public constructor(
		private readonly app: App,
		private readonly settings: YandexSyncSettings,
		private readonly stateStore: SyncStateStore,
		private readonly onProgress: ProgressCallback,
	) {
		this.client = new YandexDiskClient(settings.yandexToken);
	}

	public cancel(): void {
		this.cancelled = true;
	}

	public isCancelled(): boolean {
		return this.cancelled;
	}

	public async validateConnection(): Promise<void> {
		await this.client.verifyAccess();
	}

	/** Ensure remote base folder exists. */
	public async prepareRemoteFolder(): Promise<void> {
		const created = new Set<string>();
		await this.ensureRemoteFolder(normalizeRemotePath(this.settings.remotePath), created);
	}

	/** Recursively list remote files under sync root. */
	public async listRemoteFiles(): Promise<RemoteResource[]> {
		return this.client.listFilesRecursively(normalizeRemotePath(this.settings.remotePath));
	}

	/** Build a three-way sync plan. */
	public async buildPlan(remoteFiles: RemoteResource[]): Promise<SyncPlan> {
		const localSnapshot = await this.snapshotLocal();
		const remote = new Map<string, RemoteResource>();
		const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;

		for (const file of remoteFiles) {
			try {
				const localPath = this.toLocalPath(file.path);
				if (isExcluded(localPath, this.settings.excludePatterns)) {
					continue;
				}
				if (file.size > maxBytes) {
					continue;
				}
				remote.set(localPath, file);
			} catch {
				// Outside sync root — ignore
			}
		}

		return buildSyncPlan({
			local: localSnapshot,
			remote,
			base: this.stateStore.all(),
			strategy: this.settings.conflictStrategy,
			isExcluded: (path) => isExcluded(path, this.settings.excludePatterns),
		});
	}

	/** Snapshot local vault with cached hashing (re-hash only when mtime/size changed). */
	public async snapshotLocal(): Promise<Map<string, LocalSnapshotEntry>> {
		const snapshot = new Map<string, LocalSnapshotEntry>();
		const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;

		for (const file of this.app.vault.getFiles()) {
			if (this.cancelled) {
				break;
			}
			if (isExcluded(file.path, this.settings.excludePatterns) || file.stat.size > maxBytes) {
				continue;
			}

			const cached = this.stateStore.get(file.path);
			let hash = "";
			if (cached && cached.mtime === file.stat.mtime && cached.size === file.stat.size) {
				hash = cached.hash;
			} else {
				try {
					const content = await this.app.vault.readBinary(file);
					hash = await computeHash(content);
				} catch (error) {
					console.warn(`Yandex.Disk Sync: failed to hash ${file.path}`, error);
					continue;
				}
			}
			snapshot.set(file.path, { path: file.path, mtime: file.stat.mtime, size: file.stat.size, hash });
		}
		return snapshot;
	}

	/**
	 * One-directional push with hash-based skipping. Does not delete remote files.
	 */
	public async pushToYandex(plan?: SyncPlan): Promise<SyncResult> {
		const created = new Set<string>();
		await this.prepareRemoteFolder();

		const actions = plan
			? plan.actions.filter((a) => a.type === "upload" || a.type === "rename-remote")
			: null;

		if (!actions) {
			// Legacy path: push everything (used when no plan was built)
			return this.legacyPush(created);
		}

		const uploads = actions.filter((a) => a.type === "upload");
		const total = actions.length;
		let completed = 0;
		const planSkipped = plan ? plan.actions.filter((a) => a.type === "skip-identical" || a.type === "skip-pending-refresh").length : 0;
		let skipped = planSkipped;
		let completedBytes = 0;
		let uploaded = 0;
		let renamed = 0;
		const totalBytes = uploads.reduce((sum, a) => sum + (a.type === "upload" ? a.local.size : 0), 0);

		for (const action of actions) {
			if (this.cancelled) {
				return { ...this.cancelledResult(completed, skipped, completedBytes, "push", total, totalBytes), uploaded, renamed };
			}
			try {
				if (action.type === "rename-remote") {
					this.emit("push", "running", completed, total, `Переименование: ${action.oldPath} → ${action.newPath}`, 0, 0, completedBytes, totalBytes);
					await this.ensureRemoteFolder(dirname(this.toRemotePath(action.newPath)), created);
					await this.client.moveResource(this.toRemotePath(action.oldPath), this.toRemotePath(action.newPath));
					const metadata = this.stateStore.get(action.oldPath);
					this.stateStore.remove(action.oldPath);
					this.stateStore.set(action.newPath, {
						path: action.newPath,
						mtime: action.local.mtime,
						size: action.local.size,
						hash: action.local.hash,
						remoteMtime: metadata?.remoteMtime,
						previousPaths: [...(metadata?.previousPaths ?? []), action.oldPath].slice(-5),
					});
					completed += 1;
					renamed += 1;
				} else if (action.type === "upload") {
					this.emit("push", "running", completed, total, action.path, action.local.size, 0, completedBytes, totalBytes);
					await this.uploadOne(action.path, action.local, created);
					completed += 1;
					uploaded += 1;
					completedBytes += action.local.size;
				}
				if (completed % 10 === 0) {
					await this.stateStore.save();
				}
			} catch (error) {
				console.error(`Yandex.Disk Sync: push failed for an item`, error);
				skipped += 1;
				this.emit("push", "running", completed, total, `Ошибка: ${toErrorMessage(error)}`, 0, 0, completedBytes, totalBytes);
			}
		}

		await this.stateStore.save();
		this.emit("push", "completed", completed, total, `Загрузка завершена: загружено ${uploaded}, переименовано ${renamed}, пропущено ${skipped}`, 0, 0, completedBytes, totalBytes);
		return { filesCompleted: completed, filesSkipped: skipped, totalBytes: completedBytes, cancelled: false, uploaded, renamed };
	}

	private async uploadOne(path: string, local: LocalSnapshotEntry, createdFolders: Set<string>): Promise<void> {
		const file = this.app.vault.getFileByPath(normalizePath(path));
		if (!file) {
			throw new Error(`Локальный файл не найден: ${path}`);
		}
		const remotePath = this.toRemotePath(path);
		await this.ensureRemoteFolder(dirname(remotePath), createdFolders);
		const content = await this.app.vault.readBinary(file);
		const hash = await computeHash(content);
		await this.client.uploadFile(remotePath, content);
		this.stateStore.set(path, {
			path,
			mtime: file.stat.mtime,
			size: content.byteLength,
			hash,
			remoteMtime: new Date().toISOString(),
		});
	}

	/**
	 * One-directional pull with hash-based skipping. Does not delete local files.
	 */
	public async pullFromYandex(plan?: SyncPlan): Promise<SyncResult> {
		const actions = plan
			? plan.actions.filter((a) => a.type === "download" || a.type === "rename-local")
			: null;

		if (!actions) {
			return this.legacyPull();
		}

		const downloads = actions.filter((a) => a.type === "download");
		const total = actions.length;
		let completed = 0;
		const planSkipped = plan ? plan.actions.filter((a) => a.type === "skip-identical" || a.type === "skip-pending-refresh").length : 0;
		let skipped = planSkipped;
		let completedBytes = 0;
		let downloaded = 0;
		let renamed = 0;
		const totalBytes = downloads.reduce((sum, a) => sum + (a.type === "download" ? a.remote.size : 0), 0);

		for (const action of actions) {
			if (this.cancelled) {
				return { ...this.cancelledResult(completed, skipped, completedBytes, "pull", total, totalBytes), downloaded, renamed };
			}
			try {
				if (action.type === "rename-local") {
					this.emit("pull", "running", completed, total, `Переименование: ${action.oldPath} → ${action.newPath}`, 0, 0, completedBytes, totalBytes);
					await this.renameLocalFile(action.oldPath, action.newPath);
					const metadata = this.stateStore.get(action.oldPath);
					this.stateStore.remove(action.oldPath);
					this.stateStore.set(action.newPath, {
						path: action.newPath,
						mtime: Date.now(),
						size: action.remote.size,
						hash: action.remote.sha256 ?? metadata?.hash ?? "",
						remoteMtime: action.remote.modified,
						previousPaths: [...(metadata?.previousPaths ?? []), action.oldPath].slice(-5),
					});
					completed += 1;
					renamed += 1;
				} else if (action.type === "download") {
					this.emit("pull", "running", completed, total, action.path, action.remote.size, 0, completedBytes, totalBytes);
					await this.downloadOne(action.path, action.remote);
					completed += 1;
					downloaded += 1;
					completedBytes += action.remote.size;
				}
				if (completed % 10 === 0) {
					await this.stateStore.save();
				}
			} catch (error) {
				console.error(`Yandex.Disk Sync: pull failed for an item`, error);
				skipped += 1;
				this.emit("pull", "running", completed, total, `Ошибка: ${toErrorMessage(error)}`, 0, 0, completedBytes, totalBytes);
			}
		}

		await this.stateStore.save();
		this.emit("pull", "completed", completed, total, `Скачивание завершено: скачано ${downloaded}, переименовано ${renamed}, пропущено ${skipped}`, 0, 0, completedBytes, totalBytes);
		return { filesCompleted: completed, filesSkipped: skipped, totalBytes: completedBytes, cancelled: false, downloaded, renamed };
	}

	private async downloadOne(path: string, remote: RemoteResource): Promise<void> {
		await this.ensureLocalFolder(dirname(path));
		const content = await this.client.downloadFile(remote.path);
		await this.writeLocalFile(path, content);
		this.stateStore.set(path, {
			path,
			mtime: Date.now(),
			size: content.byteLength,
			hash: remote.sha256 ?? (await computeHash(content)),
			remoteMtime: remote.modified,
		});
	}

	/**
	 * Bidirectional smart sync. Only deletions require external approval.
	 */
	public async executePlan(plan: SyncPlan): Promise<SyncResult> {
		const created = new Set<string>();
		await this.prepareRemoteFolder();

		const transferable = plan.actions.filter(
			(a) => a.type === "upload" || a.type === "download" || a.type === "rename-remote" || a.type === "rename-local",
		);
		const deletions = plan.actions.filter((a) => a.type === "delete-local" || a.type === "delete-remote");
		let completed = 0;
		let skipped = plan.actions.filter((a) => a.type === "skip-identical" || a.type === "skip-pending-refresh").length;
		let completedBytes = 0;
		let uploaded = 0;
		let downloaded = 0;
		let renamed = 0;
		let deleted = 0;
		const totalBytes = transferable.reduce((sum, a) => {
			if (a.type === "upload") return sum + a.local.size;
			if (a.type === "download") return sum + a.remote.size;
			return sum;
		}, 0);
		const total = transferable.length + deletions.length;

		for (const action of transferable) {
			if (this.cancelled) {
				return { ...this.cancelledResult(completed, skipped, completedBytes, "both", total, totalBytes), uploaded, downloaded, renamed, deleted };
			}
			try {
				if (action.type === "rename-remote") {
					this.emit("both", "running", completed, total, `Переименование: ${action.oldPath} → ${action.newPath}`, 0, 0, completedBytes, totalBytes);
					await this.ensureRemoteFolder(dirname(this.toRemotePath(action.newPath)), created);
					await this.client.moveResource(this.toRemotePath(action.oldPath), this.toRemotePath(action.newPath));
					const metadata = this.stateStore.get(action.oldPath);
					this.stateStore.remove(action.oldPath);
					this.stateStore.set(action.newPath, {
						path: action.newPath,
						mtime: action.local.mtime,
						size: action.local.size,
						hash: action.local.hash,
						remoteMtime: metadata?.remoteMtime,
						previousPaths: [...(metadata?.previousPaths ?? []), action.oldPath].slice(-5),
					});
					renamed += 1;
				} else if (action.type === "rename-local") {
					this.emit("both", "running", completed, total, `Переименование: ${action.oldPath} → ${action.newPath}`, 0, 0, completedBytes, totalBytes);
					await this.renameLocalFile(action.oldPath, action.newPath);
					const metadata = this.stateStore.get(action.oldPath);
					this.stateStore.remove(action.oldPath);
					this.stateStore.set(action.newPath, {
						path: action.newPath,
						mtime: Date.now(),
						size: action.remote.size,
						hash: action.remote.sha256 ?? metadata?.hash ?? "",
						remoteMtime: action.remote.modified,
						previousPaths: [...(metadata?.previousPaths ?? []), action.oldPath].slice(-5),
					});
					renamed += 1;
				} else if (action.type === "upload") {
					this.emit("both", "running", completed, total, `↑ ${action.path}`, action.local.size, 0, completedBytes, totalBytes);
					await this.uploadOne(action.path, action.local, created);
					uploaded += 1;
					completedBytes += action.local.size;
				} else if (action.type === "download") {
					this.emit("both", "running", completed, total, `↓ ${action.path}`, action.remote.size, 0, completedBytes, totalBytes);
					await this.downloadOne(action.path, action.remote);
					downloaded += 1;
					completedBytes += action.remote.size;
				}
				completed += 1;
				if (completed % 10 === 0) {
					await this.stateStore.save();
				}
			} catch (error) {
				console.error(`Yandex.Disk Sync: item failed`, error);
				skipped += 1;
				this.emit("both", "running", completed, total, `Ошибка: ${toErrorMessage(error)}`, 0, 0, completedBytes, totalBytes);
			}
		}

		// Deletions are applied only if present in the plan (already approved)
		for (const action of deletions) {
			if (this.cancelled) {
				return { ...this.cancelledResult(completed, skipped, completedBytes, "both", total, totalBytes), uploaded, downloaded, renamed, deleted };
			}
			try {
				if (action.type === "delete-local") {
					this.emit("both", "running", completed, total, `Удаление локально: ${action.path}`, 0, 0, completedBytes, totalBytes);
					await this.deleteLocalFile(action.path);
					this.stateStore.remove(action.path);
				} else {
					this.emit("both", "running", completed, total, `Удаление на Диске: ${action.path}`, 0, 0, completedBytes, totalBytes);
					await this.client.deleteResource(this.toRemotePath(action.path));
					this.stateStore.remove(action.path);
				}
				completed += 1;
				deleted += 1;
			} catch (error) {
				console.error(`Yandex.Disk Sync: deletion failed`, error);
				skipped += 1;
			}
		}

		await this.stateStore.touchTimestamp();
		await this.stateStore.save();
		const statsMessage = `Завершено: ↑${uploaded} загружено, ↓${downloaded} скачано, ⇄${renamed} переименовано, 🗑${deleted} удалено, пропущено ${skipped}`;
		this.emit("both", "completed", completed, total, statsMessage, 0, 0, completedBytes, totalBytes);
		return { filesCompleted: completed, filesSkipped: skipped, totalBytes: completedBytes, cancelled: false, uploaded, downloaded, renamed, deleted };
	}

	/** Build plan without deletions (first confirmation step of bidirectional sync). */
	public stripDeletions(plan: SyncPlan): SyncPlan {
		return {
			...plan,
			actions: plan.actions.filter((a) => a.type !== "delete-local" && a.type !== "delete-remote"),
		};
	}

	/** Collect deletion actions for the confirmation dialog. */
	public collectDeletions(plan: SyncPlan): PlanAction[] {
		return plan.actions.filter((a) => a.type === "delete-local" || a.type === "delete-remote");
	}

	/** Build a plan containing only deletions (executed after approval). */
	public deletionsOnlyPlan(plan: SyncPlan): SyncPlan {
		return {
			...plan,
			actions: plan.actions.filter((a) => a.type === "delete-local" || a.type === "delete-remote"),
		};
	}

	private async renameLocalFile(oldPath: string, newPath: string): Promise<void> {
		const normalizedOld = normalizePath(oldPath);
		const normalizedNew = normalizePath(newPath);
		const file = this.app.vault.getAbstractFileByPath(normalizedOld);
		if (!(file instanceof TFile)) {
			throw new Error(`Файл не найден для переименования: ${oldPath}`);
		}
		await this.ensureLocalFolder(dirname(newPath));
		const target = this.app.vault.getAbstractFileByPath(normalizedNew);
		if (target) {
			throw new Error(`Невозможно переименовать: «${newPath}» уже существует.`);
		}
		await this.app.fileManager.renameFile(file, normalizedNew);
	}

	private async deleteLocalFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (file instanceof TFile) {
			// Obsidian local trash — recoverable
			await this.app.vault.trash(file, false);
		}
	}

	private toRemotePath(localPath: string): string {
		return joinRemotePath(this.settings.remotePath, localPath);
	}

	private toLocalPath(remotePath: string): string {
		const root = normalizeRemotePath(this.settings.remotePath);
		const normalizedRemote = normalizeRemotePath(remotePath);
		const prefix = `${root}/`;
		if (!normalizedRemote.startsWith(prefix)) {
			throw new Error(`Удалённый файл находится вне выбранной папки: ${remotePath}`);
		}
		return normalizedRemote.slice(prefix.length);
	}

	/**
	 * Refresh state metadata for files skipped as identical or pending refresh.
	 * Ensures base state reflects current mtime/hash without transferring content.
	 */
	public async refreshSkippedState(plan: SyncPlan): Promise<void> {
		for (const action of plan.actions) {
			if (action.type !== "skip-identical" && action.type !== "skip-pending-refresh") {
				continue;
			}
			const local = plan.local.get(action.path);
			const remote = plan.remote.get(action.path);
			const base = this.stateStore.get(action.path);
			if (local) {
				this.stateStore.set(action.path, {
					path: action.path,
					mtime: local.mtime,
					size: local.size,
					hash: remote?.sha256 ?? local.hash ?? base?.hash ?? "",
					remoteMtime: remote?.modified ?? base?.remoteMtime,
				});
			} else if (remote && base) {
				this.stateStore.set(action.path, {
					...base,
					remoteMtime: remote.modified ?? base.remoteMtime,
					hash: remote.sha256 ?? base.hash,
				});
			}
		}
		await this.stateStore.save();
	}

	// ----- Legacy one-directional fallback (no state) -----

	private async legacyPush(createdFolders: Set<string>): Promise<SyncResult> {
		const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
		const files = this.app.vault
			.getFiles()
			.filter((file) => !isExcluded(file.path, this.settings.excludePatterns) && file.stat.size <= maxBytes);
		let skipped = this.app.vault.getFiles().length - files.length;
		const totalBytes = files.reduce((sum, file) => sum + file.stat.size, 0);
		let completed = 0;
		let completedBytes = 0;

		for (const file of files) {
			if (this.cancelled) {
				return this.cancelledResult(completed, skipped, completedBytes, "push", files.length, totalBytes);
			}
			try {
				this.emit("push", "running", completed, files.length, file.path, file.stat.size, 0, completedBytes, totalBytes);
				const remotePath = this.toRemotePath(file.path);
				await this.ensureRemoteFolder(dirname(remotePath), createdFolders);
				const content = await this.app.vault.readBinary(file);
				await this.client.uploadFile(remotePath, content);
				completed += 1;
				completedBytes += file.stat.size;
			} catch (error) {
				console.error(error);
				skipped += 1;
			}
		}
		this.emit("push", "completed", completed, files.length, "Загрузка завершена", 0, 0, completedBytes, totalBytes);
		return { filesCompleted: completed, filesSkipped: skipped, totalBytes: completedBytes, cancelled: false };
	}

	private async legacyPull(): Promise<SyncResult> {
		const remoteFiles = await this.listRemoteFiles();
		const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
		const files = remoteFiles.filter((file) => {
			try {
				return !isExcluded(this.toLocalPath(file.path), this.settings.excludePatterns) && file.size <= maxBytes;
			} catch {
				return false;
			}
		});
		let skipped = remoteFiles.length - files.length;
		const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
		let completed = 0;
		let completedBytes = 0;

		for (const remoteFile of files) {
			if (this.cancelled) {
				return this.cancelledResult(completed, skipped, completedBytes, "pull", files.length, totalBytes);
			}
			try {
				const localPath = this.toLocalPath(remoteFile.path);
				this.emit("pull", "running", completed, files.length, localPath, remoteFile.size, 0, completedBytes, totalBytes);
				await this.downloadOne(localPath, remoteFile);
				completed += 1;
				completedBytes += remoteFile.size;
			} catch (error) {
				console.error(error);
				skipped += 1;
			}
		}
		this.emit("pull", "completed", completed, files.length, "Скачивание завершено", 0, 0, completedBytes, totalBytes);
		return { filesCompleted: completed, filesSkipped: skipped, totalBytes: completedBytes, cancelled: false };
	}

	// ----- Folder helpers -----

	private async ensureRemoteFolder(path: string, createdFolders: Set<string>): Promise<void> {
		const normalizedPath = normalizeRemotePath(path);
		if (normalizedPath === "/" || normalizedPath === "app:/" || createdFolders.has(normalizedPath)) {
			return;
		}
		const parent = dirname(normalizedPath);
		if (parent) {
			await this.ensureRemoteFolder(parent, createdFolders);
		}
		await this.client.createFolder(normalizedPath);
		createdFolders.add(normalizedPath);
	}

	private async ensureLocalFolder(path: string): Promise<void> {
		if (!path) {
			return;
		}
		const normalized = normalizePath(path);
		const existingStat = await this.app.vault.adapter.stat(normalized);
		if (existingStat?.type === "folder") {
			return;
		}
		if (existingStat?.type === "file") {
			throw new Error(`Невозможно создать папку: «${path}» уже существует как файл.`);
		}
		const parent = dirname(normalized);
		if (parent) {
			await this.ensureLocalFolder(parent);
		}
		try {
			await this.app.vault.createFolder(normalized);
		} catch (error) {
			// Android index lag: verify via adapter instead of trusting the error
			const statAfterCreate = await this.app.vault.adapter.stat(normalized);
			if (statAfterCreate?.type !== "folder") {
				throw error;
			}
		}
	}

	private async writeLocalFile(path: string, content: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, content);
			return;
		}
		if (existing) {
			throw new Error(`Невозможно записать файл: «${path}» уже существует как папка.`);
		}
		await this.app.vault.createBinary(normalized, content);
	}

	private cancelledResult(
		completed: number,
		skipped: number,
		completedBytes: number,
		direction: SyncDirection,
		total: number,
		totalBytes: number,
	): SyncResult {
		this.emit(direction, "cancelled", completed, total, "Синхронизация отменена", 0, 0, completedBytes, totalBytes);
		return { filesCompleted: completed, filesSkipped: skipped, totalBytes: completedBytes, cancelled: true };
	}

	private emit(
		direction: SyncDirection,
		status: SyncProgress["status"],
		current: number,
		total: number,
		currentFileName: string,
		currentFileSize: number,
		currentFileBytes: number,
		completedBytes: number,
		totalBytes: number,
	): void {
		this.onProgress({
			direction,
			status,
			current,
			total,
			currentFileName,
			currentFileSize,
			completedBytes,
			totalBytes,
			message: currentFileBytes > 0 ? `Передано ${currentFileBytes} байт` : undefined,
		});
	}
}
