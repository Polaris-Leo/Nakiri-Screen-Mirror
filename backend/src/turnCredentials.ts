import { createHmac } from "node:crypto";

export interface TurnCredentials {
	username: string;
	credential: string;
	expiresAt: number;
}

export function createTurnCredentials(
	secret: string,
	nowMs: number,
	ttlSeconds: number,
	subject: string,
): TurnCredentials {
	if (secret.length === 0) {
		throw new Error("TURN secret must not be empty");
	}
	if (subject.length === 0) {
		throw new Error("TURN subject must not be empty");
	}
	if (!Number.isFinite(nowMs)) {
		throw new Error("Current time must be finite");
	}
	if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
		throw new Error("TURN credential TTL must be a positive finite number");
	}

	const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
	const username = `${expiresAt}:${subject}`;
	const credential = createHmac("sha1", secret).update(username, "utf8").digest("base64");

	return { username, credential, expiresAt };
}
