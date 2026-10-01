import {
	Heading,
	VStack,
	Button,
	HStack,
	Spinner,
	Text,
	Spacer,
} from "@chakra-ui/react";
import { useEffect, useRef, useState } from "react";
import { customAlphabet } from "nanoid/non-secure";
import { TriangleAlertIcon } from "lucide-react";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useWebSocketStore } from "~/stores/webSocket";
import { webSocketService } from "~/services/webSocket";
import { useAuthStore } from "~/stores/auth";
import { Alert } from "~/components/ui/alert";
import { Field } from "~/components/ui/field";
import { PinInput } from "~/components/ui/pin-input";
import { webRTCService } from "~/services/webRTC";
import { useWebRTCStore } from "~/stores/webRTC";
import { buildSignalingUrl, resolveRoomId } from "~/config";
import {
	SCREEN_QUALITY_PRESETS,
	applyVideoTrackQuality,
	captureDisplayMedia,
	type ScreenQuality,
} from "~/media";

export async function clientLoader() {
	const { id, setId } = useAuthStore.getState();
	const roomId = resolveRoomId(
		id,
		() => customAlphabet("0123456789", 6)(),
		setId,
	);
	const url = buildSignalingUrl(roomId);
	webSocketService.connect(url);
	webSocketService.registerHandler("offer", (data) => {
		if (!data || typeof data !== "object") return;
		const message = data as { from?: unknown; data?: unknown };
		if (
			typeof message.from !== "string" ||
			!message.data ||
			typeof message.data !== "object"
		) {
			return;
		}
		void webRTCService.handleOffer(
			message.from,
			message.data as RTCSessionDescriptionInit,
		);
	});
	return null;
}

clientLoader.hydrate = true as const;

const schema = z.object({
	code: z
		.string()
		.min(1, { message: "投屏码不能为空" })
		.length(6, { message: "投屏码长度为6位" }),
});

export default function Home() {
	const { id } = useAuthStore();
	const webrtc = useWebRTCStore();
	const { remoteStream, connectionState } = webrtc;
	const [quality, setQuality] = useState<ScreenQuality>("hd");

	const videoRef = useRef<HTMLVideoElement>(null);

	useEffect(() => {
		if (videoRef.current && remoteStream && connectionState === "connected") {
			if (videoRef.current.srcObject !== remoteStream) {
				videoRef.current.srcObject = remoteStream;
			}
		}
	}, [remoteStream, connectionState]);

	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<z.infer<typeof schema>>({
		resolver: zodResolver(schema),
	});

	const onSubmit = handleSubmit(async (data) => {
		const { code } = data;
		try {
			const { stream, quality: captureQuality } = await captureDisplayMedia(quality);
			const videoTrack = stream.getVideoTracks()[0];
			const appliedQuality = videoTrack
				? await applyVideoTrackQuality(videoTrack, captureQuality)
				: captureQuality;
			await webRTCService.setQuality(appliedQuality);
			webRTCService.setLocalStream(stream);
			await webRTCService.connect(code);
		} catch (error) {
			console.error("Error in WebRTC setup:", error);
		}
	});

	return (
		<VStack p={4} pt={24} h="dvh">
			<WebSocketStateComponent />
			<ConnectionDiagnostics signaling={useWebSocketStore()} peer={webrtc} />
			<Heading fontSize="xl">投屏码</Heading>
			<Button
				size="xl"
				variant="subtle"
				fontWeight="bold"
				fontSize="2xl"
				letterSpacing={2}
			>
				{id}
			</Button>
			<video
				ref={videoRef}
				autoPlay
				muted
				controls
				hidden={!remoteStream || connectionState !== "connected"}
			/>
			<VStack hidden={connectionState !== "connected"}>
				<Heading>已连接</Heading>
				<Button
					colorPalette="red"
					onClick={() => {
						webRTCService.close();
					}}
				>
					断开连接
				</Button>
			</VStack>
			<VStack
				flex={1}
				maxW="sm"
				mx="auto"
				asChild
				pt={24}
				hidden={connectionState === "connected"}
			>
				<form method="post" onSubmit={onSubmit}>
					<Heading fontSize="xl">我要投屏</Heading>
					<Field
						label="投屏码"
						invalid={!!errors.code}
						errorText={errors.code?.message}
					>
						<PinInput
							count={6}
							placeholder={""}
							pattern="\d"
							{...register("code")}
						/>
					</Field>
					<label>
						<Text mb={2}>画面质量</Text>
						<select
							aria-label="画面质量"
							value={quality}
							onChange={(event) => setQuality(event.target.value as ScreenQuality)}
						>
							{Object.entries(SCREEN_QUALITY_PRESETS).map(([value, preset]) => (
								<option key={value} value={value}>
									{preset.label}
								</option>
							))}
						</select>
					</label>
					<Button w="full" type="submit">
						提交
					</Button>
				</form>
			</VStack>
		</VStack>
	);
}

