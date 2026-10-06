import { describe, expect, it, vi } from "vitest";
import {
	fetchIceConfiguration,
	getTurnCredentialsUrl,
} from "../../app/services/iceConfiguration";

const STUN_SERVERS: RTCIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun1.l.google.com:19302" },
];

describe("ICE configuration", () => {
	it("maps secure signaling URLs to the same HTTPS host credential endpoint", () => {
		expect(getTurnCredentialsUrl("wss://signal.example.com/connect")).toBe(
			"https://signal.example.com/api/turn-credentials",
		);
	});

	it("maps development signaling URLs to HTTP", () => {
		expect(getTurnCredentialsUrl("ws://localhost:3000/connect?room=abc")).toBe(
			"http://localhost:3000/api/turn-credentials",
		);
	});

	it("returns validated TURN servers with the existing STUN fallback", async () => {
		const turnServer = {
			urls: ["turn:turn.example.com:3478"],
			username: "temporary-user",
			credential: "temporary-password",
		};
		const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ iceServers: [turnServer] }) } as Response));

		await expect(fetchIceConfiguration("wss://signal.example.com/connect", fetcher)).resolves.toEqual({
			iceServers: [...STUN_SERVERS, turnServer],
		});
		expect(fetcher).toHaveBeenCalledWith("https://signal.example.com/api/turn-credentials");
	});

	it.each([
		["HTTP failure", async () => ({ ok: false, json: async () => ({ secret: "must not leak" }) } as Response)],
		["invalid JSON", async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } } as unknown as Response)],
		["empty URL arrays", async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: [] }] }) } as Response)],
	])("uses STUN and provides a warning for %s", async (_label, fetcher) => {
		const result = await fetchIceConfiguration("wss://signal.example.com/connect", fetcher as typeof fetch);

		expect(result.iceServers).toEqual(STUN_SERVERS);
		expect(result.warning).toBeTruthy();
		expect(result.warning).not.toContain("must not leak");
	});
});
