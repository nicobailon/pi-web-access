import { homedir } from "node:os";
import { join } from "node:path";

export function getWebSearchConfigDir(): string {
	if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
	if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "pi");
	return join(homedir(), ".pi");
}

export function getWebSearchConfigPath(): string {
	return join(getWebSearchConfigDir(), "web-search.json");
}

export function formatSeconds(s: number): string {
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

export function readExecError(err: unknown): { code?: string; stderr: string; message: string } {
	if (!err || typeof err !== "object") {
		return { stderr: "", message: String(err) };
	}
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	const stderrRaw = (err as { stderr?: Buffer | string }).stderr;
	const stderr = Buffer.isBuffer(stderrRaw)
		? stderrRaw.toString("utf-8")
		: typeof stderrRaw === "string"
			? stderrRaw
			: "";
	return { code, stderr, message };
}

export function isTimeoutError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	if ((err as { killed?: boolean }).killed) return true;
	const name = (err as { name?: string }).name;
	const code = (err as { code?: string }).code;
	const message = (err as { message?: string }).message ?? "";
	return name === "AbortError" || code === "ETIMEDOUT" || message.toLowerCase().includes("timed out");
}

export function trimErrorText(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function mapFfmpegError(err: unknown): string {
	const { code, stderr, message } = readExecError(err);
	if (code === "ENOENT") return "ffmpeg is not installed. Install with: brew install ffmpeg";
	if (isTimeoutError(err)) return "ffmpeg timed out extracting frame";
	if (stderr.includes("403")) return "Stream URL returned 403 — may have expired, try again";
	const snippet = trimErrorText(stderr || message);
	return snippet ? `ffmpeg failed: ${snippet}` : "ffmpeg failed";
}
