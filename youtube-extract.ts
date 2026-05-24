import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
// Gemini API disabled - using local model instead

import { queryLocalLlmMultimodal } from "./local-llm-api.js";
import { extractHeadingTitle, type ExtractedContent, type FrameResult, type VideoFrame } from "./extract.js";
import { formatSeconds, readExecError, isTimeoutError, trimErrorText, mapFfmpegError } from "./utils.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

const YOUTUBE_PROMPT = `Extract the complete content of this YouTube video. Include:
1. Video title, channel name, and duration
2. A brief summary (2-3 sentences)
3. Full transcript with timestamps
4. Descriptions of any code, terminal commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const MAX_VIDEO_FRAMES = 60; // Qwen3.6 supports up to 60 frames (60s at 1fps)
const MIN_FRAME_INTERVAL = 5; // Minimum seconds between frames

const YOUTUBE_REGEX =
	/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function shouldRethrow(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.startsWith("Failed to parse ");
}

interface YouTubeConfig {
	enabled: boolean;
	preferredModel: string;
}

function normalizePreferredModel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

const defaults: YouTubeConfig = { enabled: true, preferredModel: "qwen3.6-35b" };
let cachedConfig: YouTubeConfig | null = null;

function loadYouTubeConfig(): YouTubeConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = { ...defaults };
		return cachedConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { youtube?: { enabled?: boolean; preferredModel?: string } };
	try {
		raw = JSON.parse(rawText) as { youtube?: { enabled?: boolean; preferredModel?: string } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const yt = raw.youtube ?? {};
	cachedConfig = {
		enabled: normalizeEnabled(yt.enabled, defaults.enabled),
		preferredModel: normalizePreferredModel(yt.preferredModel, defaults.preferredModel),
	};
	return cachedConfig;
}

export function isYouTubeURL(url: string): { isYouTube: boolean; videoId: string | null } {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/playlist") {
			return { isYouTube: false, videoId: null };
		}
	} catch {
	}

	const match = url.match(YOUTUBE_REGEX);
	if (!match) return { isYouTube: false, videoId: null };
	return { isYouTube: true, videoId: match[1] };
}

export function isYouTubeEnabled(): boolean {
	return loadYouTubeConfig().enabled;
}

export async function extractYouTube(
	url: string,
	signal?: AbortSignal,
	prompt?: string,
	model?: string,
): Promise<ExtractedContent | null> {
	const config = loadYouTubeConfig();
	const { videoId } = isYouTubeURL(url);
	const canonicalUrl = videoId
		? `https://www.youtube.com/watch?v=${videoId}`
		: url;
	const effectivePrompt = prompt ?? YOUTUBE_PROMPT;
	const effectiveModel = model ?? config.preferredModel;

	const activityId = activityMonitor.logStart({ type: "fetch", url: `youtube.com/${videoId ?? "video"}` });

	// Primary: yt-dlp + ffmpeg frames + Qwen3.6 multimodal
	const result = await tryLocalLlmMultimodal(canonicalUrl, effectivePrompt, effectiveModel, signal);

	if (result) {
		result.url = url;
		if (videoId) {
			const thumb = await fetchYouTubeThumbnail(videoId);
			if (thumb) result.thumbnail = thumb;
		}
		activityMonitor.logComplete(activityId, 200);
		return result;
	}

	// Fallback: text-only Qwen3.6 summary when frame extraction fails
	// (e.g., live streams, no extractable frames, Qwen3.6 multimodal unavailable)
	const textFallback = await tryTextOnlySummary(canonicalUrl, effectivePrompt, effectiveModel, signal);
	if (textFallback) {
		textFallback.url = url;
		if (videoId) {
			const thumb = await fetchYouTubeThumbnail(videoId);
			if (thumb) textFallback.thumbnail = thumb;
		}
		activityMonitor.logComplete(activityId, 200);
		return textFallback;
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	activityMonitor.logError(activityId, "all extraction paths failed");
	return null;
}

type StreamInfo = { streamUrl: string; duration: number | null };
type StreamResult = StreamInfo | { error: string };

function mapYtDlpError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "yt-dlp is not installed. Install with: brew install yt-dlp";
	if (isTimeoutError(err)) return "yt-dlp timed out fetching video info";
	const lower = stderr.toLowerCase();
	if (lower.includes("private")) return "Video is private or unavailable";
	if (lower.includes("sign in")) return "Video is age-restricted and requires authentication";
	if (lower.includes("not available")) return "Video is unavailable in your region or has been removed";
	if (lower.includes("live")) return "Cannot extract frames from a live stream";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `yt-dlp failed: ${snippet}` : "yt-dlp failed";
}

