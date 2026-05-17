import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface BrowserConfig {
	browserStealthEnabled?: boolean;
	stealthLaunchMode?: boolean;
}

let cachedConfig: BrowserConfig | null = null;

function loadConfig(): BrowserConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { browserStealthEnabled?: unknown; stealthLaunchMode?: unknown };
	try {
		raw = JSON.parse(rawText) as { browserStealthEnabled?: unknown; stealthLaunchMode?: unknown };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	cachedConfig = {
		browserStealthEnabled: raw.browserStealthEnabled === true,
		stealthLaunchMode: raw.stealthLaunchMode === true,
	};
	return cachedConfig;
}

export function isBrowserStealthAvailable(): boolean {
	if (process.env.PI_ALLOW_BROWSER_COOKIES === "1" || process.env.FEYNMAN_ALLOW_BROWSER_COOKIES === "1") {
		return true;
	}
	return loadConfig().browserStealthEnabled === true;
}

export function getStealthLaunchMode(): boolean {
	return loadConfig().stealthLaunchMode === true;
}
