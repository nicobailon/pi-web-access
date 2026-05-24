import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, extname, basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { activityMonitor } from "./activity.js";
// Gemini API disabled - using local model instead
import { extractHeadingTitle, type ExtractedContent, type ExtractOptions, type FrameResult } from "./extract.js";
import { computeRangeTimestamps } from "./extract.js";
import { readExecError, trimErrorText, mapFfmpegError } from "./utils.js";
import type { VideoFrame } from "./extract.js";
import { queryLocalLlmMultimodal, type MultimodalContent } from "./local-llm-api.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
// Gemini API disabled - using local LLM instead

const DEFAULT_VIDEO_PROMPT = `Extract the complete content of this video. Include:
1. Video title (infer from content if not explicit), duration
2. A brief summary (2-3 sentences)
3. Full transcript with timestamps
4. Descriptions of any code, terminal commands, diagrams, slides, or UI shown on screen

Format as markdown.`;

const VIDEO_EXTENSIONS: Record<string, string> = {
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".avi": "video/x-msvideo",
	".mpeg": "video/mpeg",
	".mpg": "video/mpeg",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".3gp": "video/3gpp",
	".3gpp": "video/3gpp",
};

function shouldRethrow(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return message.startsWith("Failed to parse ");
}

interface VideoFileInfo {
	absolutePath: string;
	mimeType: string;
	sizeBytes: number;
}

interface VideoConfig {
	enabled: boolean;
	preferredModel: string;
	maxSizeMB: number;
}

