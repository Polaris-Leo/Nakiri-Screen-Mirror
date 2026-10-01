import { describe, expect, it, vi } from "vitest";
import {
	SCREEN_QUALITY_PRESETS,
	applyVideoTrackQuality,
	captureDisplayMedia,
	getDisplayMediaConstraints,
} from "../../app/media";

describe("screen quality presets", () => {
	it("defines the documented resolution, frame-rate, and bitrate targets", () => {
		expect(SCREEN_QUALITY_PRESETS).toEqual({
			balanced: { label: "平衡 · 1080p 30 FPS", width: 1920, height: 1080, frameRate: 30, maxBitrate: 6_000_000 },
			hd: { label: "高清 · 1080p 60 FPS", width: 1920, height: 1080, frameRate: 60, maxBitrate: 10_000_000 },
			ultra: { label: "超清 · 1440p 60 FPS", width: 2560, height: 1440, frameRate: 60, maxBitrate: 14_000_000 },
			"4k": { label: "4K · 30 FPS", width: 3840, height: 2160, frameRate: 30, maxBitrate: 20_000_000 },
		});
	});

	it("requests selected video constraints while preserving audio", () => {
		expect(getDisplayMediaConstraints("hd")).toEqual({
			video: {
				width: { ideal: 1920, max: 1920 },
				height: { ideal: 1080, max: 1080 },
				frameRate: { ideal: 60, max: 60 },
			},
			audio: true,
		});
	});

	it("retries capture with balanced constraints only after an overconstraint error", async () => {
		const capture = vi.fn()
			.mockRejectedValueOnce(Object.assign(new Error("unsupported"), { name: "OverconstrainedError" }))
			.mockResolvedValueOnce({ getVideoTracks: () => [] } as unknown as MediaStream);

		const result = await captureDisplayMedia("4k", capture);

		expect(result.quality).toBe("balanced");
		expect(capture).toHaveBeenCalledTimes(2);
		expect(capture.mock.calls[1][0]).toEqual(getDisplayMediaConstraints("balanced"));
	});

	it("does not retry capture after permission denial", async () => {
		const capture = vi.fn().mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));

		await expect(captureDisplayMedia("4k", capture)).rejects.toThrow("denied");
		expect(capture).toHaveBeenCalledOnce();
	});

	it("applies detail constraints and falls back to balanced", async () => {
		const track = {
			contentHint: "",
			applyConstraints: vi.fn()
				.mockRejectedValueOnce(Object.assign(new Error("unsupported"), { name: "OverconstrainedError" }))
				.mockResolvedValueOnce(undefined),
		} as unknown as MediaStreamTrack;

		await expect(applyVideoTrackQuality(track, "4k")).resolves.toBe("balanced");
		expect(track.contentHint).toBe("detail");
		expect(track.applyConstraints).toHaveBeenCalledTimes(2);
	});
});
