import { parseSignallingMessage, type SignallingMessage } from "./protocol.js";

export interface SocketLike {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export const SOCKET_OPEN = 1;

export class SignallingHub {
	private readonly idsBySocket = new Map<SocketLike, string>();
	private readonly socketsById = new Map<string, Set<SocketLike>>();

	register(id: string, socket: SocketLike) {
		this.unregister(socket);
		this.idsBySocket.set(socket, id);
		const sockets = this.socketsById.get(id) ?? new Set<SocketLike>();
		sockets.add(socket);
		this.socketsById.set(id, sockets);
	}

	unregister(socket: SocketLike) {
		const id = this.idsBySocket.get(socket);
		if (!id) return;
		this.idsBySocket.delete(socket);
		const sockets = this.socketsById.get(id);
		if (!sockets) return;
		sockets.delete(socket);
		if (sockets.size === 0) this.socketsById.delete(id);
	}

	handleMessage(socket: SocketLike, raw: string | Uint8Array) {
		const message = parseSignallingMessage(raw);
		const senderId = this.idsBySocket.get(socket);
		if (!message || !senderId) {
			socket.close(1008, "Invalid signalling message");
			return;
		}

		const outgoing = JSON.stringify({
			...message,
			from: senderId,
		} satisfies SignallingMessage & { from: string });
		for (const target of this.socketsById.get(message.to) ?? []) {
			if (target.readyState === SOCKET_OPEN) target.send(outgoing);
		}
	}
}
