export type ScreenQuality = "balanced" | "hd" | "ultra" | "4k";

export const SCREEN_QUALITY_PRESETS: Readonly<
	Record<
		ScreenQuality,
		{
			label: string;
			width: number;
			height: number;
			frameRate: number;
			maxBitrate: number;
		}
	>
> = Object.freeze({
	balanced: Object.freeze({
		label: "平衡 · 1080p 30 FPS",
		width: 1920,
		height: 1080,
		frameRate: 30,
		maxBitrate: 6_000_000,
	}),
	hd: Object.freeze({
		label: "高清 · 1080p 60 FPS",
		width: 1920,
		height: 1080,
		frameRate: 60,
		maxBitrate: 10_000_000,
	}),
	ultra: Object.freeze({
		label: "超清 · 1440p 60 FPS",
		width: 2560,
		height: 1440,
		frameRate: 60,
		maxBitrate: 14_000_000,
	}),
	"4k": Object.freeze({
		label: "4K · 30 FPS",
		width: 3840,
		height: 2160,
		frameRate: 30,
		maxBitrate: 20_000_000,
	}),
});

export function getDisplayMediaConstraints(
	quality: ScreenQuality,
): DisplayMediaStreamOptions {
	const preset = SCREEN_QUALITY_PRESETS[quality];
	return {
		video: {
			width: { ideal: preset.width, max: preset.width },
			height: { ideal: preset.height, max: preset.height },
			frameRate: { ideal: preset.frameRate, max: preset.frameRate },
		},
		audio: true,
	};
}

function isConstraintError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "OverconstrainedError" ||
			error.name === "ConstraintNotSatisfiedError")
	);
}

export async function captureDisplayMedia(
	quality: ScreenQuality,
	capture = (constraints: DisplayMediaStreamOptions) =>
		navigator.mediaDevices.getDisplayMedia(constraints),
): Promise<{ stream: MediaStream; quality: ScreenQuality }> {
	try {
		return { stream: await capture(getDisplayMediaConstraints(quality)), quality };
	} catch (error) {
		if (quality === "balanced" || !isConstraintError(error)) throw error;
		return {
			stream: await capture(getDisplayMediaConstraints("balanced")),
			quality: "balanced",
		};
	}
}

export async function applyVideoTrackQuality(
	track: MediaStreamTrack,
	quality: ScreenQuality,
): Promise<ScreenQuality> {
	const apply = async (targetQuality: ScreenQuality) => {
		const { video } = getDisplayMediaConstraints(targetQuality);
		if (video && typeof video === "object") {
			await track.applyConstraints(video as MediaTrackConstraints);
		}
	};

	try {
		track.contentHint = "detail";
	} catch {
		// Older browsers may expose contentHint as read-only or omit it.
	}

	try {
		await apply(quality);
		return quality;
	} catch (error) {
		if (quality === "balanced" || !isConstraintError(error)) throw error;
		await apply("balanced");
		return "balanced";
	}
}
