export function normalizeRemotePath(path: string): string {
	const normalized = path.trim().replace(/\\/g, "/");
	const appPath = /^app:\/*/i.test(normalized);
	const withoutScheme = appPath ? normalized.replace(/^app:\/*/i, "") : normalized;
	const cleanPath = withoutScheme.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");

	if (appPath) {
		return cleanPath ? `app:/${cleanPath}` : "app:/";
	}
	return cleanPath ? `/${cleanPath}` : "/";
}

export function joinRemotePath(...parts: string[]): string {
	return normalizeRemotePath(parts.filter(Boolean).join("/"));
}

export function dirname(path: string): string {
	const normalized = normalizeRemotePath(path);
	if (normalized === "/" || normalized === "app:/") {
		return "";
	}

	const separatorIndex = normalized.lastIndexOf("/");
	if (separatorIndex < 0) {
		return "";
	}
	if (normalized.startsWith("app:/") && separatorIndex === 4) {
		return "app:/";
	}
	return separatorIndex === 0 ? "" : normalized.slice(0, separatorIndex);
}

export function isExcluded(path: string, patterns: string[]): boolean {
	const normalizedPath = path.replace(/\\/g, "/").replace(/^\/+/, "");

	return patterns.some((rawPattern) => {
		const pattern = rawPattern.trim().replace(/^\/+/, "");
		if (!pattern) {
			return false;
		}

		if (pattern.endsWith("/")) {
			return normalizedPath.startsWith(pattern);
		}

		const expression = new RegExp(
			`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
			"i",
		);
		return expression.test(normalizedPath);
	});
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} Б`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} КБ`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Yandex OAuth returns the token in a URL fragment, for example:
 * https://oauth.yandex.ru/verification_code#access_token=TOKEN&token_type=bearer
 * The Disk API needs only TOKEN in the Authorization header.
 */
export function extractOAuthToken(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}

	const fragment = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : trimmed;
	const match = fragment.match(/(?:^|[?&#\s])access_token=([^&#\s]+)/i);
	return match ? decodeURIComponent(match[1]) : trimmed;
}