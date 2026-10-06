export interface WebRTCStats {
	width?: number;
	height?: number;
	framesPerSecond?: number;
	bitrate?: number;
	bytesSent?: number;
	bytesReceived?: number;
	candidateType?: string;
	rttMs?: number;
}

export function normalizeWebRTCStats(
	report: RTCStatsReport,
	role: "sender" | "receiver",
): WebRTCStats {
	const rows: Array<Record<string, unknown>> = [];
	report.forEach((stat) => rows.push(stat as unknown as Record<string, unknown>));
	const media = rows.find(
		(stat) =>
			stat.type === (role === "sender" ? "outbound-rtp" : "inbound-rtp") &&
			stat.kind === "video",
	);
	const selectedPair = rows.find(
		(stat) =>
			stat.type === "candidate-pair" &&
			(stat.selected === true ||
				(stat.state === "succeeded" && stat.nominated === true)),
	);
	const localCandidate = rows.find(
		(stat) =>
			stat.type === "local-candidate" &&
			stat.id === selectedPair?.localCandidateId,
	);
	// Resolve the selected pair's remote candidate too, but never expose its
	// address, port, or raw stats in the normalized diagnostics.
	const remoteCandidate = rows.find(
		(stat) =>
			stat.type === "remote-candidate" &&
			stat.id === selectedPair?.remoteCandidateId,
	);
	// RTT is a selected-pair metric and remains useful even if the remote row
	// is missing; path classification requires resolving both candidate rows.
	const rttSeconds = numberOrUndefined(selectedPair?.currentRoundTripTime);
	const rttMs = rttSeconds === undefined ? undefined : numberOrUndefined(rttSeconds * 1000);

	return {
		width: numberOrUndefined(media?.frameWidth),
		height: numberOrUndefined(media?.frameHeight),
		framesPerSecond: numberOrUndefined(media?.framesPerSecond),
		bitrate: numberOrUndefined(media?.bitrate ?? media?.targetBitrate),
		bytesSent: numberOrUndefined(media?.bytesSent),
		bytesReceived: numberOrUndefined(media?.bytesReceived),
		candidateType: selectedPairPathType(localCandidate?.candidateType, remoteCandidate?.candidateType),
		rttMs,
	};
}

function selectedPairPathType(localType: unknown, remoteType: unknown): string | undefined {
	const directTypes = new Set(["host", "srflx", "prflx"]);
	if (localType === "relay" || remoteType === "relay") return "relay";
	if (typeof localType !== "string" || typeof remoteType !== "string") return undefined;
	if (!directTypes.has(localType) || !directTypes.has(remoteType)) return undefined;
	return localType;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
