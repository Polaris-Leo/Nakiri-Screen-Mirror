import WebSocket from "ws";
import { pathToFileURL } from "node:url";
import { buildProbeUrl, createProbeMessage } from "./probeHelpers.js";

const PROBE_TIMEOUT_MS = 8_000;

function createConnectionId(): string {
	return String(Math.floor(100_000 + Math.random() * 900_000));
}

function openSocket(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		const timeout = setTimeout(() => {
			socket.terminate();
			reject(new Error(`WebSocket connection timed out after ${PROBE_TIMEOUT_MS}ms`));
		}, PROBE_TIMEOUT_MS);

		socket.once("open", () => {
			clearTimeout(timeout);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.removeAllListeners("message");
			reject(new Error(`No signalling message received within ${PROBE_TIMEOUT_MS}ms`));
		}, PROBE_TIMEOUT_MS);

		socket.once("message", (data) => {
			clearTimeout(timeout);
			try {
				const parsed: unknown = JSON.parse(data.toString());
				if (!parsed || typeof parsed !== "object") {
					throw new Error("Received non-object signalling message");
				}
				resolve(parsed as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
	});
}

export async function runProbe(rawUrl: string): Promise<void> {
	const senderId = createConnectionId();
	let receiverId = createConnectionId();
	while (receiverId === senderId) receiverId = createConnectionId();

	const sender = await openSocket(buildProbeUrl(rawUrl, senderId));
	const receiver = await openSocket(buildProbeUrl(rawUrl, receiverId));

	try {
		receiver.send(JSON.stringify(createProbeMessage(senderId)));
		const message = await waitForMessage(sender);
		if (
			message.type !== "offer" ||
			message.from !== receiverId ||
			message.to !== senderId
		) {
			throw new Error(`Unexpected signalling response: ${JSON.stringify(message)}`);
		}
	} finally {
		sender.close();
		receiver.close();
	}
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entrypointUrl) {
	const targetUrl = process.argv[2] ?? process.env.WSS_URL;
	if (!targetUrl) {
		console.error("Usage: node dist/probe.js wss://host/connect");
		process.exit(2);
	}

	runProbe(targetUrl)
		.then(() => console.log(`WebSocket signalling probe passed: ${targetUrl}`))
		.catch((error: unknown) => {
			console.error(
				`WebSocket signalling probe failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		});
}
