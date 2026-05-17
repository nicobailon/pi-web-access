import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 30000;

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

export function getFirecrawlConfig(): FirecrawlConfig | null {
	if (cachedConfig) return cachedConfig;

	const envKey = process.env.FIRECRAWL_API_KEY?.trim() ?? null;
	const config = loadConfig();
	const configKey = typeof config.firecrawlApiKey === "string"
		? config.firecrawlApiKey.trim()
		: null;
	const apiKey = envKey || configKey || null;

	if (!apiKey) return null;

	const baseUrl = typeof config.firecrawlBaseUrl === "string" && config.firecrawlBaseUrl.trim().length > 0
		? config.firecrawlBaseUrl.trim()
		: DEFAULT_BASE_URL;

	const timeoutMs = typeof config.firecrawlTimeoutMs === "number" && Number.isFinite(config.firecrawlTimeoutMs) && config.firecrawlTimeoutMs > 0
		? config.firecrawlTimeoutMs
		: DEFAULT_TIMEOUT_MS;

	cachedConfig = { apiKey, baseUrl, timeoutMs };
	return cachedConfig;
}

export function isFirecrawlAvailable(): boolean {
	return getFirecrawlConfig() !== null;
}
