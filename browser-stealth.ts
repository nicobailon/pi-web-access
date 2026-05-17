import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFilePromise = promisify(execFile);

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface BrowserStealthConfig {
	browserStealthEnabled?: unknown;
	stealthLaunchMode?: unknown;
	chromeProfile?: unknown;
}

let cachedConfig: BrowserStealthConfig | null = null;

function loadBrowserConfig(): BrowserStealthConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as BrowserStealthConfig;
		return cachedConfig;
	} catch {
		cachedConfig = {};
		return cachedConfig;
	}
}

function normalizeBoolean(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.toLowerCase() === "true";
	return false;
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value === "string") {
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : undefined;
	}
	return undefined;
}

export function isBrowserStealthEnabled(): boolean {
	const config = loadBrowserConfig();
	return normalizeBoolean(config.browserStealthEnabled);
}

export function getStealthLaunchMode(): string | undefined {
	return normalizeString(loadBrowserConfig().stealthLaunchMode);
}

export function getChromeProfile(): string | undefined {
	return normalizeString(loadBrowserConfig().chromeProfile);
}

export interface StealthOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface StealthResult {
	content: string;
	title: string;
	error: string | null;
}

/**
 * Navigate to a URL using agent-browser-stealth and extract page content.
 * Uses the `agent-browser-stealth` CLI which provides undetectable browser automation.
 */
export async function stealthNavigate(
	url: string,
	options: StealthOptions = {},
): Promise<StealthResult> {
	const timeoutMs = options.timeoutMs ?? 60000;

	try {
		const args: string[] = [
			"scrape",
			url,
			"--format", "markdown",
		];

		const chromeProfile = getChromeProfile();
		if (chromeProfile) {
			args.push("--profile", chromeProfile);
		}

		const result = await execFilePromise("agent-browser-stealth", args, {
			timeout: timeoutMs,
			signal: options.signal,
			maxBuffer: 10 * 1024 * 1024,
		});

		const output = result.stdout || "";
		const title = extractTitle(output) || new URL(url).pathname.split("/").pop() || url;

		return { content: output.trim(), title, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("signal")) {
			return { content: "", title: "", error: "Aborted" };
		}
		return { content: "", title: "", error: `Browser stealth failed: ${message}` };
	}
}

/**
 * Extract cookies from a URL using agent-browser-stealth.
 * Falls back to Chrome cookie extraction if CLI is unavailable.
 */
export async function stealthCookieExtract(
	url: string,
	options: StealthOptions = {},
): Promise<Record<string, string> | null> {
	try {
		const args: string[] = [
			"cookies",
			url,
			"--json",
		];

		const result = await execFilePromise("agent-browser-stealth", args, {
			timeout: options.timeoutMs ?? 30000,
			signal: options.signal,
			maxBuffer: 1024 * 1024,
		});

		const output = result.stdout?.trim();
		if (!output) return null;

		return JSON.parse(output) as Record<string, string>;
	} catch {
		// Fall back to Chrome cookie extraction
		return null;
	}
}

/**
 * Take a snapshot of a page using agent-browser-stealth.
 */
export async function stealthSnapshot(
	url: string,
	options: StealthOptions = {},
): Promise<{ html: string; title: string } | null> {
	try {
		const args: string[] = [
			"scrape",
			url,
			"--format", "html",
		];

		const result = await execFilePromise("agent-browser-stealth", args, {
			timeout: options.timeoutMs ?? 60000,
			signal: options.signal,
			maxBuffer: 10 * 1024 * 1024,
		});

		const output = result.stdout || "";
		const title = extractTitle(output) || new URL(url).pathname.split("/").pop() || url;

		return { html: output, title };
	} catch {
		return null;
	}
}

function extractTitle(content: string): string | null {
	const match = content.match(/^#{1,2}\s+(.+)/m);
	if (match) return match[1].replace(/\*+/g, "").trim();

	const htmlMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
	if (htmlMatch) return htmlMatch[1].trim();

	return null;
}
