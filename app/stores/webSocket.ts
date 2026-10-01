import { create } from "zustand";

export type WebSocketState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting";

interface WebSocketStore {
	webSocketState: WebSocketState;
	setWebSocketState: (state: WebSocketState) => void;
}

export const useWebSocketStore = create<WebSocketStore>((set) => ({
	webSocketState: "disconnected",
	setWebSocketState: (state) => set({ webSocketState: state }),
}));