function WebSocketStateComponent() {
	const { webSocketState } = useWebSocketStore();
	return (
		<HStack
			pos="fixed"
			top="4"
			left="0"
			w="full"
			px="2"
			zIndex="999"
			justifyContent="center"
			hidden={webSocketState === "connected"}
		>
			<Alert
				variant="subtle"
				status={webSocketState === "connecting" ? "info" : "error"}
				icon={
					webSocketState === "connecting" ? <Spinner /> : <TriangleAlertIcon />
				}
				maxW="sm"
				alignItems="center"
				asChild
			>
				<HStack h="6">
					<Text>
						{webSocketState === "connecting"
							? "正在连接到服务器..."
							: "连接到服务器失败"}
					</Text>
					<Spacer />
					<Button
						hidden={webSocketState === "connecting"}
						size="xs"
						onClick={() => {
							webSocketService.reconnect();
						}}
					>
						重新连接
					</Button>
				</HStack>
			</Alert>
		</HStack>
	);
}

export function ConnectionDiagnostics({
	signaling,
	peer,
}: {
	signaling: ReturnType<typeof useWebSocketStore.getState>;
	peer: ReturnType<typeof useWebRTCStore.getState>;
}) {
	const unavailable = "暂无数据";
	const formatRate = (value?: number) =>
		typeof value === "number" ? `${Math.round(value)} fps` : unavailable;
	const formatBitrate = (value?: number) =>
		typeof value === "number"
			? `${(value / 1_000_000).toFixed(2)} Mbps`
			: unavailable;
	return (
		<section
			aria-label="连接诊断"
			style={{
				width: "100%",
				maxWidth: "36rem",
				padding: "0.75rem",
				border: "1px solid",
				borderRadius: "0.5rem",
				fontSize: "0.875rem",
			}}
		>
			<p>
				<strong>连接诊断</strong>
			</p>
			<p>
				信令：{signaling.webSocketState}（重连 {signaling.reconnectAttempts} 次）
			</p>
			{signaling.lastError && <p>信令错误：{signaling.lastError}</p>}
			<p>
				WebRTC：{peer.connectionState ?? unavailable}；ICE：
				{peer.iceConnectionState ?? unavailable}
			</p>
			<p>
				ICE 收集：{peer.iceGatheringState ?? unavailable}；协商：
				{peer.signalingState ?? unavailable}
			</p>
			<p>
				角色/设备：{peer.role ?? unavailable} / {peer.peerId ?? unavailable}
			</p>
			<p>候选线路：{peer.stats?.candidateType ?? unavailable}</p>
			<p>
				画面：
				{peer.stats?.width && peer.stats.height
					? `${peer.stats.width}×${peer.stats.height}`
					: unavailable}
				；帧率：{formatRate(peer.stats?.framesPerSecond)}；码率：
				{formatBitrate(peer.stats?.bitrate)}
			</p>
			{peer.lastError && <p>WebRTC 错误：{peer.lastError}</p>}
			<p>视频流不经过信令服务器</p>
		</section>
	);
}
