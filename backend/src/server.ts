import { createServer } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isConnectionId } from "./protocol.js";
import { SignallingHub } from "./signallingHub.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const hub = new SignallingHub();
const httpServer = createServer((request, response) => {
	if (request.url === "/healthz") {
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
	response.writeHead(404);
	response.end("Not found");
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
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	const id = url.searchParams.get("id");
	if (url.pathname !== "/connect" || !isConnectionId(id)) {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}

	webSocketServer.handleUpgrade(request, socket, head, (client: WebSocket) => {
		hub.register(id, client);
		client.on("message", (message) =>
			hub.handleMessage(client, rawDataToText(message)),
		);
		client.on("close", () => hub.unregister(client));
		client.on("error", () => hub.unregister(client));
	});
});

httpServer.listen(port, host, () => {
	console.log(`Nakiri signalling server listening on ${host}:${port}`);
});
