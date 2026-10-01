export function buildProbeUrl(rawUrl: string, id: string): string {
	const url = new URL(rawUrl);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new Error("Probe URL must use ws:// or wss://");
	}
	url.searchParams.set("id", id);
	return url.toString();
}

export function createProbeMessage(to: string) {
	return {
		type: "offer" as const,
		to,
		data: { probe: true },
	};
}
