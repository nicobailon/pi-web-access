import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_API_HOST = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";
/**
 * @deprecated Use `getVersionedApiBase()` instead.
 * Kept for backward compatibility with external imports.
 */
export const API_BASE = `${DEFAULT_API_HOST}/${API_VERSION}`;
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
export const DEFAULT_MODEL = "gemini-3-flash-preview";

interface GeminiApiConfig {
	geminiApiKey?: unknown;
	/**
	 * Override the Gemini API host URL (no trailing slash, no version segment).
	 * Matches the `GOOGLE_GEMINI_BASE_URL` env var used by the official Gemini CLI.
	 * Example: "https://my-gateway.example.com/gemini"
	 */
	geminiBaseUrl?: unknown;
	/**
	 * API key for Cloudflare AI Gateway (`cf-aig-authorization` header).
	 * Matches the `CLOUDFLARE_API_KEY` env var used by pi core for the same gateway.
	 */
	cloudflareApiKey?: unknown;
}

let cachedConfig: GeminiApiConfig | null = null;

function loadConfig(): GeminiApiConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as GeminiApiConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

export function getApiKey(): string | null {
	return normalizeApiKey(process.env.GEMINI_API_KEY) ?? normalizeApiKey(loadConfig().geminiApiKey);
}

function normalizeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/\/+$/, "");
	return normalized.length > 0 ? normalized : null;
}

/**
 * Returns the effective Gemini API host (no version segment, no trailing slash).
 * Resolution order:
 * 1. `GOOGLE_GEMINI_BASE_URL` env var (matches the official Gemini CLI)
 * 2. `geminiBaseUrl` in ~/.pi/web-search.json
 * 3. Google's default endpoint
 */
export function getApiHost(): string {
	return (
		normalizeBaseUrl(process.env.GOOGLE_GEMINI_BASE_URL) ??
		normalizeBaseUrl(loadConfig().geminiBaseUrl) ??
		DEFAULT_API_HOST
	);
}

/**
 * Returns the versioned Gemini API base URL ready for appending a path segment.
 * Example: "https://generativelanguage.googleapis.com/v1beta"
 */
export function getVersionedApiBase(): string {
	return `${getApiHost()}/${API_VERSION}`;
}

/**
 * Returns true when the configured API host is a Cloudflare AI Gateway endpoint.
 * Detected purely from the URL — no hardcoded config keys.
 */
function isCloudflareGateway(): boolean {
	return getApiHost().includes("gateway.ai.cloudflare.com");
}

/**
 * Returns the `?key=<apiKey>` query param string, or an empty string when
 * the request should use header-based auth instead (e.g. Cloudflare AI Gateway).
 */
export function buildKeyParam(apiKey: string | null): string {
	if (!apiKey || isCloudflareGateway()) return "";
	return `?key=${apiKey}`;
}

/**
 * Returns the Cloudflare API key for gateway auth.
 * Resolution order: CLOUDFLARE_API_KEY env var, then cloudflareApiKey in config.
 */
export function getCloudflareApiKey(): string | null {
	return normalizeApiKey(process.env.CLOUDFLARE_API_KEY) ?? normalizeApiKey(loadConfig().cloudflareApiKey);
}

/**
 * Returns true when a Cloudflare AI Gateway is configured and a gateway token is available.
 * In this case, no Gemini API key is required.
 */
export function isGatewayConfigured(): boolean {
	return isCloudflareGateway() && getCloudflareApiKey() !== null;
}

/**
 * Returns any additional auth headers required for the current API host.
 * For Cloudflare AI Gateway, this is `cf-aig-authorization: Bearer <token>`
 * using the Cloudflare API key (matching how pi core handles the same gateway).
 * For the default Google endpoint, returns an empty object.
 */
export function buildAuthHeaders(): Record<string, string> {
	if (isCloudflareGateway()) {
		const cfKey = getCloudflareApiKey();
		if (cfKey) return { "cf-aig-authorization": `Bearer ${cfKey}` };
	}
	return {};
}

export function isGeminiApiAvailable(): boolean {
	return getApiKey() !== null || isGatewayConfigured();
}

export interface GeminiApiOptions {
	model?: string;
	mimeType?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function queryGeminiApiWithVideo(
	prompt: string,
	videoUri: string,
	options: GeminiApiOptions = {},
): Promise<string> {
	const apiKey = getApiKey();
	if (!apiKey && !isGatewayConfigured()) throw new Error(
		"Gemini API not configured. Either:\n" +
		"  1. Set GEMINI_API_KEY in ~/.pi/web-search.json\n" +
		"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing"
	);

	const model = options.model ?? DEFAULT_MODEL;
	const signal = withTimeout(options.signal, options.timeoutMs ?? 120000);
	const url = `${getVersionedApiBase()}/models/${model}:generateContent${buildKeyParam(apiKey)}`;

	const fileData: Record<string, string> = { fileUri: videoUri };
	if (options.mimeType) fileData.mimeType = options.mimeType;

	const body = {
		contents: [
			{
				role: "user",
				parts: [
					{ fileData },
					{ text: prompt },
				],
			},
		],
	};

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
		body: JSON.stringify(body),
		signal,
	});

	if (!res.ok) {
		const errorText = await res.text();
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	const data = (await res.json()) as GenerateContentResponse;
	const text = data.candidates?.[0]?.content?.parts
		?.map((p) => p.text)
		.filter(Boolean)
		.join("\n");

	if (!text) throw new Error("Gemini API returned empty response");
	return text;
}

interface GenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
}
