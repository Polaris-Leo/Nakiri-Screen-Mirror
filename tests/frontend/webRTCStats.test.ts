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
			rttMs: undefined,
		});
	});

	it("extracts the selected pair's direct candidate type and converts RTT to milliseconds", () => {
		const stats = report(
			{ id: "pair", type: "candidate-pair", selected: true, localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.125 },
			{ id: "local", type: "local-candidate", candidateType: "host", address: "192.0.2.1", port: 1234 },
			{ id: "remote", type: "remote-candidate", candidateType: "srflx", address: "198.51.100.2", port: 5678 },
			{ id: "inbound", type: "inbound-rtp", kind: "video", frameWidth: 1280, frameHeight: 720, framesPerSecond: 30, bytesReceived: 9000 },
		);
		expect(normalizeWebRTCStats(stats, "receiver")).toEqual({
			width: 1280, height: 720, framesPerSecond: 30, bitrate: undefined,
			bytesSent: undefined, bytesReceived: 9000, candidateType: "host", rttMs: 125,
		});
	});

	it("extracts a nominated relay candidate and its selected-pair RTT", () => {
		const stats = report(
			{ id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "relay-local", remoteCandidateId: "remote", currentRoundTripTime: 0.04 },
			{ id: "relay-local", type: "local-candidate", candidateType: "relay" },
			{ id: "remote", type: "remote-candidate", candidateType: "host" },
		);
		expect(normalizeWebRTCStats(stats, "receiver")).toMatchObject({ candidateType: "relay", rttMs: 40 });
	});

	it("ignores unselected candidate and pair records", () => {
		const stats = report(
			{ id: "pair", type: "candidate-pair", state: "succeeded", nominated: false, localCandidateId: "local", currentRoundTripTime: 0.5 },
			{ id: "local", type: "local-candidate", candidateType: "relay" },
		);
		expect(normalizeWebRTCStats(stats, "receiver")).toMatchObject({ candidateType: undefined, rttMs: undefined });
	});

	it("treats missing selected-pair and candidate records as unavailable", () => {
		expect(normalizeWebRTCStats(report({ id: "video", type: "inbound-rtp", kind: "video" }), "receiver")).toEqual({
			width: undefined, height: undefined, framesPerSecond: undefined,
			bitrate: undefined, bytesSent: undefined, bytesReceived: undefined,
			candidateType: undefined, rttMs: undefined,
		});
		expect(normalizeWebRTCStats(report(
			{ id: "pair", type: "candidate-pair", selected: true, localCandidateId: "missing", remoteCandidateId: "missing", currentRoundTripTime: 0.1 },
		), "receiver")).toMatchObject({ candidateType: undefined, rttMs: 100 });
	});

	it("requires the referenced remote candidate for path classification but preserves pair RTT", () => {
		const normalized = normalizeWebRTCStats(report(
			{ id: "pair", type: "candidate-pair", selected: true, localCandidateId: "local", remoteCandidateId: "missing-remote", currentRoundTripTime: 0.075 },
			{ id: "local", type: "local-candidate", candidateType: "host", address: "192.0.2.1", port: 1234 },
		), "receiver");

		expect(normalized).toEqual({
			width: undefined, height: undefined, framesPerSecond: undefined,
			bitrate: undefined, bytesSent: undefined, bytesReceived: undefined,
			candidateType: undefined, rttMs: 75,
		});
		expect(JSON.stringify(normalized)).not.toMatch(/address|port|remote-candidate|192\.0\.2\.1/);
	});

	it("ignores malformed optional RTT and media numeric values", () => {
		const stats = report(
			{ id: "pair", type: "candidate-pair", selected: true, localCandidateId: "local", currentRoundTripTime: "0.2" },
			{ id: "local", type: "local-candidate", candidateType: "host" },
			{ id: "video", type: "inbound-rtp", kind: "video", frameWidth: "1280", frameHeight: Number.NaN, framesPerSecond: Infinity, bytesReceived: "10" },
		);
		expect(normalizeWebRTCStats(stats, "receiver")).toEqual({
			width: undefined, height: undefined, framesPerSecond: undefined,
			bitrate: undefined, bytesSent: undefined, bytesReceived: undefined,
			candidateType: "host", rttMs: undefined,
		});
	});
});
