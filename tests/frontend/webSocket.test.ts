import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { webSocketService } from "../../app/services/webSocket";

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((error: unknown) => void) | null = null;
	onmessage: ((message: { data: string }) => void) | null = null;
	send = vi.fn();
	close = vi.fn(() => {
		this.readyState = FakeWebSocket.CLOSED;
	});

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	open() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}

	closeEvent() {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.();
	}
}

describe("WebSocketService lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.instances = [];
		(globalThis as any).WebSocket = FakeWebSocket;
		(globalThis as any).window = globalThis;
		webSocketService.disconnect();
	});

	afterEach(() => {
		webSocketService.disconnect();
		vi.useRealTimers();
	});

	it("does not reconnect after a manual disconnect", () => {
		webSocketService.connect("wss://example.test/connect?id=123456");
		const socket = FakeWebSocket.instances[0];
		socket.open();

		webSocketService.disconnect();
		socket.closeEvent();
		vi.runAllTimers();

		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	it("ignores close events from a stale socket", () => {
		webSocketService.connect("wss://example.test/connect?id=123456");
		const staleSocket = FakeWebSocket.instances[0];
		webSocketService.connect("wss://example.test/connect?id=654321");
		const currentSocket = FakeWebSocket.instances[1];

		staleSocket.closeEvent();
		vi.runAllTimers();

		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(currentSocket.url).toContain("654321");
	});

	it("sends messages only after the socket is open", () => {
		webSocketService.connect("wss://example.test/connect?id=123456");
		const socket = FakeWebSocket.instances[0];

		webSocketService.sendMessage({ type: "offer", to: "654321", data: {} });
		expect(socket.send).not.toHaveBeenCalled();

		socket.open();
		webSocketService.sendMessage({ type: "offer", to: "654321", data: {} });
		expect(socket.send).toHaveBeenCalledTimes(1);
	});
});
