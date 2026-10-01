import { beforeEach, describe, expect, it, vi } from "vitest";
import { webRTCService } from "../../app/services/webRTC";
import { SCREEN_QUALITY_PRESETS } from "../../app/media";
import { useWebSocketStore } from "../../app/stores/webSocket";
import { useWebRTCStore } from "../../app/stores/webRTC";

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	connectionState: RTCPeerConnectionState = "new";
	remoteDescription: RTCSessionDescriptionInit | null = null;
	iceConnectionState: RTCIceConnectionState = "new";
	iceGatheringState: RTCIceGatheringState = "new";
	signalingState: RTCSignalingState = "stable";
	parameters = { encodings: [{} as RTCRtpEncodingParameters] } as RTCRtpSendParameters;
	senders: Array<{ track: MediaStreamTrack; getParameters: () => RTCRtpSendParameters; setParameters: (parameters: RTCRtpSendParameters) => Promise<void> }> = [];
	onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
	ontrack: ((event: RTCTrackEvent) => void) | null = null;
	onnegotiationneeded: (() => void) | null = null;
	onconnectionstatechange: (() => void) | null = null;
	oniceconnectionstatechange: (() => void) | null = null;
	onicegatheringstatechange: (() => void) | null = null;
	onsignalingstatechange: (() => void) | null = null;
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
	addTrack = vi.fn((track: MediaStreamTrack) => {
		const sender = {
			track,
			getParameters: () => this.parameters,
			setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
				this.parameters = parameters;
			}),
		};
		this.senders.push(sender);
		return sender as unknown as RTCRtpSender;
	});
	getSenders = vi.fn(() => this.senders as unknown as RTCRtpSender[]);
	getStats = vi.fn(async () => new Map() as unknown as RTCStatsReport);

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
		(globalThis as any).window = globalThis;
		webRTCService.close();
		useWebSocketStore.setState({ webSocketState: "disconnected" });
		useWebRTCStore.getState().reset();
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

	it("applies the selected bitrate and frame-rate to the video sender", async () => {
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const peer = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;

		await webRTCService.setQuality("hd");

		expect(peer.parameters.encodings[0].maxBitrate).toBe(SCREEN_QUALITY_PRESETS.hd.maxBitrate);
		expect(peer.parameters.encodings[0].maxFramerate).toBe(60);
		expect(peer.parameters.degradationPreference).toBe("maintain-resolution");
		expect(peer.addTrack).toHaveBeenCalledOnce();
	});

	it("records ICE and signaling state changes for diagnostics", async () => {
		const peer = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		peer.iceConnectionState = "checking";
		peer.iceGatheringState = "gathering";
		peer.signalingState = "have-local-offer";
		peer.oniceconnectionstatechange?.();
		peer.onicegatheringstatechange?.();
		peer.onsignalingstatechange?.();

		expect(useWebRTCStore.getState()).toMatchObject({
			iceConnectionState: "checking",
			iceGatheringState: "gathering",
			signalingState: "have-local-offer",
			peerId: "123456",
			role: "receiver",
		});
	});

	it("recreates a failed sender connection after signaling is available", async () => {
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });

		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(FakePeerConnection.instances).toHaveLength(2);
		expect(FakePeerConnection.instances[1].addTrack).toHaveBeenCalledWith(track, expect.anything());
	});
});
