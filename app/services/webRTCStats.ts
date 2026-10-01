export interface WebRTCStats {
	width?: number;
	height?: number;
	framesPerSecond?: number;
	bitrate?: number;
	bytesSent?: number;
	bytesReceived?: number;
	candidateType?: string;
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
	};
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
