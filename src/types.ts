export type SyncDirection = "push" | "pull" | "both";
export type SyncStatus = "idle" | "running" | "completed" | "cancelled" | "error";
export type ConflictStrategy = "newer-wins" | "local-wins" | "remote-wins";

export interface YandexSyncSettings {
	oauthClientId: string;
	yandexToken: string;
	remotePath: string;
	excludePatterns: string[];
	maxFileSizeMB: number;
	conflictStrategy: ConflictStrategy;
	stateFingerprint: string | null;
	lastSync: SyncSummary | null;
}

export interface SyncSummary {
	timestamp: number;
	direction: SyncDirection;
	filesCompleted: number;
	filesSkipped: number;
	totalBytes: number;
	success: boolean;
	uploaded?: number;
	downloaded?: number;
	renamed?: number;
	deleted?: number;
}

export interface RemoteResource {
	name: string;
	path: string;
	type: "file" | "dir";
	size: number;
	modified?: string;
	sha256?: string;
	md5?: string;
}

export interface SyncProgress {
	direction: SyncDirection;
	status: SyncStatus;
	current: number;
	total: number;
	currentFileName: string;
	currentFileSize: number;
	completedBytes: number;
	totalBytes: number;
	message?: string;
}

export interface SyncResult {
	filesCompleted: number;
	filesSkipped: number;
	totalBytes: number;
	cancelled: boolean;
	uploaded?: number;
	downloaded?: number;
	renamed?: number;
	deleted?: number;
}

export interface FileMetadata {
	path: string;
	mtime: number;
	size: number;
	hash: string;
	remoteMtime?: string;
	previousPaths?: string[];
}

export interface SyncStateFile {
	version: number;
	lastSyncTimestamp: number;
	files: Record<string, FileMetadata>;
}

export const DEFAULT_SETTINGS: YandexSyncSettings = {
	oauthClientId: "",
	yandexToken: "",
	remotePath: "app:/ObsidianVault",
	excludePatterns: [".obsidian/", ".trash/", ".git/"],
	maxFileSizeMB: 25,
	conflictStrategy: "newer-wins",
	stateFingerprint: null,
	lastSync: null,
};
