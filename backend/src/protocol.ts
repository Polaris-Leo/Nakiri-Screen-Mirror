export const MAX_MESSAGE_BYTES = 64 * 1024;
export const ALLOWED_MESSAGE_TYPES = new Set([
	"offer",
	"answer",
	"ice_candidate",
]);

export interface SignallingMessage {
	type: "offer" | "answer" | "ice_candidate";
	to: string;
	data: unknown;
}

export function isConnectionId(value: string | null): value is string {
	return typeof value === "string" && /^\d{6}$/.test(value);
}

export function parseSignallingMessage(
	message: string | Uint8Array,
): SignallingMessage | null {
	const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
	if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return null;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const candidate = parsed as Record<string, unknown>;
		if (
			typeof candidate.type !== "string" ||
			!ALLOWED_MESSAGE_TYPES.has(candidate.type) ||
			!isConnectionId(typeof candidate.to === "string" ? candidate.to : null) ||
			!("data" in candidate)
		) {
			return null;
		}

		return {
			type: candidate.type as SignallingMessage["type"],
			to: candidate.to as string,
			data: candidate.data,
		};
	} catch {
		return null;
	}
}
