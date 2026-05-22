import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const LOCAL_FIRECRAWL_URL = "http://localhost:3002";
const DEFAULT_TIMEOUT_MS = 30000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export interface FirecrawlConfig {
	apiKey: string | null;
	baseUrl: string;
	timeoutMs: number;
}

interface FirecrawlConfigRaw {
	firecrawlApiKey?: unknown;
	firecrawlBaseUrl?: unknown;
	firecrawlTimeoutMs?: unknown;
}

let cachedConfig: FirecrawlConfig | null = null;

/**
 * Check if a local Firecrawl instance is running by pinging the root endpoint.
 * Returns the base URL if reachable, null otherwise.
 */
async function detectLocalFirecrawl(): Promise<string | null> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
		const res = await fetch(LOCAL_FIRECRAWL_URL, { signal: controller.signal });
		clearTimeout(timer);
		// Any HTTP response (even 404) means the server is up
		if (res.status >= 100 && res.status < 600) {
			return LOCAL_FIRECRAWL_URL;
		}
	} catch {
		// Connection refused or timeout — not running
	}
	return null;
}

function loadConfig(): FirecrawlConfigRaw {
	if (!existsSync(CONFIG_PATH)) {
		return {};
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	try {
		return JSON.parse(rawText) as FirecrawlConfigRaw;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

export async function getFirecrawlConfig(): Promise<FirecrawlConfig | null> {
	if (cachedConfig) return cachedConfig;

	const envKey = process.env.FIRECRAWL_API_KEY?.trim() ?? null;
	const config = loadConfig();
	const configKey = typeof config.firecrawlApiKey === "string"
		? config.firecrawlApiKey.trim()
		: null;
	const apiKey = envKey || configKey || null;

	let baseUrl: string;

	// User-configured URL takes priority
	if (typeof config.firecrawlBaseUrl === "string" && config.firecrawlBaseUrl.trim().length > 0) {
		baseUrl = config.firecrawlBaseUrl.trim();
	} else {
		// Auto-detect local Firecrawl, fall back to cloud
		const localUrl = await detectLocalFirecrawl();
		baseUrl = localUrl ?? DEFAULT_BASE_URL;
	}

	// Self-hosted Firecrawl: API keys are optional (per SELF_HOST.md).
	// Only required when connecting to the cloud service (api.firecrawl.dev).
	const isSelfHosted = baseUrl !== DEFAULT_BASE_URL;
	if (!apiKey && !isSelfHosted) {
		const timeoutMs = typeof config.firecrawlTimeoutMs === "number" && Number.isFinite(config.firecrawlTimeoutMs) && config.firecrawlTimeoutMs > 0
			? config.firecrawlTimeoutMs
			: DEFAULT_TIMEOUT_MS;
		cachedConfig = { apiKey: null, baseUrl, timeoutMs };
		return cachedConfig;
	}

	const timeoutMs = typeof config.firecrawlTimeoutMs === "number" && Number.isFinite(config.firecrawlTimeoutMs) && config.firecrawlTimeoutMs > 0
		? config.firecrawlTimeoutMs
		: DEFAULT_TIMEOUT_MS;

	cachedConfig = { apiKey, baseUrl, timeoutMs };
	return cachedConfig;
}

export function isFirecrawlAvailable(): boolean {
	// Sync check: available if config exists or local is reachable
	try {
		const config = loadConfig();
		if (typeof config.firecrawlBaseUrl === "string" && config.firecrawlBaseUrl.trim().length > 0) return true;
	} catch {}
	if (process.env.FIRECRAWL_API_KEY) return true;
	// Cloud is always "available" as a fallback (will fail at runtime if no key)
	return true;
}
