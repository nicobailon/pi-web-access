import { existsSync, readFileSync } from "node:fs";
import { getWebSearchConfigPath } from "./utils.ts";

const CONFIG_PATH = getWebSearchConfigPath();

interface GeminiWebConfig {
	browserCookies?: BrowserCookieSelection;
	allowBrowserCookies?: boolean;
}

const BROWSER_COOKIE_PRESETS = ["helium", "ardia", "chrome", "brave", "arc", "chromium", "edge"] as const;
export type BrowserCookiePreset = typeof BROWSER_COOKIE_PRESETS[number];

export interface BrowserCookieSelection {
	browser?: BrowserCookiePreset;
	profile?: string;
}

let cachedConfig: GeminiWebConfig | null = null;
// Set when the user allows browser cookie access for this session only; never written to config.
let sessionGrant: BrowserCookieSelection | null = null;

/** How a tool call can get browser cookie access turned on. */
export interface BrowserCookieConsent {
	/** Asks the user; resolves true once access is on, false on a no or when signal aborts. Absent without a UI. */
	ask?: (signal?: AbortSignal) => Promise<boolean>;
	/** Pi command that turns access on or off; absent outside Pi. */
	command?: string;
}

export function normalizeChromeProfile(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function parseBrowserCookies(value: unknown): BrowserCookieSelection | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`browserCookies in ${CONFIG_PATH} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	if ("profilePath" in raw) {
		throw new Error(`browserCookies.profilePath is not supported; use a browser preset and profile directory name in ${CONFIG_PATH}`);
	}
	let browser: BrowserCookiePreset | undefined;
	if (raw.browser !== undefined) browser = parseBrowserCookiePreset(raw.browser, "browserCookies.browser");
	if (raw.profile !== undefined && typeof raw.profile !== "string") {
		throw new Error(`browserCookies.profile in ${CONFIG_PATH} must be a profile directory name`);
	}
	const profile = normalizeChromeProfile(raw.profile);
	if (profile && (profile === "." || profile === ".." || profile.includes("/") || profile.includes("\\"))) {
		throw new Error(`browserCookies.profile in ${CONFIG_PATH} must be a profile directory name, not a path`);
	}
	return { ...(browser ? { browser } : {}), ...(profile ? { profile } : {}) };
}

export function parseBrowserCookiePreset(value: unknown, label: string): BrowserCookiePreset {
	if (typeof value !== "string") throw new Error(`${label} in ${CONFIG_PATH} must be a supported browser name`);
	const normalized = value.trim().toLowerCase();
	const preset = BROWSER_COOKIE_PRESETS.find((candidate) => candidate === normalized);
	if (!preset) throw new Error(`Unsupported ${label} ${JSON.stringify(value)} in ${CONFIG_PATH}`);
	return preset;
}

function loadConfig(): GeminiWebConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { chromeProfile?: unknown; browserCookies?: unknown; allowBrowserCookies?: unknown };
	try {
		raw = JSON.parse(rawText) as { chromeProfile?: unknown; browserCookies?: unknown; allowBrowserCookies?: unknown };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	if (raw.chromeProfile !== undefined) {
		throw new Error(`chromeProfile in ${CONFIG_PATH} is no longer supported; use browserCookies.profile`);
	}
	cachedConfig = {
		browserCookies: parseBrowserCookies(raw.browserCookies),
		allowBrowserCookies: raw.allowBrowserCookies === true,
	};
	return cachedConfig;
}

export function getBrowserCookieSelectionFromConfig(): BrowserCookieSelection {
	return { ...loadConfig().browserCookies };
}

/** The browser a session grant chose, otherwise the configured selection. */
export function getBrowserCookieSelection(): BrowserCookieSelection {
	return sessionGrant ? { ...sessionGrant } : getBrowserCookieSelectionFromConfig();
}

/** Turns browser cookie access on until the process exits, without saving anything. */
export function grantBrowserCookieAccessForSession(selection: BrowserCookieSelection): void {
	sessionGrant = { ...selection };
}

export function revokeBrowserCookieAccessForSession(): void {
	sessionGrant = null;
}

/** Call after writing web-search.json so the next read sees the new browser selection. */
export function clearGeminiWebConfigCache(): void {
	cachedConfig = null;
}

export function isBrowserCookieAccessAllowed(): boolean {
	if (sessionGrant) return true;
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	if (!existsSync(CONFIG_PATH)) return false;

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { allowBrowserCookies?: unknown };
	try {
		raw = JSON.parse(rawText) as { allowBrowserCookies?: unknown };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	return raw.allowBrowserCookies === true;
}
