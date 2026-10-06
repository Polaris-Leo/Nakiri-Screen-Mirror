import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREEN_QUALITY_PRESETS } from "../../app/media";
import { webRTCService } from "../../app/services/webRTC";
import { webSocketService } from "../../app/services/webSocket";
import { useWebRTCStore } from "../../app/stores/webRTC";
import { useWebSocketStore } from "../../app/stores/webSocket";

class FakePeerConnection {
	static instances: FakePeerConnection[] = [];
	static nextSetParametersGate: (() => Promise<void>) | null = null;
	static nextCreateOfferGate: (() => Promise<RTCSessionDescriptionInit>) | null = null;
	static nextSetLocalDescriptionGate: (() => Promise<void>) | null = null;
	constructor(readonly configuration?: RTCConfiguration) {
		FakePeerConnection.instances.push(this);
	}
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
	setLocalDescription = vi.fn(async () => {
		const gate = FakePeerConnection.nextSetLocalDescriptionGate;
		FakePeerConnection.nextSetLocalDescriptionGate = null;
		await gate?.();
	});
	createAnswer = vi.fn(async () => ({ type: "answer" as const, sdp: "answer" }));
	createOffer = vi.fn(async (_options?: RTCOfferOptions) => {
		const gate = FakePeerConnection.nextCreateOfferGate;
		FakePeerConnection.nextCreateOfferGate = null;
		return gate ? gate() : ({ type: "offer" as const, sdp: "offer" });
	});
	addTrack = vi.fn((track: MediaStreamTrack) => {
		const sender = {
			track,
			getParameters: () => this.parameters,
			setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
				const gate = FakePeerConnection.nextSetParametersGate;
				FakePeerConnection.nextSetParametersGate = null;
				await gate?.();
				this.parameters = parameters;
			}),
		};
		this.senders.push(sender);
		return sender as unknown as RTCRtpSender;
	});
	getSenders = vi.fn(() => this.senders as unknown as RTCRtpSender[]);
	getStats = vi.fn(async () => new Map() as unknown as RTCStatsReport);

}

class FakeIceCandidate {
	constructor(readonly candidate: RTCIceCandidateInit) {}
}

class FakeSessionDescription {
	readonly type: RTCSdpType;
	readonly sdp?: string;
	constructor(description: RTCSessionDescriptionInit) {
		this.type = description.type;
		this.sdp = description.sdp;
	}
}

