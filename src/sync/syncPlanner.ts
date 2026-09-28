import { FileMetadata, RemoteResource } from "../types";

export interface LocalFileSnapshot {
	path: string;
	mtime: number;
	size: number;
	hash: string;
}

export type PlanAction =
	| { type: "upload"; path: string; local: LocalFileSnapshot }
	| { type: "download"; path: string; remote: RemoteResource }
	| { type: "delete-local"; path: string; reason: string }
	| { type: "delete-remote"; path: string; reason: string }
	| { type: "rename-remote"; oldPath: string; newPath: string; local: LocalFileSnapshot }
	| { type: "rename-local"; oldPath: string; newPath: string; remote: RemoteResource }
	| { type: "skip-identical"; path: string }
	| { type: "skip-pending-refresh"; path: string }
	| { type: "conflict"; path: string; local: LocalFileSnapshot; remote: RemoteResource };

export interface SyncPlan {
	actions: PlanAction[];
	local: Map<string, LocalFileSnapshot>;
	remote: Map<string, RemoteResource>;
}

/**
 * Detect renames within one side: a deleted path and a new path that share
 * the same content hash are almost certainly the same file moved/renamed.
 * Ambiguous hashes (multiple identical copies) are ignored and handled as
 * plain delete+create instead of a rename.
 */
interface FileInfo {
	path: string;
	hash: string;
}

function detectRenamesEfficient(deleted: FileInfo[], added: FileInfo[]): Map<string, string> {
	const renames = new Map<string, string>();
	const hashToNewPaths = new Map<string, string[]>();
	for (const file of added) {
		const list = hashToNewPaths.get(file.hash) ?? [];
		list.push(file.path);
		hashToNewPaths.set(file.hash, list);
	}
	for (const file of deleted) {
		const candidates = hashToNewPaths.get(file.hash);
		if (candidates && candidates.length === 1) {
			renames.set(file.path, candidates[0]);
		}
	}
	return renames;
}

/**
 * Build a three-way merge plan: local current vs remote current vs state base.
 * Strategy for conflicts is resolved by the caller beforehand where possible
 * (newer-wins/local-wins/remote-wins), otherwise returned as "conflict".
 */
