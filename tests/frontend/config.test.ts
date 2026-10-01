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

	it("defaults to the EdgeOne-proxied Docker signaling URL", () => {
		vi.stubEnv("VITE_SIGNALING_URL", "");
		const url = getSignalingBaseUrl();

		expect(url).toBe("wss://signaling-server.unia.love/connect");
		expect(url).not.toMatch(/workers\.dev|cloudflare|signaling\.pexni\.com/i);
	});

	it("appends the room id once and preserves existing query parameters", () => {
		expect(
			buildSignalingUrl(
				"123456",
				"wss://signaling-server.unia.love/connect?tenant=prod&id=old",
			),
		).toBe("wss://signaling-server.unia.love/connect?tenant=prod&id=123456");
	});

	it("uses the newly generated room id on the first page load", () => {
		const setId = vi.fn();
		const roomId = resolveRoomId("", () => "123456", setId);

		expect(roomId).toBe("123456");
		expect(setId).toHaveBeenCalledWith("123456");
	});
});
