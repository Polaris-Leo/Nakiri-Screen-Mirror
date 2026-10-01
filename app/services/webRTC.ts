import { SCREEN_QUALITY_PRESETS, type ScreenQuality } from "~/media";
import { useWebRTCStore, type WebRTCRole } from "~/stores/webRTC";
import { useWebSocketStore } from "~/stores/webSocket";
import { webSocketService } from "~/services/webSocket";
import { normalizeWebRTCStats, type WebRTCStats } from "~/services/webRTCStats";

export { normalizeWebRTCStats } from "~/services/webRTCStats";
export type { WebRTCStats } from "~/services/webRTCStats";

const STATS_INTERVAL_MS = 1_000;
const DISCONNECTED_GRACE_MS = 5_000;

class WebRTCService {
	private static instance: WebRTCService;
	private peerId = "";
	private peerConnection: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;
	private pendingCandidates: RTCIceCandidateInit[] = [];
	private role: WebRTCRole = "receiver";
	private quality: ScreenQuality = "hd";
	private statsInterval: number | null = null;
	private disconnectedTimeout: number | null = null;
	private reconnectRequested = false;
	private recovering = false;
	private lastByteSample: { bytes: number; at: number } | null = null;
	private readonly config: RTCConfiguration = {
		iceServers: [
			{ urls: "stun:stun.l.google.com:19302" },
			{ urls: "stun:stun1.l.google.com:19302" },
		],
	};

	private constructor() {
		webSocketService.registerHandler("ice_candidate", (message) => {
			if (!message || typeof message !== "object") return;
			const data = message as { data?: unknown };
			if (!data.data || typeof data.data !== "object") return;
			void this.handleIceCandidate(data.data as RTCIceCandidateInit);
		});

		webSocketService.registerHandler("answer", (message) => {
			if (!message || typeof message !== "object") return;
			const data = message as { data?: unknown };
			if (!data.data || typeof data.data !== "object") return;
			void this.handleAnswer(data.data as RTCSessionDescriptionInit);
		});

		useWebSocketStore.subscribe((state, previous) => {
			if (
				state.webSocketState === "connected" &&
				previous.webSocketState !== "connected"
			) {
				void this.recoverSenderConnection();
			}
		});
	}

	static getInstance(): WebRTCService {
		if (!WebRTCService.instance) {
			WebRTCService.instance = new WebRTCService();
		}
		return WebRTCService.instance;
	}

	setLocalStream(stream: MediaStream) {
		this.localStream = stream;
		this.role = "sender";
		useWebRTCStore.getState().setDiagnostics({ role: this.role });
	}

	async connect(to: string): Promise<RTCPeerConnection> {
		if (
			this.peerConnection &&
			this.peerId === to &&
			this.peerConnection.connectionState !== "failed" &&
			this.peerConnection.connectionState !== "closed"
		) {
			return this.peerConnection;
		}

		if (this.peerConnection) this.closePeerConnection();
		this.peerId = to;
		this.role = this.localStream ? "sender" : "receiver";
		const peerConnection = new RTCPeerConnection(this.config);
		this.peerConnection = peerConnection;
		useWebRTCStore.getState().setDiagnostics({
			role: this.role,
			peerId: to,
			connectionState: peerConnection.connectionState,
			iceConnectionState: peerConnection.iceConnectionState,
			iceGatheringState: peerConnection.iceGatheringState,
			signalingState: peerConnection.signalingState,
			lastError: null,
		});

		if (this.localStream) {
			for (const track of this.localStream.getTracks()) {
				const sender = peerConnection.addTrack(track, this.localStream);
				if (track.kind === "video") await this.applySenderQuality(sender);
			}
		}

		peerConnection.onicecandidate = (event) => {
			if (this.peerConnection !== peerConnection || !event.candidate) return;
			if (
				!webSocketService.sendMessage({
					type: "ice_candidate",
					to: this.peerId,
					data: event.candidate,
				})
			) {
				useWebRTCStore.getState().setDiagnostics({
					lastError: "信令连接暂不可用，新的 ICE 候选未发送",
				});
			}
		};

		peerConnection.ontrack = (event) => {
			if (this.peerConnection !== peerConnection) return;
			const [remoteStream] = event.streams;
			if (remoteStream) useWebRTCStore.getState().setRemoteStream(remoteStream);
		};

		peerConnection.onnegotiationneeded = async () => {
			if (this.peerConnection !== peerConnection || this.role !== "sender") return;
			try {
				if (peerConnection.signalingState !== "stable") return;
				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);
				if (this.peerConnection !== peerConnection) return;
				if (
					!webSocketService.sendMessage({ type: "offer", to: this.peerId, data: offer })
				) {
					useWebRTCStore.getState().setDiagnostics({
						lastError: "信令连接暂不可用，协商请求未发送",
					});
				}
			} catch (error) {
				this.recordError("创建 WebRTC offer 失败", error);
			}
		};

