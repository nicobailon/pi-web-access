import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { isGeminiApiAvailable, queryGeminiApiWithVideo } from "./gemini-api.js";
import { searchWithPerplexity } from "./perplexity.js";
import { extractHeadingTitle, type ExtractedContent, type FrameResult, type VideoFrame } from "./extract.js";
import { formatSeconds, readExecError, isTimeoutError, trimErrorText, mapFfmpegError } from "./utils.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

const YOUTUBE_PROMPT = `Extract the complete content of this YouTube video. Include:
1. Video title, channel name, and duration
2. A brief summary (2-3 sentences)
3. Full transcript with timestamps
4. Descriptions of any code, terminal commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const YOUTUBE_REGEX =
	/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

interface YouTubeConfig {
	enabled: boolean;
	preferredModel: string;
}

const defaults: YouTubeConfig = { enabled: true, preferredModel: "gemini-2.5-flash" };
let cachedConfig: YouTubeConfig | null = null;

function loadYouTubeConfig(): YouTubeConfig {
	if (cachedConfig) return cachedConfig;
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
			const yt = raw.youtube ?? {};
			cachedConfig = {
				enabled: yt.enabled ?? defaults.enabled,
				preferredModel: yt.preferredModel ?? defaults.preferredModel,
			};
			return cachedConfig;
		}
	} catch {}
	cachedConfig = { ...defaults };
	return cachedConfig;
}

export function isYouTubeURL(url: string): { isYouTube: boolean; videoId: string | null } {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/playlist") {
			return { isYouTube: false, videoId: null };
		}
	} catch {
		return { isYouTube: false, videoId: null };
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
): Promise<ExtractedContent | null> {
	const config = loadYouTubeConfig();
	const { videoId } = isYouTubeURL(url);
	const canonicalUrl = videoId
		? `https://www.youtube.com/watch?v=${videoId}`
		: url;
	const effectivePrompt = prompt ?? YOUTUBE_PROMPT;

	const activityId = activityMonitor.logStart({ type: "fetch", url: `youtube.com/${videoId ?? "video"}` });

	const result = await tryGeminiWeb(canonicalUrl, effectivePrompt, config, signal)
		?? await tryGeminiApi(canonicalUrl, effectivePrompt, config, signal)
		?? await tryPerplexity(url, effectivePrompt, signal);

	if (result) {
		result.url = url;
		if (videoId) {
			const thumb = await fetchYouTubeThumbnail(videoId);
			if (thumb) result.thumbnail = thumb;
		}
		activityMonitor.logComplete(activityId, 200);
		return result;
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
		const { execFileSync } = await import("node:child_process");
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
		const { execFileSync } = await import("node:child_process");
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

async function tryGeminiWeb(
	url: string,
	prompt: string,
	config: YouTubeConfig,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		const cookies = await isGeminiWebAvailable();
		if (!cookies) return null;

		if (signal?.aborted) return null;

		const text = await queryWithCookies(prompt, cookies, {
			youtubeUrl: url,
			model: config.preferredModel,
			signal,
			timeoutMs: 120000,
		});

		return {
			url,
			title: extractHeadingTitle(text) ?? "YouTube Video",
			content: text,
			error: null,
		};
	} catch {
		return null;
	}
}

async function tryGeminiApi(
	url: string,
	prompt: string,
	config: YouTubeConfig,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		if (!isGeminiApiAvailable()) return null;

		if (signal?.aborted) return null;

		const text = await queryGeminiApiWithVideo(prompt, url, {
			model: config.preferredModel,
			signal,
			timeoutMs: 120000,
		});

		return {
			url,
			title: extractHeadingTitle(text) ?? "YouTube Video",
			content: text,
			error: null,
		};
	} catch {
		return null;
	}
}

async function tryPerplexity(
	url: string,
	prompt: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		if (signal?.aborted) return null;

		const perplexityQuery = prompt === YOUTUBE_PROMPT
			? `Summarize this YouTube video in detail: ${url}`
			: `${prompt} YouTube video: ${url}`;

		const { answer } = await searchWithPerplexity(
			perplexityQuery,
			{ signal },
		);

		if (!answer) return null;

		const content =
			`# Video Summary (via Perplexity)\n\n${answer}\n\n` +
			`*Full video understanding requires Gemini access. Set GEMINI_API_KEY or sign into Google in Chrome.*`;

		return {
			url,
			title: "Video Summary (via Perplexity)",
			content,
			error: null,
		};
	} catch {
		return null;
	}
}
