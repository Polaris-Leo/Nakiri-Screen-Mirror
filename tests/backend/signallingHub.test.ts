import { describe, expect, it, vi } from "vitest";
import { SignallingHub } from "../../backend/src/signallingHub";

const OPEN = 1;

function socket() {
	return {
		readyState: OPEN,
		send: vi.fn(),
		close: vi.fn(),
	};
}

describe("SignallingHub", () => {
	it("routes a valid message to the target connection id", () => {
		const hub = new SignallingHub();
		const sender = socket();
		const target = socket();
		hub.register("111111", sender);
		hub.register("222222", target);

		hub.handleMessage(
			sender,
			JSON.stringify({ type: "offer", to: "222222", data: { sdp: "v=0" } }),
		);

		expect(JSON.parse(target.send.mock.calls[0][0])).toEqual({
				type: "offer",
				to: "222222",
				from: "111111",
				data: { sdp: "v=0" },
		});
	});

	it("rejects malformed messages without broadcasting", () => {
		const hub = new SignallingHub();
		const sender = socket();
		const target = socket();
		hub.register("111111", sender);
		hub.register("222222", target);

		hub.handleMessage(sender, "not-json");

		expect(target.send).not.toHaveBeenCalled();
		expect(sender.close).toHaveBeenCalledWith(1008, "Invalid signalling message");
	});

	it("removes closed connections from routing", () => {
		const hub = new SignallingHub();
		const sender = socket();
		const target = socket();
		hub.register("111111", sender);
		hub.register("222222", target);
		hub.unregister(target);

		hub.handleMessage(
			sender,
			JSON.stringify({ type: "offer", to: "222222", data: {} }),
		);

		expect(target.send).not.toHaveBeenCalled();
	});
});
