import { describe, expect, it, vi } from "vitest";
import {
	buildSignalingUrl,
	getSignalingBaseUrl,
	resolveRoomId,
} from "../../app/config";

describe("frontend configuration", () => {
	it("uses the configured signaling URL", () => {
		vi.stubEnv("VITE_SIGNALING_URL", "wss://signal.example.com/connect");
		expect(getSignalingBaseUrl()).toBe("wss://signal.example.com/connect");
	});

	it("falls back to the existing signaling URL", () => {
		vi.stubEnv("VITE_SIGNALING_URL", "");
		expect(getSignalingBaseUrl()).toBe(
			"wss://signaling.pexni.com/connect",
		);
	});

	it("appends the room id without duplicating query separators", () => {
		expect(buildSignalingUrl("123456", "wss://signal.example.com/connect")).toBe(
			"wss://signal.example.com/connect?id=123456",
		);
		expect(
			buildSignalingUrl("123456", "wss://signal.example.com/connect?tenant=prod"),
		).toBe("wss://signal.example.com/connect?tenant=prod&id=123456");
	});

	it("uses the newly generated room id on the first page load", () => {
		const setId = vi.fn();
		const roomId = resolveRoomId("", () => "123456", setId);

		expect(roomId).toBe("123456");
		expect(setId).toHaveBeenCalledWith("123456");
	});
});
