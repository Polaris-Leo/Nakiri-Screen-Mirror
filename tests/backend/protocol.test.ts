import { describe, expect, it } from "vitest";
import { isControlMessage } from "../../backend/src/protocol";

describe("WebSocket control messages", () => {
	it("recognizes ping and pong without treating signaling payloads as control", () => {
		expect(isControlMessage("ping")).toBe("ping");
		expect(isControlMessage(new TextEncoder().encode("pong"))).toBe("pong");
		expect(isControlMessage("{\"type\":\"offer\"}")).toBeNull();
		expect(isControlMessage("other")).toBeNull();
	});
});
