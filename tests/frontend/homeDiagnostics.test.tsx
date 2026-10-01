import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionDiagnostics } from "~/routes/home";
import { useWebRTCStore } from "~/stores/webRTC";
import { useWebSocketStore } from "~/stores/webSocket";

afterEach(() => {
	useWebRTCStore.getState().reset();
	useWebSocketStore.setState({
		webSocketState: "disconnected",
		reconnectAttempts: 0,
		lastError: null,
		lastConnectedAt: null,
		lastDisconnectedAt: null,
		currentUrl: null,
	});
});

describe("connection diagnostics", () => {
	it("shows signaling and failed ICE independently and explains the media path", () => {
		useWebSocketStore.setState({ webSocketState: "connected", reconnectAttempts: 2 });
		useWebRTCStore.getState().setDiagnostics({
			connectionState: "failed",
			iceConnectionState: "failed",
			role: "sender",
			peerId: "123456",
		});

		const html = renderToStaticMarkup(
			<ConnectionDiagnostics
				signaling={useWebSocketStore.getState()}
				peer={useWebRTCStore.getState()}
			/>,
		);
		expect(html).toContain("connected");
		expect(html).toContain("ICE：failed");
		expect(html).toContain("视频流不经过信令服务器");
	});

	it("renders unavailable media stats safely", () => {
		const html = renderToStaticMarkup(
			<ConnectionDiagnostics
				signaling={useWebSocketStore.getState()}
				peer={useWebRTCStore.getState()}
			/>,
		);
		expect(html.match(/暂无数据/g)?.length).toBeGreaterThan(0);
	});

	it("shows screen-capture setup errors to the user", () => {
		const html = renderToStaticMarkup(
			<ConnectionDiagnostics
				signaling={useWebSocketStore.getState()}
				peer={useWebRTCStore.getState()}
				captureError="屏幕共享权限已拒绝"
			/>,
		);
		expect(html).toContain("屏幕共享权限已拒绝");
	});
});