export async function getYouTubeStreamInfo(videoId: string): Promise<StreamResult> {
	try {
		const output = execFileSync("yt-dlp", [
			"--print", "duration",
			"-g", `https://www.youtube.com/watch?v=${videoId}`,
		], { timeout: 15000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		const lines = output.split(/\r?\n/);
		const rawDuration = lines[0]?.trim();
		const streamUrl = lines[1]?.trim();
		if (!streamUrl) return { error: "yt-dlp failed: missing stream URL" };
		const parsedDuration = rawDuration && rawDuration !== "NA" ? Number.parseFloat(rawDuration) : NaN;
		const duration = Number.isFinite(parsedDuration) ? parsedDuration : null;
		return { streamUrl, duration };
	} catch (err) {
		return { error: mapYtDlpError(err) };
	}
}

async function extractFrameFromStream(streamUrl: string, seconds: number): Promise<FrameResult> {
	try {
		const buffer = execFileSync("ffmpeg", [
			"-ss", String(seconds), "-i", streamUrl,
			"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
		], { maxBuffer: 5 * 1024 * 1024, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
		if (buffer.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		return { error: mapFfmpegError(err) };
	}
}

export async function extractYouTubeFrame(
	videoId: string,
	seconds: number,
	streamInfo?: StreamInfo,
): Promise<FrameResult> {
	const info = streamInfo ?? await getYouTubeStreamInfo(videoId);
	if ("error" in info) return info;
	return extractFrameFromStream(info.streamUrl, seconds);
}

export async function extractYouTubeFrames(
	videoId: string,
	timestamps: number[],
	streamInfo?: StreamInfo,
): Promise<{ frames: VideoFrame[]; duration: number | null; error: string | null }> {
	const info = streamInfo ?? await getYouTubeStreamInfo(videoId);
	if ("error" in info) return { frames: [], duration: null, error: info.error };
	const results = await Promise.all(timestamps.map(async (t) => {
		const frame = await extractFrameFromStream(info.streamUrl, t);
		if ("error" in frame) return { error: frame.error };
		return { ...frame, timestamp: formatSeconds(t) };
	}));
	const frames = results.filter((f): f is VideoFrame => "data" in f);
	const errorResult = results.find((f): f is { error: string } => "error" in f);
	return { frames, duration: info.duration, error: frames.length === 0 && errorResult ? errorResult.error : null };
}

export async function fetchYouTubeThumbnail(videoId: string): Promise<{ data: string; mimeType: string } | null> {
	try {
		const res = await fetch(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const buffer = Buffer.from(await res.arrayBuffer());
		if (buffer.length === 0) return null;
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch {
		return null;
	}
}

/**
 * Extract YouTube video using yt-dlp + ffmpeg frames + Qwen3.6 multimodal.
 * This is the primary extraction path — mirrors video-extract.ts pattern.
 */
async function tryLocalLlmMultimodal(
	url: string,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		if (signal?.aborted) return null;

		const { videoId } = isYouTubeURL(url);
		if (!videoId) return null;

		// Step 1: Get stream URL and duration via yt-dlp
		const streamInfo = await getYouTubeStreamInfo(videoId);
		if ("error" in streamInfo) return null;

		// Step 2: Calculate frame timestamps
		const duration = streamInfo.duration ?? 60;
		const maxFrames = Math.min(MAX_VIDEO_FRAMES, Math.max(3, Math.floor(duration)));
		const timestamps: number[] = [];
		if (maxFrames <= 1) {
			timestamps.push(0);
		} else {
			const interval = Math.max(MIN_FRAME_INTERVAL, Math.floor(duration / (maxFrames - 1)));
			for (let t = 0; t <= duration && timestamps.length < maxFrames; t += interval) {
				timestamps.push(t);
			}
		}

		// Step 3: Extract frames via ffmpeg
		const framePromises = timestamps.map(async (t) => {
			const frame = await extractFrameFromStream(streamInfo.streamUrl, t);
			if ("error" in frame) return null;
			return { ...frame, timestamp: `${t}s` };
		});
		const frameResults = (await Promise.all(framePromises)).filter((f): f is NonNullable<typeof f> => f !== null);

		if (frameResults.length === 0) return null;

		// Step 4: Send frames + prompt to Qwen3.6 multimodal
		const contents: Array<{ type: string; base64?: string; mimeType?: string; text?: string }> =
			frameResults.map((f) => ({
				type: "image",
				base64: f.data,
				mimeType: f.mimeType,
			}));
		contents.push({ type: "text", text: prompt || YOUTUBE_PROMPT });

		const text = await queryLocalLlmMultimodal(contents as any, { model, signal, timeoutMs: 120000, maxTokens: 4096 });

		return {
			url,
			title: extractHeadingTitle(text) ?? "YouTube Video",
			content: text,
			error: null,
			frames: frameResults.map((f) => ({ ...f, mimeType: f.mimeType })),
			duration: streamInfo.duration ?? undefined,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		return null;
	}
}

/**
 * Fallback: text-only Qwen3.6 summary when frame extraction fails.
 * Used when Qwen3.6 multimodal is unavailable, video is a live stream,
 * or no frames can be extracted.
 */
async function tryTextOnlySummary(
	url: string,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		if (signal?.aborted) return null;

		const summary = await queryLocalLlm(
			`Provide a detailed summary of the YouTube video at ${url}. Include:
1. Video title, channel name, and duration
2. A brief summary (2-3 sentences)
3. Key topics and timestamps
4. Any code, commands, or important information shown

If you don't have direct access to the video, provide general information about what this video is likely about based on the URL.`,
			{ signal, maxTokens: 2048 },
		);

		if (!summary || summary.length < 50) return null;

		return {
			url,
			title: "Video Summary (via Qwen3.6 text-only)",
			content: `# Video Summary (via Qwen3.6 text-only)\n\n${summary}`,
			error: null,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		return null;
	}
}


