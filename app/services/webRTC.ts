import { useWebRTCStore } from "~/stores/webRTC";
import { webSocketService } from "~/services/webSocket";

class WebRTCService {
	private static instance: WebRTCService;
	private peerId = "";
	private peerConnection: RTCPeerConnection | null = null;
	private localStream: MediaStream | null = null;
	private pendingCandidates: RTCIceCandidateInit[] = [];
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
	}

	static getInstance(): WebRTCService {
		if (!WebRTCService.instance) {
			WebRTCService.instance = new WebRTCService();
		}
		return WebRTCService.instance;
	}

	setLocalStream(stream: MediaStream) {
		this.localStream = stream;
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

		if (this.peerConnection) {
			this.closePeerConnection();
		}
		this.peerId = to;
		const peerConnection = new RTCPeerConnection(this.config);
		this.peerConnection = peerConnection;

		peerConnection.onicecandidate = (event) => {
			if (event.candidate) {
				webSocketService.sendMessage({
					type: "ice_candidate",
					to: this.peerId,
					data: event.candidate,
				});
			}
		};

		peerConnection.ontrack = (event) => {
			const [remoteStream] = event.streams;
			if (remoteStream) {
				useWebRTCStore.getState().setRemoteStream(remoteStream);
			}
		};

		peerConnection.onnegotiationneeded = async () => {
			try {
				if (
					peerConnection.signalingState !== "stable" &&
					peerConnection.remoteDescription
				) {
					return;
				}
				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);
				webSocketService.sendMessage({
					type: "offer",
					to: this.peerId,
					data: offer,
				});
			} catch (error) {
				console.error("Failed to create WebRTC offer:", error);
			}
		};

		peerConnection.onconnectionstatechange = () => {
			const state = peerConnection.connectionState;
			useWebRTCStore.getState().setConnectionState(state);
			if (
				(state === "failed" || state === "closed") &&
				this.peerConnection === peerConnection
			) {
				this.closePeerConnection();
			}
		};

		peerConnection.onicecandidateerror = (event) => {
			console.error("ICE candidate error:", event);
		};

		return peerConnection;
	}

	async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
		if (!this.peerConnection) {
			this.pendingCandidates.push(candidate);
			return;
		}
		if (!this.peerConnection.remoteDescription) {
			this.pendingCandidates.push(candidate);
			return;
		}

		try {
			await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
		} catch (error) {
			console.error("Failed to add ICE candidate:", error);
		}
	}

	private async flushPendingCandidates() {
		const candidates = this.pendingCandidates.splice(0);
		for (const candidate of candidates) {
			await this.handleIceCandidate(candidate);
		}
	}

	private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
		if (!this.peerConnection) return;
		try {
			await this.peerConnection.setRemoteDescription(
				new RTCSessionDescription(answer),
			);
			await this.flushPendingCandidates();
		} catch (error) {
			console.error("Failed to apply WebRTC answer:", error);
		}
	}

	async handleOffer(
		peerId: string,
		offer: RTCSessionDescriptionInit,
	): Promise<void> {
		try {
			const peerConnection = await this.connect(peerId);
			await peerConnection.setRemoteDescription(
				new RTCSessionDescription(offer),
			);
			await this.flushPendingCandidates();
			const answer = await peerConnection.createAnswer();
			await peerConnection.setLocalDescription(answer);
			webSocketService.sendMessage({
				type: "answer",
				to: peerId,
				data: answer,
			});
		} catch (error) {
			console.error("Failed to handle WebRTC offer:", error);
		}
	}

	private closePeerConnection() {
		this.peerConnection?.close();
		this.peerConnection = null;
		this.pendingCandidates = [];
	}

	close() {
		this.localStream?.getTracks().forEach((track) => track.stop());
		this.localStream = null;
		this.closePeerConnection();
		this.peerId = "";
		useWebRTCStore.getState().setConnectionState("disconnected");
		useWebRTCStore.getState().setRemoteStream(undefined);
	}
}

export const webRTCService = WebRTCService.getInstance();
