export const MAX_MESSAGE_BYTES = 64 * 1024;

export const SIGNALLING_MESSAGE_TYPES = [
	"offer",
	"answer",
	"ice_candidate",
] as const;

export type SignallingMessageType = (typeof SIGNALLING_MESSAGE_TYPES)[number];

export interface SignallingMessage {
	type: SignallingMessageType;
	to: string;
	data: unknown;
	from?: string;
}

export function isRoomId(value: string | null): value is string {
	return typeof value === "string" && /^\d{6}$/.test(value);
}

export function parseSignallingMessage(
	message: string | ArrayBuffer,
): SignallingMessage | null {
	const raw = typeof message === "string" ? message : new TextDecoder().decode(message);

	if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(raw);

		if (!parsed || typeof parsed !== "object") {
			return null;
		}

		const candidate = parsed as Record<string, unknown>;
		if (
			typeof candidate.type !== "string" ||
			!SIGNALLING_MESSAGE_TYPES.includes(
				candidate.type as SignallingMessageType,
			) ||
			typeof candidate.to !== "string" ||
			!isRoomId(candidate.to) ||
			!("data" in candidate)
		) {
			return null;
		}

		return {
			type: candidate.type as SignallingMessageType,
			to: candidate.to,
			data: candidate.data,
		};
	} catch {
		return null;
	}
}
