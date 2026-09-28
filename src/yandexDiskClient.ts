import { requestUrl } from "obsidian";
import { RemoteResource } from "./types";
import { normalizeRemotePath } from "./utils";

interface DiskApiError {
	description?: string;
	error?: string;
	message?: string;
}

interface LinkResponse {
	href: string;
}

interface ResourceResponse {
	type: "file" | "dir";
	name: string;
	path: string;
	size?: number;
	modified?: string;
	sha256?: string;
	md5?: string;
	_embedded?: {
		items?: ResourceResponse[];
		offset?: number;
		limit?: number;
		total?: number;
	};
}

export class YandexDiskClient {
	private readonly apiBaseUrl = "https://cloud-api.yandex.net/v1/disk";

	public constructor(private token: string) {}

	public setToken(token: string): void {
		this.token = token;
	}

	public async verifyAccess(): Promise<void> {
		// The plugin is designed for cloud_api:disk.app_folder. app:/ is the
		// root of the current OAuth application's dedicated Disk folder.
		await this.getResource("app:/", 1, 0);
	}

	public async resourceExists(path: string): Promise<boolean> {
		try {
			await this.getResource(path, 1, 0);
			return true;
		} catch (error) {
			if (this.getStatusCode(error) === 404) {
				return false;
			}
			throw error;
		}
	}

	public async createFolder(path: string): Promise<void> {
		const remotePath = normalizeRemotePath(path);
		try {
			await this.apiRequest(`/resources?path=${encodeURIComponent(remotePath)}`, "PUT");
		} catch (error) {
			if (this.getStatusCode(error) !== 409) {
				throw error;
			}
		}
	}

	public async listFilesRecursively(path: string): Promise<RemoteResource[]> {
		const root = normalizeRemotePath(path);
		const result: RemoteResource[] = [];
		const folders: string[] = [root];

		while (folders.length > 0) {
			const folderPath = folders.shift();
			if (!folderPath) {
				continue;
			}

			let offset = 0;
			let total = 0;
			do {
				const resource = await this.getResource(folderPath, 1000, offset);
				const embedded = resource._embedded;
				const items = embedded?.items ?? [];
				total = embedded?.total ?? items.length;

				for (const item of items) {
					// API returns disk:/absolute paths even for app:/ requests. Keep
					// the app:/ path so subsequent calls remain within app permissions.
					const remoteItem = this.toRemoteResource(item, folderPath);
					if (remoteItem.type === "dir") {
						folders.push(remoteItem.path);
					} else {
						result.push(remoteItem);
					}
				}
				offset += items.length;
			} while (offset < total);
		}

		return result;
	}

	public async uploadFile(path: string, content: ArrayBuffer): Promise<void> {
		const remotePath = normalizeRemotePath(path);
		const link = await this.apiRequest<LinkResponse>(
			`/resources/upload?path=${encodeURIComponent(remotePath)}&overwrite=true`,
			"GET",
		);

		await requestUrl({
			url: link.href,
			method: "PUT",
			body: content,
		});
	}

	public async downloadFile(path: string): Promise<ArrayBuffer> {
		const remotePath = normalizeRemotePath(path);
		const link = await this.apiRequest<LinkResponse>(
			`/resources/download?path=${encodeURIComponent(remotePath)}`,
			"GET",
		);

		const response = await requestUrl({
			url: link.href,
			method: "GET",
			headers: { Authorization: `OAuth ${this.token}` },
		});
		return response.arrayBuffer;
	}

	private async getResource(path: string, limit: number, offset: number): Promise<ResourceResponse> {
		// Explicitly request hash fields — Yandex returns sha256/md5 only when asked.
		const fields = encodeURIComponent("name,path,type,size,modified,sha256,md5,_embedded.items.name,_embedded.items.path,_embedded.items.type,_embedded.items.size,_embedded.items.modified,_embedded.items.sha256,_embedded.items.md5,_embedded.total,_embedded.offset,_embedded.limit");
		return this.apiRequest<ResourceResponse>(
			`/resources?path=${encodeURIComponent(normalizeRemotePath(path))}&limit=${limit}&offset=${offset}&fields=${fields}`,
			"GET",
		);
	}

	private toRemoteResource(resource: ResourceResponse, parentPath: string): RemoteResource {
		return {
			name: resource.name,
			path: normalizeRemotePath(`${parentPath}/${resource.name}`),
			type: resource.type,
			size: resource.size ?? 0,
			modified: resource.modified,
			sha256: resource.sha256,
			md5: resource.md5,
		};
	}

	/**
	 * Move/rename a resource on Yandex.Disk. May return asynchronously.
	 */
	public async moveResource(fromPath: string, toPath: string): Promise<void> {
		const from = encodeURIComponent(normalizeRemotePath(fromPath));
		const to = encodeURIComponent(normalizeRemotePath(toPath));
		await this.apiRequest(`/resources/move?from=${from}&path=${to}&overwrite=false`, "POST");
	}

	/**
	 * Delete a resource into Yandex.Disk trash (recoverable).
	 */
	public async deleteResource(path: string): Promise<void> {
		const remotePath = encodeURIComponent(normalizeRemotePath(path));
		try {
			await this.apiRequest(`/resources?path=${remotePath}&permanently=false`, "DELETE");
		} catch (error) {
			if (this.getStatusCode(error) !== 404) {
				throw error;
			}
		}
	}

	private async apiRequest<T>(endpoint: string, method: "GET" | "PUT" | "POST" | "DELETE"): Promise<T> {
		if (!this.token.trim()) {
			throw new Error("OAuth-токен Yandex.Disk не задан.");
		}

		try {
			const response = await requestUrl({
				url: `${this.apiBaseUrl}${endpoint}`,
				method,
				headers: {
					Authorization: `OAuth ${this.token}`,
					Accept: "application/json",
				},
			});
			return response.json as T;
		} catch (error) {
			throw this.createApiError(error);
		}
	}

	private createApiError(error: unknown): Error {
		const response = error as { status?: number; json?: DiskApiError; message?: string };
		const details = response.json?.description ?? response.json?.message ?? response.json?.error ?? response.message;
		const status = typeof response.status === "number" ? ` (${response.status})` : "";
		return Object.assign(new Error(`Yandex.Disk API${status}: ${details ?? "неизвестная ошибка"}`), {
			status: response.status,
		});
	}

	private getStatusCode(error: unknown): number | undefined {
		return (error as { status?: number }).status;
	}
}