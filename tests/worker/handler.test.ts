import { describe, expect, it, vi } from "vitest";
import handler from "../../worker/src/handler";

describe("Worker room routing", () => {
	it("selects the Durable Object using the requested room id", async () => {
		const stub = { fetch: vi.fn(async () => new Response("ok")) };
		const env = {
			SIGNALLING_SERVER: {
				idFromName: vi.fn(() => "room-object"),
				get: vi.fn(() => stub),
			},
		};

		const response = await handler.fetch(
			new Request("https://example.test/connect?id=123456"),
			env as never,
			{} as never,
		);

		expect(response.status).toBe(200);
		expect(env.SIGNALLING_SERVER.idFromName).toHaveBeenCalledWith("123456");
		expect(stub.fetch).toHaveBeenCalledOnce();
	});

	it("rejects a missing or malformed room id before touching Durable Objects", async () => {
		const idFromName = vi.fn();
		const env = { SIGNALLING_SERVER: { idFromName, get: vi.fn() } };

		const response = await handler.fetch(
			new Request("https://example.test/connect?id=abc"),
			env as never,
			{} as never,
		);

		expect(response.status).toBe(400);
		expect(idFromName).not.toHaveBeenCalled();
	});
});
