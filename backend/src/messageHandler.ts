import { isControlMessage } from "./protocol.js";
import type { SignallingHub, SocketLike } from "./signallingHub.js";

export function dispatchSocketMessage(
	hub: SignallingHub,
	socket: SocketLike,
	message: string,
): void {
	const controlMessage = isControlMessage(message);
	if (controlMessage === "ping") {
		socket.send("pong");
		return;
	}
	if (controlMessage === "pong") return;
	hub.handleMessage(socket, message);
}