		peerConnection.onconnectionstatechange = () => {
			if (this.peerConnection !== peerConnection) return;
			const state = peerConnection.connectionState;
			useWebRTCStore.getState().setDiagnostics({
				connectionState: state,
				iceConnectionState: peerConnection.iceConnectionState,
				iceGatheringState: peerConnection.iceGatheringState,
				signalingState: peerConnection.signalingState,
			});
			if (state === "connected") {
				this.clearDisconnectedTimeout();
				this.reconnectRequested = false;
			} else if (state === "failed") {
				this.requestSenderRecovery();
			} else if (state === "disconnected" && this.role === "sender") {
				this.clearDisconnectedTimeout();
				this.disconnectedTimeout = window.setTimeout(() => {
					if (
						this.peerConnection === peerConnection &&
						peerConnection.connectionState === "disconnected"
					) {
						this.requestSenderRecovery();
					}
				}, DISCONNECTED_GRACE_MS);
			}
		};

		peerConnection.oniceconnectionstatechange = () => {
			if (this.peerConnection !== peerConnection) return;
			useWebRTCStore.getState().setDiagnostics({
				iceConnectionState: peerConnection.iceConnectionState,
			});
		};
		peerConnection.onicegatheringstatechange = () => {
			if (this.peerConnection !== peerConnection) return;
			useWebRTCStore.getState().setDiagnostics({
				iceGatheringState: peerConnection.iceGatheringState,
			});
		};
		peerConnection.onsignalingstatechange = () => {
			if (this.peerConnection !== peerConnection) return;
			useWebRTCStore.getState().setDiagnostics({
				signalingState: peerConnection.signalingState,
			});
		};
		peerConnection.onicecandidateerror = (event) => {
			if (this.peerConnection !== peerConnection) return;
			this.recordError("ICE 候选收集失败", event);
		};

