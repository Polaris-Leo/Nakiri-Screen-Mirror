const DEFAULT_SIGNALING_URL = "wss://signaling.pexni.com/connect";

export function getSignalingBaseUrl(): string {
	return import.meta.env.VITE_SIGNALING_URL?.trim() || DEFAULT_SIGNALING_URL;
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
