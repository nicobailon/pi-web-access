import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface FirecrawlConfig {
	firecrawlApiKey?: unknown;
	firecrawlBaseUrl?: unknown;
}

let cachedConfig: FirecrawlConfig | null = null;

function loadConfig(): FirecrawlConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as FirecrawlConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

export function getFirecrawlApiKey(): string | null {
	return normalizeApiKey(process.env.FIRECRAWL_API_KEY) ?? normalizeApiKey(loadConfig().firecrawlApiKey);
}

export function getFirecrawlBaseUrl(): string {
	const custom = normalizeApiKey(loadConfig().firecrawlBaseUrl);
	if (custom) return custom.replace(/\/+$/, "");
	return FIRECRAWL_API_BASE.replace("/v1", "");
}

export function isFirecrawlAvailable(): boolean {
	return getFirecrawlApiKey() !== null;
}

export interface FirecrawlConfigValue {
	apiKey: string;
	baseUrl: string;
}

export function getFirecrawlConfig(): FirecrawlConfigValue | null {
	const apiKey = getFirecrawlApiKey();
	if (!apiKey) return null;
	return {
		apiKey,
		baseUrl: getFirecrawlBaseUrl(),
	};
}
