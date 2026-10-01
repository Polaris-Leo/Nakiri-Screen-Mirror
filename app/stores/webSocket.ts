import { create } from "zustand";

export type WebSocketState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting";

interface WebSocketStore {
	webSocketState: WebSocketState;
	setWebSocketState: (state: WebSocketState) => void;
	reconnectAttempts: number;
	lastError: string | null;
	lastConnectedAt: number | null;
	lastDisconnectedAt: number | null;
	currentUrl: string | null;
	updateDiagnostics: (updates: Partial<Omit<WebSocketStore, "setWebSocketState" | "updateDiagnostics">>) => void;
}

export const useWebSocketStore = create<WebSocketStore>((set) => ({
	webSocketState: "disconnected",
	setWebSocketState: (state) => set({ webSocketState: state }),
	reconnectAttempts: 0,
	lastError: null,
	lastConnectedAt: null,
	lastDisconnectedAt: null,
	currentUrl: null,
	updateDiagnostics: (updates) => set(updates),
}));
