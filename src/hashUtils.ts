/**
 * SHA-256 hashing via Web Crypto API (available on Android WebView).
 * Returns lowercase hex string.
 */
export async function computeHash(content: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", content);
	return bufferToHex(hashBuffer);
}

export function bufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const parts = new Array<string>(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		parts[i] = bytes[i].toString(16).padStart(2, "0");
	}
	return parts.join("");
}