describe("WebRTCService lifecycle", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	beforeEach(() => {
		FakePeerConnection.instances = [];
		FakePeerConnection.nextSetParametersGate = null;
		FakePeerConnection.nextCreateOfferGate = null;
		FakePeerConnection.nextSetLocalDescriptionGate = null;
		(globalThis as any).RTCPeerConnection = FakePeerConnection;
		(globalThis as any).RTCIceCandidate = FakeIceCandidate;
		(globalThis as any).RTCSessionDescription = FakeSessionDescription;
		(globalThis as any).window = globalThis;
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({
				iceServers: [{ urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }],
			}),
		} as Response)));
		webRTCService.close();
		useWebSocketStore.setState({ webSocketState: "disconnected" });
		useWebRTCStore.getState().reset();
	});

	it("loads TURN credentials before creating an explicit sender connection", async () => {
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);

		await webRTCService.connect("sender-peer");

		expect(FakePeerConnection.instances[0].configuration?.iceServers).toContainEqual({
			urls: "turn:turn.example.com:3478",
			username: "user",
			credential: "pass",
		});
	});

	it("loads TURN credentials before creating an incoming receiver connection", async () => {
		await webRTCService.handleOffer("receiver-peer", { type: "offer", sdp: "offer" });

		expect(FakePeerConnection.instances[0].configuration?.iceServers).toContainEqual({
			urls: "turn:turn.example.com:3478",
			username: "user",
			credential: "pass",
		});
	});

	it("allows STUN-only connection and records a warning when credential fetch fails", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) } as Response)));

		await webRTCService.connect("fallback-peer");

		expect(FakePeerConnection.instances[0].configuration?.iceServers).toEqual([
			{ urls: "stun:stun.l.google.com:19302" },
			{ urls: "stun:stun1.l.google.com:19302" },
		]);
		expect(useWebRTCStore.getState().lastError).toBeTruthy();
	});

	it("does not install a peer connection from a stale ICE fetch", async () => {
		let resolveFirst!: (response: Response) => void;
		const firstFetch = new Promise<Response>((resolve) => { resolveFirst = resolve; });
		const fetcher = vi.fn()
			.mockReturnValueOnce(firstFetch)
			.mockResolvedValueOnce({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:fresh.example", username: "u", credential: "c" }] }) } as Response);
		vi.stubGlobal("fetch", fetcher);
		const staleConnection = webRTCService.connect("old-peer");
		const activeConnection = await webRTCService.connect("new-peer");
		resolveFirst({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:stale.example", username: "u", credential: "c" }] }) } as Response);

		await expect(staleConnection).rejects.toThrow("superseded");
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(FakePeerConnection.instances[0]).toBe(activeConnection);
		expect(FakePeerConnection.instances[0].configuration?.iceServers).not.toContainEqual(
			expect.objectContaining({ urls: "turn:stale.example" }),
		);
	});

	it("clears a previous warning when valid TURN credentials load", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) } as Response)));
		await webRTCService.connect("first-peer");
		expect(useWebRTCStore.getState().lastError).toBeTruthy();
		webRTCService.close();
		vi.stubGlobal("fetch", vi.fn(async () => ({
			ok: true,
			json: async () => ({ iceServers: [{ urls: "turn:turn.example.com", username: "u", credential: "c" }] }),
		} as Response)));

		await webRTCService.connect("second-peer");

		expect(useWebRTCStore.getState().lastError).toBeNull();
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

	it("does not expose ICE candidate error event fields to diagnostics or console", async () => {
		const peer = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const sensitive = {
			address: "198.51.100.77",
			port: 54321,
			url: "turn:user:secret@turn.example.test",
			errorText: "private network failure detail",
		};

		peer.onicecandidateerror?.(sensitive as unknown as RTCPeerConnectionIceErrorEvent);

		const diagnostics = useWebRTCStore.getState();
		expect(diagnostics.lastError).toBe("ICE 候选收集失败：候选收集失败");
		expect(JSON.stringify(diagnostics)).not.toContain(JSON.stringify(sensitive));
		expect(JSON.stringify(diagnostics)).not.toMatch(/198\.51\.100\.77|54321|turn:user:secret|private network failure detail/);
		expect(JSON.stringify(diagnostics)).not.toContain(sensitive.url);
		expect(consoleError).toHaveBeenCalledOnce();
		expect(consoleError).toHaveBeenCalledWith("ICE 候选收集失败", "候选收集失败");
		expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/198\.51\.100\.77|54321|turn:user:secret|private network failure detail/);
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain(sensitive.url);
		expect(consoleError.mock.calls.flat()).not.toContain(sensitive);
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

	it("does not resume setup or stop active stats polling after sender quality is superseded", async () => {
		vi.useFakeTimers();
		let releaseQuality!: () => void;
		FakePeerConnection.nextSetParametersGate = () => new Promise<void>((resolve) => {
			releaseQuality = resolve;
		});
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);

		const staleConnection = webRTCService.connect("old-peer");
		await vi.waitFor(() => expect(FakePeerConnection.instances[0]?.senders[0]?.setParameters).toHaveBeenCalledOnce());
		const stalePeer = FakePeerConnection.instances[0];

		const activePeer = await webRTCService.connect("new-peer") as unknown as FakePeerConnection;
		releaseQuality();

		await expect(staleConnection).rejects.toThrow("superseded");
		await vi.advanceTimersByTimeAsync(1_000);

		expect(FakePeerConnection.instances).toHaveLength(2);
		expect(stalePeer.onicecandidate).toBeNull();
		expect(stalePeer.getStats).not.toHaveBeenCalled();
		expect(activePeer.getStats).toHaveBeenCalledTimes(2);
	});

	it("restarts ICE before rebuilding a failed sender connection", async () => {
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockReturnValue(true);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });

		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "offer", to: "123456", data: { type: "offer", sdp: "offer" } }));

		expect(first.createOffer).toHaveBeenCalledWith({ iceRestart: true });
		expect(sendMessage).toHaveBeenCalledWith({ type: "offer", to: "123456", data: { type: "offer", sdp: "offer" } });
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();
	});

	it.each(["offer", "local-description", "send"] as const)("rebuilds once when ICE restart %s fails", async (failure) => {
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		if (failure === "offer") first.createOffer.mockRejectedValueOnce(new Error("offer failed"));
		if (failure === "local-description") first.setLocalDescription.mockRejectedValueOnce(new Error("local description failed"));
		if (failure === "send") vi.spyOn(webSocketService, "sendMessage").mockReturnValue(false);
		useWebSocketStore.setState({ webSocketState: "connected" });

		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(2));

		expect(FakePeerConnection.instances).toHaveLength(2);
		expect(FakePeerConnection.instances[1].addTrack).toHaveBeenCalledWith(track, expect.anything());
	});

	it("suppresses duplicate failure callbacks until 10 seconds after the restart offer is sent", async () => {
		vi.useFakeTimers();
		let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
		let resolveRestartOfferSent!: () => void;
		const restartOfferSent = new Promise<void>((resolve) => { resolveRestartOfferSent = resolve; });
		FakePeerConnection.nextCreateOfferGate = () => new Promise((resolve) => { resolveOffer = resolve; });
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockImplementation((message) => {
			if (message.type === "offer") resolveRestartOfferSent();
			return true;
		});
		const setTimeoutSpy = vi.spyOn(window, "setTimeout");
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });

		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(first.createOffer).toHaveBeenCalledTimes(1), { interval: 1, timeout: 100 });
		first.connectionState = "disconnected";
		first.onconnectionstatechange?.();
		await vi.advanceTimersByTimeAsync(5_000);
		resolveOffer({ type: "offer", sdp: "restart" });
		await restartOfferSent;
		await vi.advanceTimersByTimeAsync(0);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);

		expect(first.createOffer).toHaveBeenCalledTimes(1);
		expect(first.createOffer).toHaveBeenCalledWith({ iceRestart: true });
		expect(sendMessage).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();
		expect(first.createOffer).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(FakePeerConnection.instances).toHaveLength(2);
	});

	it("clears a duplicate queued failure when connected cancels a pending restart", async () => {
		vi.useFakeTimers();
		let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
		FakePeerConnection.nextCreateOfferGate = () => new Promise((resolve) => { resolveOffer = resolve; });
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockReturnValue(true);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });
		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(first.createOffer).toHaveBeenCalledTimes(1), { interval: 1, timeout: 100 });
		first.connectionState = "failed";
		first.onconnectionstatechange?.();

		first.connectionState = "connected";
		first.onconnectionstatechange?.();
		resolveOffer({ type: "offer", sdp: "restart" });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(first.createOffer).toHaveBeenCalledTimes(1);
		expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "offer" }));
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();
		expect(first.connectionState).toBe("connected");
	});

	it("drains a fresh failure queued while connected cancels a pending restart", async () => {
		vi.useFakeTimers();
		let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
		FakePeerConnection.nextCreateOfferGate = () => new Promise((resolve) => { resolveOffer = resolve; });
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockReturnValue(true);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });

		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(first.createOffer).toHaveBeenCalledTimes(1), { interval: 1, timeout: 100 });
		first.connectionState = "connected";
		first.onconnectionstatechange?.();
		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		resolveOffer({ type: "offer", sdp: "stale restart" });
		await vi.waitFor(() => expect(first.createOffer).toHaveBeenCalledTimes(2), { interval: 1, timeout: 100 });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1), { interval: 1, timeout: 100 });

		expect(first.createOffer).toHaveBeenCalledTimes(2);
		expect(first.createOffer).toHaveBeenNthCalledWith(1, { iceRestart: true });
		expect(first.createOffer).toHaveBeenNthCalledWith(2, { iceRestart: true });
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(sendMessage).toHaveBeenCalledWith({ type: "offer", to: "123456", data: { type: "offer", sdp: "offer" } });
	});

	it("does not send or rebuild when connected cancels a pending createOffer", async () => {
		vi.useFakeTimers();
		let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
		FakePeerConnection.nextCreateOfferGate = () => new Promise((resolve) => { resolveOffer = resolve; });
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockReturnValue(true);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });
		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(first.createOffer).toHaveBeenCalledTimes(1), { interval: 1, timeout: 100 });

		first.connectionState = "connected";
		first.onconnectionstatechange?.();
		resolveOffer({ type: "offer", sdp: "restart" });
		await vi.advanceTimersByTimeAsync(10_000);

		expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "offer" }));
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();
		expect(first.connectionState).toBe("connected");
	});

	it("does not rebuild when a valid answer cancels pending setLocalDescription", async () => {
		vi.useFakeTimers();
		let rejectLocalDescription!: (error: Error) => void;
		FakePeerConnection.nextSetLocalDescriptionGate = () => new Promise<void>((_resolve, reject) => { rejectLocalDescription = reject; });
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockReturnValue(true);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });
		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(first.setLocalDescription).toHaveBeenCalled(), { interval: 1, timeout: 100 });

		await (webRTCService as any).handleAnswer({ type: "answer", sdp: "answer" });
		rejectLocalDescription(new Error("late local-description failure"));
		await vi.advanceTimersByTimeAsync(10_000);

		expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "offer" }));
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();
		expect(first.remoteDescription).toEqual({ type: "answer", sdp: "answer" });
		expect(useWebRTCStore.getState().lastError).toBeNull();
	});

	it("cancels an installed restart deadline on a valid answer and rebuilds after a distinct unanswered restart", async () => {
		vi.useFakeTimers();
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const sendMessage = vi.spyOn(webSocketService, "sendMessage").mockReturnValue(true);
		const setTimeoutSpy = vi.spyOn(window, "setTimeout");
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });

		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "offer", to: "123456" })), { interval: 1, timeout: 100 });
		await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000), { interval: 1, timeout: 100 });
		expect(first.createOffer).toHaveBeenCalledWith({ iceRestart: true });
		await (webRTCService as any).handleAnswer({ type: "answer", sdp: "answer" });
		await vi.advanceTimersByTimeAsync(10_001);
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();

		sendMessage.mockClear();
		setTimeoutSpy.mockClear();
		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "offer", to: "123456" })), { interval: 1, timeout: 100 });
		await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000), { interval: 1, timeout: 100 });
		expect(first.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.waitFor(() => expect(FakePeerConnection.instances).toHaveLength(2));
		expect(FakePeerConnection.instances).toHaveLength(2);
	});

	it("does not duplicate recovery for simultaneous failure events or stale callbacks", async () => {
		const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({ getTracks: () => [track] } as unknown as MediaStream);
		const first = (await webRTCService.connect("123456")) as unknown as FakePeerConnection;
		useWebSocketStore.setState({ webSocketState: "connected" });
		first.connectionState = "failed";
		first.onconnectionstatechange?.();
		first.oniceconnectionstatechange?.();
		first.onconnectionstatechange?.();
		await vi.waitFor(() => expect(first.createOffer).toHaveBeenCalledTimes(1));

		expect(FakePeerConnection.instances).toHaveLength(1);
		const staleCallback = first.onconnectionstatechange;
		webRTCService.close();
		staleCallback?.();
		expect(FakePeerConnection.instances).toHaveLength(1);
	});

	it("retries failed initial offer signaling with an ICE restart before rebuilding", async () => {
		const track = {
			kind: "video",
			stop: vi.fn(),
		} as unknown as MediaStreamTrack;
		webRTCService.setLocalStream({
			getTracks: () => [track],
		} as unknown as MediaStream);
		const sendMessage = vi
			.spyOn(webSocketService, "sendMessage")
			.mockReturnValueOnce(false)
			.mockReturnValue(true);
		const first = (await webRTCService.connect(
			"123456",
		)) as unknown as FakePeerConnection;

		await first.onnegotiationneeded?.();

		expect(sendMessage).toHaveBeenCalledWith({
			type: "offer",
			to: "123456",
			data: { type: "offer", sdp: "offer" },
		});
		expect(useWebRTCStore.getState().lastError).toBe(
			"信令连接暂不可用，协商请求未发送",
		);
		expect(FakePeerConnection.instances).toHaveLength(1);

		useWebSocketStore.setState({ webSocketState: "connected" });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

		expect(first.createOffer).toHaveBeenCalledTimes(2);
		expect(first.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });
		expect(FakePeerConnection.instances).toHaveLength(1);
		expect(first.close).not.toHaveBeenCalled();
	});
});
