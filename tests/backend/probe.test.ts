import { describe, expect, it } from "vitest";
import { buildProbeUrl, createProbeMessage } from "../../backend/src/probeHelpers";

describe("WebSocket probe helpers", () => {
	it("adds a valid temporary connection id to the probe URL", () => {
		expect(buildProbeUrl("wss://example.com/connect", "123456")).toBe(
			"wss://example.com/connect?id=123456",
		);
		expect(buildProbeUrl("wss://example.com/connect?check=1", "654321")).toBe(
			"wss://example.com/connect?check=1&id=654321",
		);
	});

	it("creates a valid signalling message for the probe", () => {
		expect(createProbeMessage("654321")).toEqual({
			type: "offer",
			to: "654321",
			data: { probe: true },
		});
	});
});
