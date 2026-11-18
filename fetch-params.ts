import { normalizeProxyUrl } from "./utils.ts";

export interface FetchContentParams {
	url?: unknown;
	urls?: unknown;
	forceClone?: unknown;
	prompt?: unknown;
	timestamp?: unknown;
	frames?: unknown;
	model?: unknown;
	mode?: unknown;
	answerModel?: unknown;
	fields?: unknown;
	auth?: unknown;
	proxy?: unknown;
	redirects?: unknown;
}

export interface NormalizedFetchContentParams {
	urlList: string[];
	/** Parameter-level validation problems collected during normalization
	 * instead of throwing, so callers can report them together with their own
	 * checks in a single round-trip. */
	problems: string[];
	options: {
		forceClone?: boolean;
		prompt?: string;
		timestamp?: string;
		frames?: number;
		model?: string;
		mode?: "readable" | "raw" | "answer" | "extract";
		answerModel?: string;
		auth?: true | string;
		proxy?: string;
		redirects?: "same-origin";
	};
}

/** Lists the parameter names that actually arrived, for error diagnostics:
 * dropped tool-call arguments (provider issue) show up as missing keys here,
 * malformed ones as present keys with unusable values. */
export function describeReceivedParams(params: FetchContentParams): string {
	const keys = Object.keys(params);
	return keys.length > 0 ? keys.join(", ") : "none";
}

export function normalizeFetchContentParams(params: FetchContentParams): NormalizedFetchContentParams {
	const problems: string[] = [];
	const normalizedUrls = uniqueUrls(normalizeUrlArray(params.urls));
	const urlList = normalizedUrls.length > 0 ? normalizedUrls : normalizeSingleUrl(params.url);
	const prompt = normalizeOptionalString(params.prompt);
	const timestamp = normalizeOptionalString(params.timestamp);
	const frames = normalizeOptionalFrameCount(params.frames);

	const shouldIncludeFrames = frames !== undefined && (timestamp !== undefined || frames > 1);

	const forceClone = typeof params.forceClone === "boolean" ? params.forceClone : undefined;
	const model = normalizeOptionalString(params.model);
	const mode = normalizeMode(params.mode, problems);
	const answerModel = normalizeOptionalString(params.answerModel);
	const auth = normalizeAuth(params.auth, problems);
	const proxy = normalizeProxy(params.proxy, problems);
	const redirects = normalizeRedirects(params.redirects, problems);

	return {
		urlList,
		problems,
		options: {
			...(forceClone !== undefined ? { forceClone } : {}),
			...(prompt !== undefined ? { prompt } : {}),
			...(timestamp !== undefined ? { timestamp } : {}),
			...(shouldIncludeFrames ? { frames } : {}),
			...(model !== undefined ? { model } : {}),
			...(mode !== undefined ? { mode } : {}),
			...(answerModel !== undefined ? { answerModel } : {}),
			...(auth !== undefined ? { auth } : {}),
			...(proxy !== undefined ? { proxy } : {}),
			...(redirects !== undefined ? { redirects } : {}),
		},
	};
}

function normalizeUrlArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(normalizeSingleUrl);
}

function normalizeSingleUrl(value: unknown): string[] {
	if (typeof value !== "string") return [];
	const trimmed = value.trim();
	return trimmed ? [trimmed] : [];
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function normalizeMode(value: unknown, problems: string[]): "readable" | "raw" | "answer" | "extract" | undefined {
	if (value === undefined) return undefined;
	if (value === "readable" || value === "raw" || value === "answer" || value === "extract") return value;
	problems.push('mode must be "readable", "raw", "answer", or "extract"');
	return undefined;
}

function normalizeRedirects(value: unknown, problems: string[]): "same-origin" | undefined {
	if (value === undefined) return undefined;
	if (value === "same-origin") return value;
	problems.push('redirects must be "same-origin"');
	return undefined;
}

function normalizeAuth(value: unknown, problems: string[]): true | string | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return true;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	problems.push("auth must be a profile name, true, or false");
	return undefined;
}

function normalizeProxy(value: unknown, problems: string[]): string | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === null) {
		problems.push("proxy must be an http(s) or socks proxy URL string");
		return undefined;
	}
	try {
		const normalized = normalizeProxyUrl(value, "proxy");
		return normalized ?? "";
	} catch (err) {
		problems.push(err instanceof Error ? err.message : String(err));
		return undefined;
	}
}

function normalizeOptionalFrameCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 12) return undefined;
	return value;
}

function uniqueUrls(urls: string[]): string[] {
	return [...new Set(urls)];
}
