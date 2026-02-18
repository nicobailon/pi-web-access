import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, extname, basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { activityMonitor } from "./activity.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { queryGeminiApiWithVideo, getApiKey, API_BASE } from "./gemini-api.js";
import { extractHeadingTitle, type ExtractedContent, type ExtractOptions, type FrameResult } from "./extract.js";
import { readExecError, trimErrorText, mapFfmpegError } from "./utils.js";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

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

const VIDEO_CONFIG_DEFAULTS: VideoConfig = {
	enabled: true,
	preferredModel: "gemini-3-flash-preview",
	maxSizeMB: 50,
};

let cachedVideoConfig: VideoConfig | null = null;

function loadVideoConfig(): VideoConfig {
	if (cachedVideoConfig) return cachedVideoConfig;
	try {
		if (existsSync(CONFIG_PATH)) {
			const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
			const v = raw.video ?? {};
			cachedVideoConfig = {
				enabled: v.enabled ?? VIDEO_CONFIG_DEFAULTS.enabled,
				preferredModel: v.preferredModel ?? VIDEO_CONFIG_DEFAULTS.preferredModel,
				maxSizeMB: v.maxSizeMB ?? VIDEO_CONFIG_DEFAULTS.maxSizeMB,
			};
			return cachedVideoConfig;
		}
	} catch {}
	cachedVideoConfig = { ...VIDEO_CONFIG_DEFAULTS };
	return cachedVideoConfig;
}

export function isVideoFile(input: string): VideoFileInfo | null {
	const config = loadVideoConfig();
	if (!config.enabled) return null;

	const isFilePath = input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input.startsWith("file://");
	if (!isFilePath) return null;

	const filePath = input.startsWith("file://") ? new URL(input).pathname : input;

	const ext = extname(filePath).toLowerCase();
	const mimeType = VIDEO_EXTENSIONS[ext];
	if (!mimeType) return null;

	const absolutePath = resolveFilePath(filePath);
	if (!absolutePath) return null;

	const stat = statSync(absolutePath);
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

	const result = await tryVideoGeminiApi(info, effectivePrompt, effectiveModel, signal)
		?? await tryVideoGeminiWeb(info, effectivePrompt, effectiveModel, signal);

	if (result) {
		const thumbnail = await extractVideoFrame(info.absolutePath);
		if (!("error" in thumbnail)) {
			result.thumbnail = thumbnail;
		}
		activityMonitor.logComplete(activityId, 200);
		return result;
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
		const { execFileSync } = await import("node:child_process");
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
		const { execFileSync } = await import("node:child_process");
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

async function tryVideoGeminiWeb(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	try {
		const availability = await isGeminiWebAvailable();
		if (!availability) return null;
		if (signal?.aborted) return null;

		const text = await queryWithCookies(prompt, availability.cookies, {
			files: [info.absolutePath],
			model,
			signal,
			timeoutMs: 180000,
		});

		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
		};
	} catch {
		return null;
	}
}

async function tryVideoGeminiApi(
	info: VideoFileInfo,
	prompt: string,
	model: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;
	if (signal?.aborted) return null;

	let fileName: string | null = null;
	try {
		const uploaded = await uploadToFilesApi(info, apiKey, signal);
		fileName = uploaded.name;

		await pollFileState(fileName, apiKey, signal, 120000);

		const text = await queryGeminiApiWithVideo(prompt, uploaded.uri, {
			model,
			mimeType: info.mimeType,
			signal,
			timeoutMs: 120000,
		});

		return {
			url: info.absolutePath,
			title: extractVideoTitle(text, info.absolutePath),
			content: text,
			error: null,
		};
	} catch {
		return null;
	} finally {
		if (fileName) deleteGeminiFile(fileName, apiKey);
	}
}

async function uploadToFilesApi(
	info: VideoFileInfo,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ name: string; uri: string }> {
	const displayName = basename(info.absolutePath);

	const initRes = await fetch(`${UPLOAD_BASE}/files`, {
		method: "POST",
		headers: {
			"x-goog-api-key": apiKey,
			"X-Goog-Upload-Protocol": "resumable",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": String(info.sizeBytes),
			"X-Goog-Upload-Header-Content-Type": info.mimeType,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ file: { display_name: displayName } }),
		signal,
	});

	if (!initRes.ok) {
		const text = await initRes.text();
		throw new Error(`File upload init failed: ${initRes.status} (${text.slice(0, 200)})`);
	}

	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	if (!uploadUrl) throw new Error("No upload URL in response headers");

	const fileData = await readFile(info.absolutePath);
	const uploadRes = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Length": String(info.sizeBytes),
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
		},
		body: fileData,
		signal,
	});

	if (!uploadRes.ok) {
		const text = await uploadRes.text();
		throw new Error(`File upload failed: ${uploadRes.status} (${text.slice(0, 200)})`);
	}

	const result = await uploadRes.json() as { file: { name: string; uri: string } };
	return result.file;
}

async function pollFileState(
	fileName: string,
	apiKey: string,
	signal?: AbortSignal,
	timeoutMs: number = 120000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Aborted");

		const res = await fetch(`${API_BASE}/${fileName}?key=${apiKey}`, { signal });
		if (!res.ok) throw new Error(`File state check failed: ${res.status}`);

		const data = await res.json() as { state: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") throw new Error("File processing failed");

		await new Promise(r => setTimeout(r, 5000));
	}

	throw new Error("File processing timed out");
}

function deleteGeminiFile(fileName: string, apiKey: string): void {
	fetch(`${API_BASE}/${fileName}?key=${apiKey}`, { method: "DELETE" }).catch(() => {});
}

function extractVideoTitle(text: string, filePath: string): string {
	return extractHeadingTitle(text) ?? basename(filePath, extname(filePath));
}
