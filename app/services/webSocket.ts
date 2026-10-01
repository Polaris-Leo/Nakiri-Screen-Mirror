import { useWebSocketStore, type WebSocketState } from "~/stores/webSocket";

interface WebSocketMessage<T = unknown> {
	type: string;
	to: string;
	data: T;
}

export function getReconnectDelay(attempt: number, randomValue = Math.random()): number {
	const baseDelay = Math.min(1000 * 2 ** attempt, 24_000);
	const jitter = Math.floor(
		baseDelay * 0.25 * Math.min(1, Math.max(0, randomValue)),
	);
	return Math.min(baseDelay + jitter, 30_000);
}

class WebSocketService {
	private static instance: WebSocketService;
	private ws: WebSocket | null = null;
	private url: string | null = null;
	private reconnectAttempts = 0;
	private connectionGeneration = 0;
	private manualClose = false;
	private readonly maxReconnectInterval = 30_000;
	private heartbeatInterval: number | null = null;
	private reconnectTimeout: number | null = null;
	private heartbeatTimeout: number | null = null;
	private readonly HEARTBEAT_INTERVAL = 15000;
	private readonly HEARTBEAT_TIMEOUT = 5000;
	private messageHandlers: Map<string, (data: unknown) => void> = new Map();

	private constructor() {}

	static getInstance(): WebSocketService {
		if (!WebSocketService.instance) {
			WebSocketService.instance = new WebSocketService();
		}
		return WebSocketService.instance;
	}

	private startHeartbeat() {
		this.stopHeartbeat();
		this.heartbeatInterval = window.setInterval(() => {
			const socket = this.ws;
			if (!socket || socket.readyState !== WebSocket.OPEN) return;

			socket.send("ping");
			this.heartbeatTimeout = window.setTimeout(() => {
				if (this.ws === socket) socket.close();
			}, this.HEARTBEAT_TIMEOUT);
		}, this.HEARTBEAT_INTERVAL);
	}

	private stopHeartbeat() {
		if (this.heartbeatInterval !== null) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
		if (this.heartbeatTimeout !== null) {
			clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = null;
		}
	}

	private scheduleReconnect() {
		if (this.manualClose || !this.url) return;
		if (this.reconnectTimeout !== null) return;

		const backoffTime = Math.min(
			getReconnectDelay(this.reconnectAttempts),
			this.maxReconnectInterval,
		);
		this.updateState("reconnecting");

		const generation = this.connectionGeneration;
		this.reconnectTimeout = window.setTimeout(() => {
			this.reconnectTimeout = null;
			if (generation !== this.connectionGeneration || this.manualClose) return;
			this.reconnectAttempts++;
			useWebSocketStore.getState().updateDiagnostics({
				reconnectAttempts: this.reconnectAttempts,
			});
			this.reconnect();
		}, backoffTime);
	}

	private updateState(status: WebSocketState) {
		useWebSocketStore.getState().setWebSocketState(status);
	}

	connect(url: string) {
		const socket = this.ws;
		if (
			socket &&
			(socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) &&
			this.url === url
		) {
			this.manualClose = false;
			useWebSocketStore.getState().updateDiagnostics({ currentUrl: url });
			if (socket.readyState === WebSocket.OPEN) {
				this.updateState("connected");
			}
			return socket;
		}

		const previousUrl = this.url;
		this.url = url;
		this.manualClose = false;
		this.connectionGeneration += 1;
		const generation = this.connectionGeneration;

		if (this.reconnectTimeout !== null) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		useWebSocketStore.getState().updateDiagnostics({ currentUrl: url });

		this.stopHeartbeat();
		this.ws?.close();

		const socket = new WebSocket(url);
		this.ws = socket;
		this.updateState("connecting");

		socket.onopen = () => {
			if (generation !== this.connectionGeneration || this.ws !== socket) return;
			this.reconnectAttempts = 0;
			useWebSocketStore.getState().updateDiagnostics({
				reconnectAttempts: 0,
				lastError: null,
				lastConnectedAt: Date.now(),
			});
			this.updateState("connected");
			this.startHeartbeat();
		};

		socket.onclose = () => {
			if (generation !== this.connectionGeneration || this.ws !== socket) return;
			useWebSocketStore.getState().updateDiagnostics({ lastDisconnectedAt: Date.now() });
			this.stopHeartbeat();
			this.scheduleReconnect();
		};

		socket.onerror = (error) => {
			if (generation !== this.connectionGeneration || this.ws !== socket) return;
			useWebSocketStore.getState().updateDiagnostics({
				lastError:
					error instanceof Error
						? error.message
						: "WebSocket connection error",
			});
		};

		socket.onmessage = (msg) => {
			if (generation !== this.connectionGeneration || this.ws !== socket) return;
			if (msg.data === "pong") {
				if (this.heartbeatTimeout !== null) {
					clearTimeout(this.heartbeatTimeout);
					this.heartbeatTimeout = null;
				}
				return;
			}
			if (msg.data === "ping") {
				socket.send("pong");
				return;
			}

			try {
				const data = JSON.parse(msg.data) as { type?: string };
				if (data.type) this.messageHandlers.get(data.type)?.(data);
			} catch (error) {
				console.error("Failed to parse message:", error);
			}
		};

		return socket;
	}

	reconnect() {
		if (!this.url) return;
		this.manualClose = false;
		if (this.ws?.readyState === WebSocket.OPEN) return;
		this.connect(this.url);
	}

	disconnect() {
		this.manualClose = true;
		this.connectionGeneration += 1;
		this.stopHeartbeat();
		if (this.reconnectTimeout !== null) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		this.ws?.close();
		this.ws = null;
		this.url = null;
		this.reconnectAttempts = 0;
		useWebSocketStore.getState().updateDiagnostics({
			reconnectAttempts: 0,
			currentUrl: null,
		});
		this.updateState("disconnected");
	}

	sendMessage<T>(msg: WebSocketMessage<T>): boolean {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify(msg));
		return true;
	}

	registerHandler(type: string, handler: (data: unknown) => void) {
		this.messageHandlers.set(type, handler);
	}

	isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	isConnecting(): boolean {
		return this.ws?.readyState === WebSocket.CONNECTING;
	}
}

export const webSocketService = WebSocketService.getInstance();