export function buildSyncPlan(params: {
	local: Map<string, LocalFileSnapshot>;
	remote: Map<string, RemoteResource>;
	base: Record<string, FileMetadata>;
	strategy: "newer-wins" | "local-wins" | "remote-wins";
	isExcluded: (path: string) => boolean;
}): SyncPlan {
	const { local, remote, base, strategy, isExcluded } = params;
	const actions: PlanAction[] = [];
	const allPaths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(base)]);

	// 1) Detect renames per side: deleted (in base, not in current) vs added (in current, not in base)
	const localDeleted = Object.keys(base).filter((path) => !local.has(path) && !isExcluded(path));
	const localAdded = [...local.values()].filter((file) => !base[file.path]);
	const remoteDeleted = Object.keys(base).filter((path) => !remote.has(path) && !isExcluded(path));
	const remoteAdded = [...remote.values()].filter(
		(file) => !base[file.path] && !!file.sha256 && !isExcluded(file.path),
	);

	const localRenames = detectRenamesEfficient(
		localDeleted.map((path) => ({ path, hash: base[path].hash })),
		localAdded.map((file) => ({ path: file.path, hash: file.hash })),
	);
	const remoteRenames = detectRenamesEfficient(
		remoteDeleted.map((path) => ({ path, hash: base[path].hash })),
		remoteAdded.map((file) => ({ path: file.path, hash: file.sha256 as string })),
	);

	// renameMap: canonical OLD path -> final path after local/remote rename resolution
	const localRenameMap = new Map<string, string>(); // old -> new (local final name)
	const remoteRenameMap = new Map<string, string>(); // old -> new (remote final name)
	const usedOld = new Set<string>();
	const usedNew = new Set<string>();

	for (const [oldPath, newPath] of localRenames) {
		const remoteNew = remoteRenames.get(oldPath);
		if (remoteNew && remoteNew !== newPath) {
			// Both sides renamed to different names -> resolve by strategy
			if (strategy === "local-wins") {
				localRenameMap.set(oldPath, newPath);
			} else if (strategy === "remote-wins") {
				remoteRenameMap.set(oldPath, remoteNew);
			} else {
				// newer-wins: compare mtimes of the renamed instances
				const localFile = local.get(newPath);
				const remoteFile = remote.get(remoteNew);
				const localMtime = localFile?.mtime ?? 0;
				const remoteMtime = remoteFile?.modified ? Date.parse(remoteFile.modified) : 0;
				if (localMtime >= remoteMtime) {
					localRenameMap.set(oldPath, newPath);
				} else {
					remoteRenameMap.set(oldPath, remoteNew);
				}
			}
		} else {
			localRenameMap.set(oldPath, newPath);
		}
		usedOld.add(oldPath);
		usedNew.add(newPath);
		if (remoteNew) {
			usedNew.add(remoteNew);
		}
	}
	for (const [oldPath, newPath] of remoteRenames) {
		if (!usedOld.has(oldPath)) {
			remoteRenameMap.set(oldPath, newPath);
			usedOld.add(oldPath);
			usedNew.add(newPath);
		}
	}

	// Emit rename actions and remap plan keys: renames act on OLD canonical path
	for (const [oldPath, newPath] of localRenameMap) {
		const localFile = local.get(newPath);
		if (localFile && !isExcluded(newPath)) {
			// Remote side still has oldPath? Then rename remote; otherwise plain upload.
			if (remote.has(oldPath)) {
				actions.push({ type: "rename-remote", oldPath, newPath, local: localFile });
			} else {
				actions.push({ type: "upload", path: newPath, local: localFile });
			}
		}
	}
	for (const [oldPath, newPath] of remoteRenameMap) {
		if (localRenameMap.has(oldPath)) {
			continue; // already handled (local-wins or resolved)
		}
		const remoteFile = remote.get(newPath);
		if (remoteFile && !isExcluded(newPath)) {
			if (local.has(oldPath)) {
				actions.push({ type: "rename-local", oldPath, newPath, remote: remoteFile });
			} else {
				actions.push({ type: "download", path: newPath, remote: remoteFile });
			}
		}
	}

	// 2) Main three-way walk over remaining paths
	for (const path of allPaths) {
		if (isExcluded(path)) {
			continue;
		}
		if (usedOld.has(path) || usedNew.has(path)) {
			continue; // handled by rename logic
		}

		const localFile = local.get(path);
		const remoteFile = remote.get(path);
		const baseFile = base[path];

		const localExists = !!localFile;
		const remoteExists = !!remoteFile;

		// localChanged: local content differs from base. baseFile may be absent
		// (new file), which is handled in the !baseFile branch below.
		const localChanged = localExists && !!baseFile && baseFile.hash !== localFile.hash;
		// remoteChanged: remote content differs from base. Without a remote hash
		// we conservatively assume "not changed" so one-way checks degrade to
		// mtime-based decisions instead of blind transfers.
		const remoteChanged = remoteExists && !!baseFile && !!remoteFile.sha256 && baseFile.hash !== remoteFile.sha256;

		if (!baseFile) {
			// Not in base: new on one or both sides
			if (localExists && !remoteExists) {
				actions.push({ type: "upload", path, local: localFile });
			} else if (!localExists && remoteExists) {
				actions.push({ type: "download", path, remote: remoteFile });
			} else if (localExists && remoteExists) {
				// Both sides have it, no base: compare hashes
				if (remoteFile.sha256 && localFile.hash === remoteFile.sha256) {
					actions.push({ type: "skip-identical", path });
				} else if (!remoteFile.sha256) {
					actions.push({ type: "skip-pending-refresh", path });
				} else {
					actions.push(resolveConflict(path, localFile, remoteFile, strategy));
				}
			}
			continue;
		}

		if (localExists && remoteExists) {
			if (!remoteFile.sha256) {
				// No remote hash available: cannot compare reliably
				if (localChanged) {
					// Local definitely changed -> upload is safe
					actions.push({ type: "upload", path, local: localFile });
				} else {
					actions.push({ type: "skip-pending-refresh", path });
				}
				continue;
			}
			if (!localChanged && !remoteChanged) {
				actions.push({ type: "skip-identical", path });
				continue;
			}
			if (localChanged && !remoteChanged) {
				actions.push({ type: "upload", path, local: localFile });
				continue;
			}
			if (!localChanged && remoteChanged) {
				actions.push({ type: "download", path, remote: remoteFile });
				continue;
			}
			// both changed
			if (localFile.hash === remoteFile.sha256) {
				actions.push({ type: "skip-identical", path });
				continue;
			}
			actions.push(resolveConflict(path, localFile, remoteFile, strategy));
			continue;
		}

		// Exists on exactly one side, but was in base -> deleted on the other side
		if (localExists && !remoteExists) {
			if (!localChanged) {
				// remote deleted, local unchanged -> propagate deletion
				actions.push({ type: "delete-local", path, reason: "Файл удалён на Yandex.Disk" });
			} else {
				// remote deleted, local changed -> conflict resolved by strategy
				if (strategy === "local-wins") {
					actions.push({ type: "upload", path, local: localFile });
				} else if (strategy === "remote-wins") {
					actions.push({ type: "delete-local", path, reason: "Файл удалён на Yandex.Disk" });
				} else {
					const remoteDeletedMtime = baseFile.remoteMtime ? Date.parse(baseFile.remoteMtime) : 0;
					if (localFile.mtime >= remoteDeletedMtime) {
						actions.push({ type: "upload", path, local: localFile });
					} else {
						actions.push({ type: "delete-local", path, reason: "Файл удалён на Yandex.Disk" });
					}
				}
			}
			continue;
		}

		if (!localExists && remoteExists) {
			if (!remoteChanged) {
				actions.push({ type: "delete-remote", path, reason: "Файл удалён локально" });
			} else {
				if (strategy === "local-wins") {
					actions.push({ type: "delete-remote", path, reason: "Файл удалён локально" });
				} else if (strategy === "remote-wins") {
					actions.push({ type: "download", path, remote: remoteFile });
				} else {
					const localDeletedMtime = baseFile.mtime ?? 0;
					const remoteMtime = remoteFile.modified ? Date.parse(remoteFile.modified) : 0;
					if (remoteMtime >= localDeletedMtime) {
						actions.push({ type: "download", path, remote: remoteFile });
					} else {
						actions.push({ type: "delete-remote", path, reason: "Файл удалён локально" });
					}
				}
			}
			continue;
		}

		// Deleted on both sides -> nothing to do
	}

	return { actions, local, remote };
}

function resolveConflict(
	path: string,
	local: LocalFileSnapshot,
	remote: RemoteResource,
	strategy: "newer-wins" | "local-wins" | "remote-wins",
): PlanAction {
	if (strategy === "local-wins") {
		return { type: "upload", path, local };
	}
	if (strategy === "remote-wins") {
		return { type: "download", path, remote };
	}
	const localMtime = local.mtime;
	const remoteMtime = remote.modified ? Date.parse(remote.modified) : 0;
	if (localMtime > remoteMtime) {
		return { type: "upload", path, local };
	}
	if (remoteMtime > localMtime) {
		return { type: "download", path, remote };
	}
	// Same mtime, different content: default to local to avoid data loss surprise
	return { type: "upload", path, local };
}