function normalizePreferredModel(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeMaxSizeMB(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

const VIDEO_CONFIG_DEFAULTS: VideoConfig = {
	enabled: true,
	preferredModel: "qwen3.6-35b",
	maxSizeMB: 50,
};

let cachedVideoConfig: VideoConfig | null = null;

function loadVideoConfig(): VideoConfig {
	if (cachedVideoConfig) return cachedVideoConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedVideoConfig = { ...VIDEO_CONFIG_DEFAULTS };
		return cachedVideoConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { video?: { enabled?: boolean; preferredModel?: string; maxSizeMB?: number } };
	try {
		raw = JSON.parse(rawText) as { video?: { enabled?: boolean; preferredModel?: string; maxSizeMB?: number } };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const v = raw.video ?? {};
	cachedVideoConfig = {
		enabled: normalizeEnabled(v.enabled, VIDEO_CONFIG_DEFAULTS.enabled),
		preferredModel: normalizePreferredModel(v.preferredModel, VIDEO_CONFIG_DEFAULTS.preferredModel),
		maxSizeMB: normalizeMaxSizeMB(v.maxSizeMB, VIDEO_CONFIG_DEFAULTS.maxSizeMB),
	};
	return cachedVideoConfig;
}

export function isVideoFile(input: string): VideoFileInfo | null {
	const config = loadVideoConfig();
	if (!config.enabled) return null;

	const isFilePath = input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input.startsWith("file://");
	if (!isFilePath) return null;

	let filePath = input;
	if (input.startsWith("file://")) {
		try {
			filePath = decodeURIComponent(new URL(input).pathname);
		} catch {
			return null;
		}
	}

	const ext = extname(filePath).toLowerCase();
	const mimeType = VIDEO_EXTENSIONS[ext];
	if (!mimeType) return null;

	const absolutePath = resolveFilePath(filePath);
	if (!absolutePath) return null;

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolutePath);
	} catch {
		return null;
	}
	if (!stat.isFile()) return null;

	const maxBytes = config.maxSizeMB * 1024 * 1024;
	if (stat.size > maxBytes) return null;

	return { absolutePath, mimeType, sizeBytes: stat.size };
}

function resolveFilePath(filePath: string): string | null {
	const absolutePath = resolve(filePath);
	if (existsSync(absolutePath)) return absolutePath;

	const dir = dirname(absolutePath);
	const base = basename(absolutePath);
	if (!existsSync(dir)) return null;

	try {
		const normalizedBase = normalizeSpaces(base);
		const match = readdirSync(dir).find(f => normalizeSpaces(f) === normalizedBase);
		return match ? join(dir, match) : null;
	} catch {
		return null;
	}
}

function normalizeSpaces(s: string): string {
	return s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

export async function extractVideo(
	info: VideoFileInfo,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent | null> {
	const config = loadVideoConfig();
	const effectivePrompt = options?.prompt ?? DEFAULT_VIDEO_PROMPT;
	const effectiveModel = options?.model ?? config.preferredModel;
	const displayName = basename(info.absolutePath);
	const activityId = activityMonitor.logStart({ type: "fetch", url: `video:${displayName}` });

	const result = await tryVideoLocalLlm(info, effectivePrompt, effectiveModel, signal);

	if (result) {
		const thumbnail = await extractVideoFrame(info.absolutePath);
		if (!("error" in thumbnail)) {
			result.thumbnail = thumbnail;
		}
		activityMonitor.logComplete(activityId, 200);
		return result;
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	activityMonitor.logError(activityId, "all video extraction paths failed");
	return null;
}

function mapFfprobeError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffprobe is not installed. Install ffmpeg which includes ffprobe";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffprobe failed: ${snippet}` : "ffprobe failed";
}

export async function extractVideoFrame(filePath: string, seconds: number = 1): Promise<FrameResult> {
	try {
		const buffer = execFileSync("ffmpeg", [
			"-ss", String(seconds), "-i", filePath,
			"-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
		], { maxBuffer: 5 * 1024 * 1024, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
		if (buffer.length === 0) return { error: "ffmpeg failed: empty output" };
		return { data: buffer.toString("base64"), mimeType: "image/jpeg" };
	} catch (err) {
		return { error: mapFfmpegError(err) };
	}
}

export async function getLocalVideoDuration(filePath: string): Promise<number | { error: string }> {
	try {
		const output = execFileSync("ffprobe", [
			"-v", "quiet",
			"-show_entries", "format=duration",
			"-of", "csv=p=0",
			filePath,
		], { timeout: 10000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
		const duration = Number.parseFloat(output);
		if (!Number.isFinite(duration)) return { error: "ffprobe failed: invalid duration output" };
		return duration;
	} catch (err) {
		return { error: mapFfprobeError(err) };
	}
}



async function tryVideoLocalLlm(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	if (signal?.aborted) return null;

	// Extract frames from video (Qwen3.6 supports up to 60s at 1fps)
	const duration = await getLocalVideoDuration(info.absolutePath);
	if (typeof duration !== "number") return null;

	// Cap at 60 frames (60 seconds) for Qwen3.6 video understanding
	const maxFrames = Math.min(60, Math.floor(duration));
	const timestamps = computeRangeTimestamps(0, Math.floor(duration), maxFrames);
	const frames: VideoFrame[] = [];
	for (const t of timestamps) {
		const frame = await extractVideoFrame(info.absolutePath, t);
		if (!("error" in frame)) frames.push(frame);
	}

	if (frames.length === 0) return null;

	// Use multimodal API with image frames (Qwen3.6 E2B native image support)
	// Per Qwen3.6 docs: use lower token budget (70-140) for video understanding
	const contents = frames.map((f) => ({
		type: "image" as const,
		base64: f.data,
		mimeType: f.mimeType,
	}));

	// Add text prompt after images (Qwen3.6 best practice: images before text)
	contents.push({
		type: "text" as const,
		text: prompt || DEFAULT_VIDEO_PROMPT,
	});

	try {
		const text = await queryLocalLlmMultimodal(contents, { model, signal, timeoutMs: 120000, maxTokens: 2048 });
		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
			frames,
			duration: duration ?? undefined,
		};
	} catch (err) {
		if (shouldRethrow(err)) throw err;
		return null;
	}
}

// Gemini API functions removed - using local LLM with frames instead

function extractVideoTitle(text: string, filePath: string): string {
	return extractHeadingTitle(text) ?? basename(filePath, extname(filePath));
}
