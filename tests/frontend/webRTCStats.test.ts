import { describe, expect, it } from "vitest";
import { normalizeWebRTCStats } from "../../app/services/webRTCStats";

function report(...stats: Record<string, unknown>[]) {
	return {
		forEach(callback: (value: unknown) => void) {
			for (const stat of stats) callback(stat);
		},
	} as unknown as RTCStatsReport;
}

describe("normalizeWebRTCStats", () => {
	it("extracts sender dimensions, frame rate, bytes, and bitrate", () => {
		expect(normalizeWebRTCStats(report({ id: "outbound", type: "outbound-rtp", kind: "video", frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, bytesSent: 5000, bitrate: 2_000_000 }), "sender")).toEqual({
			width: 1920, height: 1080, framesPerSecond: 60, bitrate: 2_000_000,
			bytesSent: 5000, bytesReceived: undefined, candidateType: undefined,
		});
	});

	it("extracts receiver stats and selected ICE candidate type", () => {
		const stats = report(
			{ id: "pair", type: "candidate-pair", selected: true, localCandidateId: "local" },
			{ id: "local", type: "local-candidate", candidateType: "srflx" },
			{ id: "inbound", type: "inbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, bytesReceived: 9000 },
		);
		expect(normalizeWebRTCStats(stats, "receiver")).toEqual({
			width: 1280, height: 720, framesPerSecond: 30, bitrate: undefined,
			bytesSent: undefined, bytesReceived: 9000, candidateType: "srflx",
		});
	});

	it("treats missing browser-specific stats as unavailable", () => {
		expect(normalizeWebRTCStats(report({ id: "video", type: "inbound-rtp", kind: "video" }), "receiver")).toEqual({
			width: undefined, height: undefined, framesPerSecond: undefined,
			bitrate: undefined, bytesSent: undefined, bytesReceived: undefined,
			candidateType: undefined,
		});
	});
});
