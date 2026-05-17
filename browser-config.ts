import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface BrowserConfig {
	chromeProfile?: string;
	allowBrowserCookies?: boolean;
	browserStealthEnabled?: boolean;
	stealthLaunchMode?: string;
}

let cachedConfig: BrowserConfig | null = null;

export function normalizeChromeProfile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function loadConfig(): BrowserConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { chromeProfile?: unknown; allowBrowserCookies?: unknown; browserStealthEnabled?: unknown; stealthLaunchMode?: unknown };
	try {
		raw = JSON.parse(rawText) as { chromeProfile?: unknown; allowBrowserCookies?: unknown; browserStealthEnabled?: unknown; stealthLaunchMode?: unknown };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	cachedConfig = {
		chromeProfile: normalizeChromeProfile(raw.chromeProfile),
		allowBrowserCookies: raw.allowBrowserCookies === true,
		browserStealthEnabled: raw.browserStealthEnabled === true,
		stealthLaunchMode: typeof raw.stealthLaunchMode === "string" ? raw.stealthLaunchMode.trim() || undefined : undefined,
	};
	return cachedConfig;
}

export function getChromeProfileFromConfig(): string | undefined {
	return loadConfig().chromeProfile;
}

export function isBrowserCookieAccessAllowed(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	return loadConfig().allowBrowserCookies === true;
}

export function getStealthLaunchMode(): string | undefined {
	return loadConfig().stealthLaunchMode;
}

export function isBrowserStealthEnabled(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	const config = loadConfig();
	if (config.browserStealthEnabled !== undefined) return config.browserStealthEnabled;
	// Default to true if chrome profile is configured
	return config.chromeProfile !== undefined;
}
