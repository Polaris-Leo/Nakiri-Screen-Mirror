import { isRoomId } from "./signallingProtocol";

interface SignallingEnvironment {
	SIGNALLING_SERVER: {
		idFromName(name: string): unknown;
		get(id: unknown): { fetch(request: Request): Promise<Response> };
	};
}

function corsHeaders(origin: string): Headers {
	return new Headers({
		"Access-Control-Allow-Origin": origin,
		"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Max-Age": "86400",
	});
}

export default {
	async fetch(
		request: Request,
		env: SignallingEnvironment,
		_ctx: unknown,
	): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") {
			const origin = request.headers.get("Origin") || "*";
			return new Response(null, {
				status: 204,
				headers: corsHeaders(origin),
			});
		}

		if (url.pathname !== "/connect") {
			return new Response("Not found", { status: 404 });
		}

		const roomId = url.searchParams.get("id");
		if (!isRoomId(roomId)) {
			return new Response("Invalid id", { status: 400 });
		}

		const durableObjectId = env.SIGNALLING_SERVER.idFromName(roomId);
		const stub = env.SIGNALLING_SERVER.get(durableObjectId);
		return stub.fetch(request);
	},
};
