import { describe, expect, it, vi } from "vitest";
import { dispatchSocketMessage } from "../../backend/src/messageHandler";
import { SignallingHub } from "../../backend/src/signallingHub";

describe("signaling socket message dispatch", () => {
	it("answers ping without closing the socket", () => {
		const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
		const hub = new SignallingHub();
		hub.register("123456", socket);

		dispatchSocketMessage(hub, socket, "ping");

		expect(socket.send).toHaveBeenCalledWith("pong");
		expect(socket.close).not.toHaveBeenCalled();
	});

	it("ignores pong and forwards signaling messages to the hub", () => {
		const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
		const hub = new SignallingHub();
		const handleMessage = vi.spyOn(hub, "handleMessage");
		hub.register("123456", socket);

		dispatchSocketMessage(hub, socket, "pong");
		expect(handleMessage).not.toHaveBeenCalled();

		const offer = JSON.stringify({ type: "offer", to: "654321", data: {} });
		dispatchSocketMessage(hub, socket, offer);
		expect(handleMessage).toHaveBeenCalledWith(socket, offer);
	});
});
