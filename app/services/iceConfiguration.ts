import { getTurnCredentialsUrl } from "~/config";

export { getTurnCredentialsUrl } from "~/config";

export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun1.l.google.com:19302" },
];

const FALLBACK_WARNING = "TURN credentials unavailable; using public STUN servers.";

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isValidUrls(value: unknown): value is string | string[] {
	return (
		isNonEmptyString(value) ||
		(Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString))
	);
}

export async function fetchIceConfiguration(
	signalingUrl: string,
	fetcher: typeof fetch = fetch,
): Promise<{ iceServers: RTCIceServer[]; warning?: string }> {
	try {
		const response = await fetcher(getTurnCredentialsUrl(signalingUrl));
		if (!response.ok) return { iceServers: FALLBACK_ICE_SERVERS, warning: FALLBACK_WARNING };

		const payload: unknown = await response.json();
		if (!payload || typeof payload !== "object" || !("iceServers" in payload)) {
			return { iceServers: FALLBACK_ICE_SERVERS, warning: FALLBACK_WARNING };
		}
		const rawServers = (payload as { iceServers?: unknown }).iceServers;
		if (!Array.isArray(rawServers) || rawServers.length === 0) {
			return { iceServers: FALLBACK_ICE_SERVERS, warning: FALLBACK_WARNING };
		}

		const iceServers: RTCIceServer[] = [];
		for (const raw of rawServers) {
			if (!raw || typeof raw !== "object") {
				return { iceServers: FALLBACK_ICE_SERVERS, warning: FALLBACK_WARNING };
			}
			const server = raw as Record<string, unknown>;
			if (
				!isValidUrls(server.urls) ||
				typeof server.username !== "string" ||
				typeof server.credential !== "string"
			) {
				return { iceServers: FALLBACK_ICE_SERVERS, warning: FALLBACK_WARNING };
			}
			iceServers.push({
				urls: server.urls,
				username: server.username,
				credential: server.credential,
			});
		}

		return { iceServers: [...FALLBACK_ICE_SERVERS, ...iceServers] };
	} catch {
		return { iceServers: FALLBACK_ICE_SERVERS, warning: FALLBACK_WARNING };
	}
}
