import { create } from "zustand";
import type { WebRTCStats } from "~/services/webRTCStats";

export type WebRTCRole = "sender" | "receiver";

export interface WebRTCStore {
	connectionState?: RTCPeerConnectionState;
	iceConnectionState?: RTCIceConnectionState;
	iceGatheringState?: RTCIceGatheringState;
	signalingState?: RTCSignalingState;
	role?: WebRTCRole;
	peerId?: string;
	lastError?: string | null;
	stats?: WebRTCStats;
	remoteStream?: MediaStream;
	setConnectionState: (state: RTCPeerConnectionState) => void;
	setRemoteStream: (stream: MediaStream | undefined) => void;
	setDiagnostics: (updates: Partial<Omit<WebRTCStore, "setConnectionState" | "setRemoteStream" | "setDiagnostics" | "reset">>) => void;
	reset: () => void;
}

export const useWebRTCStore = create<WebRTCStore>((set, get) => ({
	connectionState: undefined,
	iceConnectionState: undefined,
	iceGatheringState: undefined,
	signalingState: undefined,
	role: undefined,
	peerId: undefined,
	lastError: null,
	stats: undefined,
	remoteStream: undefined,
	setConnectionState: (connectionState) => set({ connectionState }),
	setRemoteStream: (remoteStream) => set({ remoteStream }),
	setDiagnostics: (updates) => set(updates),
	reset: () => {
		set({
			connectionState: undefined,
			iceConnectionState: undefined,
			iceGatheringState: undefined,
			signalingState: undefined,
			role: undefined,
			peerId: undefined,
			lastError: null,
			stats: undefined,
			remoteStream: undefined,
		});
	},
}));
