import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createSignallingServer } from "../../backend/src/server";

const servers: Server[] = [];

async function startServer(config: Parameters<typeof createSignallingServer>[0]) {
	const server = createSignallingServer(config);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
		),
	);
});

describe("GET /api/turn-credentials", () => {
	const validConfig = {
		turnSecret: "server-only-test-secret",
		turnUrls: ["turn:turn.example.test:3478", "turns:turn.example.test:5349"],
		turnCredentialTtlSeconds: 600,
		allowedOrigins: ["https://mirror.example.test"],
		trustProxy: false,
	};

	it("returns only fresh temporary ICE credentials with no-store caching", async () => {
		const baseUrl = await startServer(validConfig);
		const response = await fetch(`${baseUrl}/api/turn-credentials`, {
			headers: { origin: "https://mirror.example.test" },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = await response.json();
		expect(Object.keys(body).sort()).toEqual(["expiresAt", "iceServers"]);
		expect(body.iceServers).toHaveLength(1);
		expect(Object.keys(body.iceServers[0]).sort()).toEqual(["credential", "username", "urls"]);
		expect(body.iceServers[0].urls).toEqual(validConfig.turnUrls);
		expect(typeof body.iceServers[0].username).toBe("string");
		expect(body.iceServers[0].username).toMatch(/^\d+:[0-9a-f-]{36}$/);
		expect(typeof body.iceServers[0].credential).toBe("string");
		expect(body.iceServers[0].credential).not.toContain(validConfig.turnSecret);
		expect(body).not.toHaveProperty("secret");
		expect(body.expiresAt).toBe(Number(body.iceServers[0].username.split(":", 1)[0]));
	});

	it("returns 503 when the shared secret is absent", async () => {
		const baseUrl = await startServer({ ...validConfig, turnSecret: "" });
		const response = await fetch(`${baseUrl}/api/turn-credentials`);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(validConfig.turnSecret);
	});

	it("returns 503 when TURN URLs are malformed", async () => {
		const baseUrl = await startServer({ ...validConfig, turnUrls: ["http://not-a-turn-server"] });
		const response = await fetch(`${baseUrl}/api/turn-credentials`);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(validConfig.turnSecret);
	});

	it.each(["turn:foo..bar", "turn:.foo", "turn:foo."])(
		"returns 503 for TURN hosts with empty DNS labels (%s)",
		async (turnUrl) => {
			const baseUrl = await startServer({ ...validConfig, turnUrls: [turnUrl] });
			const response = await fetch(`${baseUrl}/api/turn-credentials`);
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain(validConfig.turnSecret);
		},
	);

	it("rejects non-GET methods", async () => {
		const baseUrl = await startServer(validConfig);
		const response = await fetch(`${baseUrl}/api/turn-credentials`, { method: "POST" });
		expect(response.status).toBe(405);
	});

	it("rejects a disallowed browser origin", async () => {
		const baseUrl = await startServer(validConfig);
		const response = await fetch(`${baseUrl}/api/turn-credentials`, {
			headers: { origin: "https://attacker.example" },
		});
		expect(response.status).toBe(403);
	});

	it("rate limits a client after 30 credential requests in the fixed window", async () => {
		const baseUrl = await startServer(validConfig);
		for (let requestNumber = 0; requestNumber < 30; requestNumber += 1) {
			const response = await fetch(`${baseUrl}/api/turn-credentials`);
			expect(response.status).toBe(200);
		}
		const limitedResponse = await fetch(`${baseUrl}/api/turn-credentials`);
		expect(limitedResponse.status).toBe(429);
	});
});
