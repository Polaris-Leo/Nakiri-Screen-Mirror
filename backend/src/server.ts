import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isConnectionId } from "./protocol.js";
import { dispatchSocketMessage } from "./messageHandler.js";
import { SignallingHub } from "./signallingHub.js";
import { readSignallingConfig, type SignallingServerConfig } from "./turnConfig.js";
import { createTurnCredentials } from "./turnCredentials.js";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_REQUESTS = 30;
const RATE_LIMIT_BUCKET_CAP = 10_000;

interface RateLimitBucket {
	windowStartedAt: number;
	count: number;
}

function isValidTurnUrl(url: string): boolean {
	const match = /^turns?:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::(\d{1,5}))?(?:\?transport=(?:udp|tcp))?$/i.exec(url);
	if (!match) return false;
	const port = match[2] ? Number(match[2]) : undefined;
	return port === undefined || (port >= 1 && port <= 65535);
}

function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
	if (trustProxy) {
		const forwarded = request.headers["x-forwarded-for"];
		const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",", 1)[0];
		if (firstForwarded?.trim()) return firstForwarded.trim();
	}
	return request.socket.remoteAddress ?? "unknown";
}

export function createSignallingServer(config: SignallingServerConfig): Server {
	const hub = new SignallingHub();
	const rateLimitBuckets = new Map<string, RateLimitBucket>();
	let requestsSinceCleanup = 0;
	const httpServer = createServer((request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		} catch {
			response.writeHead(400).end("Bad request");
			return;
		}

		if (url.pathname === "/healthz") {
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-type": "application/json",
			});
			response.end(
				JSON.stringify({
					status: "ok",
					service: "nakiri-signalling",
					websocket: { path: "/connect", protocol: "websocket" },
				}),
			);
			return;
		}

		if (url.pathname !== "/api/turn-credentials") {
			response.writeHead(404).end("Not found");
			return;
		}

		const origin = request.headers.origin;
		const commonHeaders: Record<string, string> = {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
			vary: "Origin",
		};
		if (origin && config.allowedOrigins.includes(origin)) {
			commonHeaders["access-control-allow-origin"] = origin;
		}
		const respond = (status: number, body: unknown) => {
			response.writeHead(status, commonHeaders);
			response.end(JSON.stringify(body));
		};

		if (request.method !== "GET") {
			respond(405, { error: "Method not allowed" });
			return;
		}
		if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
			respond(403, { error: "Origin not allowed" });
			return;
		}
		if (
			!config.turnSecret ||
			config.turnUrls.length === 0 ||
			!config.turnUrls.every(isValidTurnUrl) ||
			!Number.isInteger(config.turnCredentialTtlSeconds) ||
			config.turnCredentialTtlSeconds < 1
		) {
			respond(503, { error: "TURN credentials unavailable" });
			return;
		}

		const now = Date.now();
		const address = clientAddress(request, config.trustProxy);
		requestsSinceCleanup += 1;
		if (requestsSinceCleanup >= 64) {
			requestsSinceCleanup = 0;
			for (const [bucketAddress, bucket] of rateLimitBuckets) {
				if (now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) rateLimitBuckets.delete(bucketAddress);
			}
		}
		let bucket = rateLimitBuckets.get(address);
		if (!bucket || now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
			bucket = { windowStartedAt: now, count: 0 };
			if (rateLimitBuckets.size >= RATE_LIMIT_BUCKET_CAP) {
				const oldestAddress = rateLimitBuckets.keys().next().value;
				if (oldestAddress !== undefined) rateLimitBuckets.delete(oldestAddress);
			}
			rateLimitBuckets.set(address, bucket);
		}
		if (bucket.count >= RATE_LIMIT_REQUESTS) {
			respond(429, { error: "Too many requests" });
			return;
		}
		bucket.count += 1;

		const credentials = createTurnCredentials(
			config.turnSecret,
			now,
			config.turnCredentialTtlSeconds,
			randomUUID(),
		);
		respond(200, {
			iceServers: [{ urls: config.turnUrls, username: credentials.username, credential: credentials.credential }],
			expiresAt: credentials.expiresAt,
		});
	});
	const webSocketServer = new WebSocketServer({
		noServer: true,
		maxPayload: 64 * 1024,
	});

	function rawDataToText(message: RawData): string {
		if (typeof message === "string") return message;
		if (Array.isArray(message)) return Buffer.concat(message).toString("utf8");
		if (message instanceof ArrayBuffer) {
			return Buffer.from(new Uint8Array(message)).toString("utf8");
		}
		return Buffer.from(message).toString("utf8");
	}

	httpServer.on("upgrade", (request, socket, head) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
		} catch {
			socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const id = url.searchParams.get("id");
		if (url.pathname !== "/connect" || !isConnectionId(id)) {
			socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}

		webSocketServer.handleUpgrade(request, socket, head, (client: WebSocket) => {
			hub.register(id, client);
			client.on("message", (message) =>
				dispatchSocketMessage(hub, client, rawDataToText(message)),
			);
			client.on("close", () => hub.unregister(client));
			client.on("error", () => hub.unregister(client));
		});
	});

	return httpServer;
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const server = createSignallingServer(readSignallingConfig());
	server.listen(port, host, () => {
		console.log(`Nakiri signalling server listening on ${host}:${port}`);
	});
}
