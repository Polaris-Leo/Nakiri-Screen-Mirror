const DEFAULT_SIGNALING_URL = "wss://signaling.pexni.com/connect";

export function getSignalingBaseUrl(): string {
	return import.meta.env.VITE_SIGNALING_URL?.trim() || DEFAULT_SIGNALING_URL;
}

export function getTurnCredentialsUrl(signalingUrl: string): string {
	const url = new URL(signalingUrl);
	if (url.protocol === "wss:") url.protocol = "https:";
	else if (url.protocol === "ws:") url.protocol = "http:";
	else throw new Error("Unsupported signaling URL protocol");
	url.pathname = "/api/turn-credentials";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function buildSignalingUrl(
	roomId: string,
	baseUrl = getSignalingBaseUrl(),
): string {
	const url = new URL(baseUrl);
	url.searchParams.set("id", roomId);
	return url.toString();
}

export function resolveRoomId(
	currentId: string,
	createId: () => string,
	setId: (id: string) => void,
): string {
	if (currentId) return currentId;
	const nextId = createId();
	setId(nextId);
	return nextId;
}
