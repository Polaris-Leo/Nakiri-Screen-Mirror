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
	void remoteCandidate;
	const rttSeconds = numberOrUndefined(selectedPair?.currentRoundTripTime);
	const rttMs = rttSeconds === undefined ? undefined : numberOrUndefined(rttSeconds * 1000);

	return {
		width: numberOrUndefined(media?.frameWidth),
		height: numberOrUndefined(media?.frameHeight),
		framesPerSecond: numberOrUndefined(media?.framesPerSecond),
		bitrate: numberOrUndefined(media?.bitrate ?? media?.targetBitrate),
		bytesSent: numberOrUndefined(media?.bytesSent),
		bytesReceived: numberOrUndefined(media?.bytesReceived),
		candidateType:
			typeof localCandidate?.candidateType === "string"
				? localCandidate.candidateType
				: undefined,
		rttMs,
	};
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
