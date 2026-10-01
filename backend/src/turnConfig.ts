import { readFileSync } from "node:fs";

export interface SignallingServerConfig {
	turnSecret: string;
	turnUrls: string[];
	turnCredentialTtlSeconds: number;
	allowedOrigins: string[];
	trustProxy: boolean;
}

export type Environment = Record<string, string | undefined>;

/** Purely parses environment values and an already-read Docker secret. */
export function parseSignallingConfig(
	environment: Environment,
	turnSecret: string,
): SignallingServerConfig {
	const parsedTtl = Number(environment.TURN_CREDENTIAL_TTL_SECONDS ?? 3600);
	const turnCredentialTtlSeconds = Number.isInteger(parsedTtl) && parsedTtl > 0
		? Math.min(parsedTtl, 86400)
		: 3600;

	return {
		turnSecret: turnSecret.trim(),
		turnUrls: (environment.TURN_URLS ?? "").split(",").map((url) => url.trim()).filter(Boolean),
		turnCredentialTtlSeconds,
		allowedOrigins: (environment.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
		trustProxy: environment.TRUST_PROXY?.trim().toLowerCase() === "true",
	};
}

/** Reads and trims the mounted Docker secret once during server startup. */
export function readSignallingConfig(environment: Environment = process.env): SignallingServerConfig {
	let turnSecret = "";
	const secretFile = environment.TURN_SECRET_FILE?.trim() || "/run/secrets/turn_secret";
	try {
		turnSecret = readFileSync(secretFile, "utf8");
	} catch {
		// Missing Docker secret deliberately leaves credentials unavailable; never expose file errors.
	}
	return parseSignallingConfig(environment, turnSecret);
}