		this.startStatsPolling(peerConnection, this.role);
		return peerConnection;
	}

	async setQuality(quality: ScreenQuality): Promise<void> {
		this.quality = quality;
		const senders = this.peerConnection?.getSenders() ?? [];
		await Promise.all(
			senders
				.filter((sender) => sender.track?.kind === "video")
				.map((sender) => this.applySenderQuality(sender)),
		);
	}

	private async applySenderQuality(sender: RTCRtpSender): Promise<void> {
		const preset = SCREEN_QUALITY_PRESETS[this.quality];
		const parameters = sender.getParameters();
		parameters.encodings ??= [{}];
		parameters.encodings[0] ??= {};
		parameters.encodings[0].maxBitrate = preset.maxBitrate;
		parameters.encodings[0].maxFramerate = preset.frameRate;
		parameters.degradationPreference = "maintain-resolution";
		try {
			await sender.setParameters(parameters);
		} catch {
			delete parameters.degradationPreference;
			try {
				await sender.setParameters(parameters);
			} catch (error) {
				this.recordError("当前浏览器无法应用发送质量限制", error);
			}
		}
	}

	async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (!this.peerConnection || !this.peerConnection.remoteDescription) {
			this.pendingCandidates.push(candidate);
			return;
		}
		try {
			await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (error) {
			this.recordError("添加 ICE 候选失败", error);
		}
	}

	private async flushPendingCandidates() {
		const candidates = this.pendingCandidates.splice(0);
		for (const candidate of candidates) await this.handleIceCandidate(candidate);
	}

	private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		if (!this.peerConnection) return;
		try {
			await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
			await this.flushPendingCandidates();
		} catch (error) {
			this.recordError("应用 WebRTC answer 失败", error);
		}
	}

	async handleOffer(
		peerId: string,
		offer: RTCSessionDescriptionInit,
	): Promise<void> {
		try {
			const peerConnection = await this.connect(peerId);
			await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
			await this.flushPendingCandidates();
			const answer = await peerConnection.createAnswer();
			await peerConnection.setLocalDescription(answer);
			webSocketService.sendMessage({ type: "answer", to: peerId, data: answer });
		} catch (error) {
			this.recordError("处理 WebRTC offer 失败", error);
		}
	}

	private requestSenderRecovery() {
		if (this.role !== "sender" || !this.localStream || !this.peerId) return;
		this.reconnectRequested = true;
		void this.recoverSenderConnection();
	}

	private async recoverSenderConnection() {
		if (
			!this.reconnectRequested ||
			this.recovering ||
			useWebSocketStore.getState().webSocketState !== "connected" ||
			!this.localStream ||
			!this.peerId
		) return;

		this.recovering = true;
		const peerId = this.peerId;
		this.reconnectRequested = false;
		this.closePeerConnection();
		try {
			await this.connect(peerId);
		} catch (error) {
			this.reconnectRequested = true;
			this.recordError("重建 WebRTC 连接失败", error);
		} finally {
			this.recovering = false;
		}
	}

	private startStatsPolling(peerConnection: RTCPeerConnection, role: WebRTCRole) {
		this.stopStatsPolling();
		this.lastByteSample = null;
		const update = async () => {
			if (this.peerConnection !== peerConnection) return;
			try {
				const stats = normalizeWebRTCStats(await peerConnection.getStats(), role);
				const bytes = role === "sender" ? stats.bytesSent : stats.bytesReceived;
				const now = Date.now();
				let bitrate = stats.bitrate;
				if (bytes !== undefined && this.lastByteSample) {
					const elapsed = now - this.lastByteSample.at;
					if (elapsed > 0 && bytes >= this.lastByteSample.bytes) {
						bitrate = ((bytes - this.lastByteSample.bytes) * 8 * 1000) / elapsed;
					}
				}
				if (bytes !== undefined) this.lastByteSample = { bytes, at: now };
				useWebRTCStore.getState().setDiagnostics({
					stats: { ...stats, bitrate },
					iceConnectionState: peerConnection.iceConnectionState,
					iceGatheringState: peerConnection.iceGatheringState,
					signalingState: peerConnection.signalingState,
				});
			} catch (error) {
				this.recordError("读取 WebRTC 统计失败", error);
			}
		};
		void update();
		this.statsInterval = window.setInterval(() => void update(), STATS_INTERVAL_MS);
	}

	private stopStatsPolling() {
		if (this.statsInterval !== null) {
			clearInterval(this.statsInterval);
			this.statsInterval = null;
		}
	}

	private clearDisconnectedTimeout() {
		if (this.disconnectedTimeout !== null) {
			clearTimeout(this.disconnectedTimeout);
			this.disconnectedTimeout = null;
		}
	}

	private closePeerConnection() {
		this.stopStatsPolling();
		this.clearDisconnectedTimeout();
		const peerConnection = this.peerConnection;
		this.peerConnection = null;
		peerConnection?.close();
		this.pendingCandidates = [];
		this.lastByteSample = null;
	}

	private recordError(label: string, error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		useWebRTCStore.getState().setDiagnostics({ lastError: `${label}：${detail}` });
		console.error(label, error);
	}

	close() {
		this.reconnectRequested = false;
		this.recovering = false;
		this.localStream?.getTracks().forEach((track) => track.stop());
		this.localStream = null;
		this.closePeerConnection();
		this.peerId = "";
		this.role = "receiver";
		useWebRTCStore.getState().reset();
	}
}

export const webRTCService = WebRTCService.getInstance();
