import { describe, expect, it } from "vitest";
import {
	isRoomId,
	parseSignallingMessage,
	type SignallingMessage,
} from "../../worker/src/signallingProtocol";

describe("signalling protocol", () => {
	it("accepts only six digit room ids", () => {
		expect(isRoomId("123456")).toBe(true);
		expect(isRoomId("12345")).toBe(false);
		expect(isRoomId("1234567")).toBe(false);
		expect(isRoomId("abcdef")).toBe(false);
		expect(isRoomId(null)).toBe(false);
	});

	it("parses a valid signalling message", () => {
		const message = parseSignallingMessage(
			JSON.stringify({
				type: "offer",
				to: "123456",
				from: "attacker",
				data: { type: "offer", sdp: "v=0" },
			}),
		);

		expect(message).toEqual({
			type: "offer",
			to: "123456",
			data: { type: "offer", sdp: "v=0" },
		});
		expect((message as SignallingMessage).from).toBeUndefined();
	});

	it.each([
		"not-json",
		JSON.stringify({ type: "unknown", to: "123456", data: {} }),
		JSON.stringify({ type: "offer", to: "abc123", data: {} }),
		JSON.stringify({ type: "offer", to: "123456" }),
	])("rejects malformed signalling message: %s", (raw) => {
		expect(parseSignallingMessage(raw)).toBeNull();
	});

	it("rejects messages over 64 KiB", () => {
		const raw = JSON.stringify({
			type: "offer",
			to: "123456",
			data: "x".repeat(64 * 1024),
		});

		expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(64 * 1024);
		expect(parseSignallingMessage(raw)).toBeNull();
	});
});
