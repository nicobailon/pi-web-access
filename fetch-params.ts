export interface FetchContentParams {
	url?: unknown;
	urls?: unknown;
	forceClone?: unknown;
	prompt?: unknown;
	timestamp?: unknown;
	frames?: unknown;
	model?: unknown;
}

export interface NormalizedFetchContentParams {
	urlList: string[];
	options: {
		forceClone?: boolean;
		prompt?: string;
		timestamp?: string;
		frames?: number;
		model?: string;
	};
}

export function normalizeFetchContentParams(params: FetchContentParams): NormalizedFetchContentParams {
	const normalizedUrls = uniqueUrls(normalizeUrlArray(params.urls));
	const urlList = normalizedUrls.length > 0 ? normalizedUrls : normalizeSingleUrl(params.url);
	const prompt = normalizeOptionalString(params.prompt);
	const timestamp = normalizeOptionalString(params.timestamp);
	const frames = normalizeOptionalInteger(params.frames);

	const shouldIncludeFrames = frames !== undefined && (timestamp !== undefined || frames > 1);

	return {
		urlList,
		options: {
			forceClone: typeof params.forceClone === "boolean" ? params.forceClone : undefined,
			prompt,
			timestamp,
			frames: shouldIncludeFrames ? frames : undefined,
			model: normalizeOptionalString(params.model),
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

function normalizeOptionalInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined;
	return value;
}

function uniqueUrls(urls: string[]): string[] {
	return [...new Set(urls)];
}
