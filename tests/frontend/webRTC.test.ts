import { beforeEach, describe, expect, it, vi } from "vitest";
import { webRTCService } from "../../app/services/webRTC";

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	connectionState: RTCPeerConnectionState = "new";
	remoteDescription: RTCSessionDescriptionInit | null = null;
	onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
	ontrack: ((event: RTCTrackEvent) => void) | null = null;
	onnegotiationneeded: (() => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	onicecandidateerror: ((event: RTCPeerConnectionIceErrorEvent) => void) | null = null;
	addIceCandidate = vi.fn(async () => undefined);
	close = vi.fn(() => {
		this.connectionState = "closed";
	});
	setRemoteDescription = vi.fn(async (description: RTCSessionDescriptionInit) => {
		this.remoteDescription = description;
	});
	setLocalDescription = vi.fn(async () => undefined);
	createAnswer = vi.fn(async () => ({ type: "answer" as const, sdp: "answer" }));
	createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "offer" }));

	constructor() {
		FakePeerConnection.instances.push(this);
	}
}

class FakeIceCandidate {
	constructor(readonly candidate: RTCIceCandidateInit) {}
}

class FakeSessionDescription {
	constructor(readonly description: RTCSessionDescriptionInit) {}
}

describe("WebRTCService lifecycle", () => {
	beforeEach(() => {
		FakePeerConnection.instances = [];
		(globalThis as any).RTCPeerConnection = FakePeerConnection;
		(globalThis as any).RTCIceCandidate = FakeIceCandidate;
		(globalThis as any).RTCSessionDescription = FakeSessionDescription;
		webRTCService.close();
	});

	it("queues ICE candidates until the remote description exists", async () => {
		const peer = await webRTCService.connect("123456");

		await webRTCService.handleIceCandidate({ candidate: "candidate:1" });
		expect((peer as unknown as FakePeerConnection).addIceCandidate).not.toHaveBeenCalled();

		await webRTCService.handleOffer("123456", {
			type: "offer",
			sdp: "offer",
		});

		expect((peer as unknown as FakePeerConnection).addIceCandidate).toHaveBeenCalledTimes(1);
	});

	it("keeps an ICE candidate that arrives before the peer connection", async () => {
		await webRTCService.handleIceCandidate({ candidate: "candidate:early" });

		await webRTCService.handleOffer("123456", {
			type: "offer",
			sdp: "offer",
		});

		expect(FakePeerConnection.instances[0].addIceCandidate).toHaveBeenCalledTimes(1);
	});

	it("stops every local media track when closed", () => {
		const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
		webRTCService.setLocalStream({ getTracks: () => tracks } as unknown as MediaStream);

		webRTCService.close();

		expect(tracks[0].stop).toHaveBeenCalledOnce();
		expect(tracks[1].stop).toHaveBeenCalledOnce();
	});

	it("does not reuse a failed or closed peer connection", async () => {
		const first = await webRTCService.connect("123456");
		(first as unknown as FakePeerConnection).connectionState = "failed";

		const second = await webRTCService.connect("123456");

		expect(second).not.toBe(first);
		expect(FakePeerConnection.instances).toHaveLength(2);
	});
});
