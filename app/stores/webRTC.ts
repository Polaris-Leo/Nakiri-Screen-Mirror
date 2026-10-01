import { create } from "zustand";

interface WebRTCStore {
	connectionState?: RTCPeerConnectionState;
	remoteStream?: MediaStream;
	setConnectionState: (state: RTCPeerConnectionState) => void;
	setRemoteStream: (stream: MediaStream | undefined) => void;
	reset: () => void;
}

export const useWebRTCStore = create<WebRTCStore>((set, get) => ({
	connectionState: undefined,
	remoteStream: undefined,
	setConnectionState: (connectionState) => set({ connectionState }),
	setRemoteStream: (remoteStream) => set({ remoteStream }),
	reset: () => {
		set({
			connectionState: undefined,
			remoteStream: undefined,
		});
	},
}));
