import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { activityMonitor } from "./activity.js";
import { type CookieMap, getPerplexityCookies, isChromeCookieStoreAvailable } from "./chrome-cookies.js";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_WEB_URL = "https://www.perplexity.ai/rest/sse/perplexity_ask";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const CURL_CFFI_VENV_DIR = join(homedir(), ".pi", "cache", "pi-web-access", "curl-cffi-venv");
const CURL_CFFI_BOOTSTRAP_TIMEOUT_MS = 120_000;
const CURL_CFFI_REQUEST_TIMEOUT_MS = 90_000;

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

const WEB_SUPPORTED_BLOCKS = [
	"answer_modes",
	"media_items",
	"knowledge_cards",
	"inline_entity_cards",
	"place_widgets",
	"finance_widgets",
	"sports_widgets",
	"shopping_widgets",
	"jobs_widgets",
	"search_result_widgets",
	"clarification_responses",
	"inline_images",
	"inline_assets",
	"inline_finance_widgets",
	"placeholder_cards",
	"diff_blocks",
	"inline_knowledge_cards",
	"entity_group_v2",
	"refinement_filters",
	"canvas_mode",
];

const PERPLEXITY_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
}

export interface SearchOptions {
	numResults?: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
	signal?: AbortSignal;
}

interface WebSearchConfig {
	perplexityApiKey?: string;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;

	if (existsSync(CONFIG_PATH)) {
		try {
			const content = readFileSync(CONFIG_PATH, "utf-8");
			cachedConfig = JSON.parse(content) as WebSearchConfig;
			return cachedConfig;
		} catch {
			cachedConfig = {};
		}
	} else {
		cachedConfig = {};
	}
	return cachedConfig;
}

function getApiKey(): string | null {
	const config = loadConfig();
	return process.env.PERPLEXITY_API_KEY || config.perplexityApiKey || null;
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps.length > 0 && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
		const waitMs = requestTimestamps[0] + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

function hasPerplexitySessionCookie(cookieMap: CookieMap): boolean {
	return Boolean(cookieMap["__Secure-next-auth.session-token"] || cookieMap["next-auth.session-token"]);
}

export function isPerplexityAvailable(): boolean {
	return Boolean(getApiKey() || isChromeCookieStoreAvailable());
}

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	checkRateLimit();

	const activityId = activityMonitor.logStart({ type: "api", query });

	activityMonitor.updateRateLimit({
		used: requestTimestamps.length,
		max: RATE_LIMIT.maxRequests,
		oldestTimestamp: requestTimestamps[0] ?? null,
		windowMs: RATE_LIMIT.windowMs,
	});

	let apiError: Error | null = null;
	let webError: Error | null = null;

	try {
		const apiKey = getApiKey();
		if (apiKey) {
			try {
				const apiResult = await searchWithPerplexityApi(query, options, apiKey);
				activityMonitor.logComplete(activityId, apiResult.status);
				return apiResult.data;
			} catch (err) {
				apiError = err instanceof Error ? err : new Error(String(err));
				if (!shouldFallbackToWeb(apiError)) throw apiError;
			}
		}

		const cookieResult = await getPerplexityCookies();
		if (cookieResult && hasPerplexitySessionCookie(cookieResult.cookies)) {
			try {
				const webResult = await searchWithPerplexityWeb(query, options, cookieResult.cookies);
				activityMonitor.logComplete(activityId, webResult.status);
				return webResult.data;
			} catch (err) {
				webError = err instanceof Error ? err : new Error(String(err));
			}
		} else if (cookieResult && !hasPerplexitySessionCookie(cookieResult.cookies)) {
			webError = new Error("Perplexity Chrome cookies found, but no active Perplexity session cookie is available.");
		}

		if (apiError && webError) {
			throw new Error(
				"Perplexity API and cookie auth both failed:\n" +
				`  API: ${apiError.message}\n` +
				`  Cookies: ${webError.message}`,
			);
		}
		if (apiError) throw apiError;
		if (webError) throw webError;

		throw new Error(
			"Perplexity authentication not available. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { \"perplexityApiKey\": \"your-key\" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"  3. Sign into perplexity.ai in Chrome (macOS)",
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function shouldFallbackToWeb(error: Error): boolean {
	const msg = error.message.toLowerCase();
	if (msg.includes("api key not found")) return true;
	if (msg.includes(" 401") || msg.includes(" 403") || msg.includes(" 429")) return true;
	if (msg.includes("fetch failed") || msg.includes("network")) return true;
	return false;
}

async function searchWithPerplexityApi(
	query: string,
	options: SearchOptions,
	apiKey: string,
): Promise<{ status: number; data: SearchResponse }> {
	const numResults = Math.min(options.numResults ?? 5, 20);

	const requestBody: Record<string, unknown> = {
		model: "sonar",
		messages: [{ role: "user", content: query }],
		max_tokens: 1024,
		return_related_questions: false,
	};

	if (options.recencyFilter) {
		requestBody.search_recency_filter = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody.search_domain_filter = validated;
		}
	}

	const response = await fetch(PERPLEXITY_API_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(requestBody),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	let data: Record<string, unknown>;
	try {
		data = await response.json();
	} catch {
		throw new Error("Perplexity API returned invalid JSON");
	}

	const answer = (data.choices as Array<{ message?: { content?: string } }>)?.[0]?.message?.content || "";
	const citations = Array.isArray(data.citations) ? data.citations : [];

	const results: SearchResult[] = [];
	for (let i = 0; i < Math.min(citations.length, numResults); i++) {
		const citation = citations[i];
		if (typeof citation === "string") {
			results.push({ title: `Source ${i + 1}`, url: citation, snippet: "" });
		} else if (citation && typeof citation === "object" && typeof citation.url === "string") {
			results.push({
				title: citation.title || `Source ${i + 1}`,
				url: citation.url,
				snippet: "",
			});
		}
	}

	return {
		status: response.status,
		data: { answer, results },
	};
}

async function searchWithPerplexityWeb(
	query: string,
	options: SearchOptions,
	cookieMap: CookieMap,
): Promise<{ status: number; data: SearchResponse }> {
	const numResults = Math.min(options.numResults ?? 5, 20);
	const requestId = randomUUID();
	const effectiveQuery = applyDomainFilterHints(query, options.domainFilter);

	const payload = {
		params: {
			attachments: [],
			language: "en-US",
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
			search_focus: "internet",
			sources: ["web"],
			search_recency_filter: options.recencyFilter ?? null,
			frontend_uuid: randomUUID(),
			frontend_context_uuid: randomUUID(),
			visitor_id: randomUUID(),
			mode: "concise",
			model_preference: "pplx_pro",
			is_related_query: false,
			is_sponsored: false,
			prompt_source: "user",
			query_source: "home",
			is_incognito: false,
			time_from_first_type: 0,
			local_search_enabled: false,
			use_schematized_api: true,
			send_back_text_in_streaming_api: false,
			supported_block_use_cases: WEB_SUPPORTED_BLOCKS,
			client_coordinates: null,
			mentions: [],
			dsl_query: effectiveQuery,
			skip_search_enabled: false,
			is_nav_suggestions_disabled: false,
			always_search_override: false,
			override_no_search: false,
			comet_max_assistant_enabled: false,
			version: "2.18",
		},
		query_str: effectiveQuery,
	};

	const headers = {
		accept: "text/event-stream",
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		"content-type": "application/json",
		origin: "https://www.perplexity.ai",
		referer: "https://www.perplexity.ai/",
		"user-agent": PERPLEXITY_USER_AGENT,
		"x-perplexity-request-reason": "perplexity-query-state-provider",
		"x-request-id": requestId,
		cookie: buildCookieHeader(cookieMap),
	};

	let status = 0;
	let rawStream = "";

	const response = await fetch(PERPLEXITY_WEB_URL, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal: options.signal,
	});

	if (response.ok) {
		status = response.status;
		rawStream = await response.text();
	} else {
		const errorText = await response.text();
		if (isCloudflareBlock(response.status, errorText)) {
			try {
				const fallback = await searchWithPerplexityWebViaCurlCffi(payload, headers, options.signal);
				status = fallback.status;
				rawStream = fallback.body;
			} catch (fallbackErr) {
				const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
				throw new Error(
					"Perplexity web blocked by Cloudflare (403). Open perplexity.ai in Chrome, complete any verification page, then retry. "
					+ "If this keeps happening, set PERPLEXITY_API_KEY. "
					+ `curl_cffi fallback failed: ${fallbackMessage}`,
				);
			}
		} else {
			throw new Error(`Perplexity web error ${response.status}: ${errorText.slice(0, 400)}`);
		}
	}

	const events = parseSseEvents(rawStream);
	const extracted = extractWebAnswer(events, numResults);

	if (!extracted.answer && extracted.results.length === 0) {
		throw new Error("Perplexity web returned an empty response");
	}

	return {
		status,
		data: extracted,
	};
}

function isCloudflareBlock(status: number, body: string): boolean {
	return status === 403 && /just a moment|cloudflare|cf-chl|cf-browser-verification/i.test(body);
}

async function searchWithPerplexityWebViaCurlCffi(
	payload: Record<string, unknown>,
	headers: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ status: number; body: string }> {
	const pythonBin = await ensureCurlCffiPython(signal);
	const script = [
		"import json, sys",
		"from curl_cffi import requests",
		"data = json.load(sys.stdin)",
		"resp = requests.post(data['url'], headers=data['headers'], json=data['payload'], impersonate='chrome', timeout=90)",
		"print(json.dumps({'status': int(resp.status_code), 'body': resp.text}))",
	].join("\n");

	const input = JSON.stringify({
		url: PERPLEXITY_WEB_URL,
		headers,
		payload,
	});

	const { stdout } = await runExecFile(pythonBin, ["-c", script], {
		signal,
		timeout: CURL_CFFI_REQUEST_TIMEOUT_MS,
		input,
	});

	let parsed: { status?: number; body?: string };
	try {
		parsed = JSON.parse(stdout) as { status?: number; body?: string };
	} catch {
		throw new Error("curl_cffi fallback returned invalid output");
	}

	if (typeof parsed.status !== "number" || typeof parsed.body !== "string") {
		throw new Error("curl_cffi fallback returned incomplete response");
	}

	if (parsed.status < 200 || parsed.status >= 300) {
		throw new Error(`Perplexity web error ${parsed.status}: ${parsed.body.slice(0, 400)}`);
	}

	return {
		status: parsed.status,
		body: parsed.body,
	};
}

async function ensureCurlCffiPython(signal?: AbortSignal): Promise<string> {
	const pythonBin = join(CURL_CFFI_VENV_DIR, "bin", "python3");
	if (existsSync(pythonBin)) return pythonBin;

	mkdirSync(dirname(CURL_CFFI_VENV_DIR), { recursive: true });

	await runExecFile("python3", ["-m", "venv", CURL_CFFI_VENV_DIR], {
		signal,
		timeout: CURL_CFFI_BOOTSTRAP_TIMEOUT_MS,
	});
	await runExecFile(pythonBin, ["-m", "pip", "install", "-q", "curl_cffi"], {
		signal,
		timeout: CURL_CFFI_BOOTSTRAP_TIMEOUT_MS,
	});

	if (!existsSync(pythonBin)) {
		throw new Error("Failed to bootstrap python venv for curl_cffi fallback");
	}

	return pythonBin;
}

async function runExecFile(
	file: string,
	args: string[],
	options: { signal?: AbortSignal; timeout?: number; input?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const child = execFile(
			file,
			args,
			{
				signal: options.signal,
				timeout: options.timeout,
				maxBuffer: 10 * 1024 * 1024,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(new Error([err.message, stderr].filter(Boolean).join("\n")));
					return;
				}
				resolve({ stdout, stderr });
			},
		);

		if (options.input !== undefined) {
			child.stdin?.end(options.input);
		}
	});
}

function applyDomainFilterHints(query: string, domainFilter: string[] | undefined): string {
	if (!domainFilter?.length) return query;
	const validated = validateDomainFilter(domainFilter);
	if (!validated.length) return query;

	const includes = validated.filter((d) => !d.startsWith("-"));
	const excludes = validated.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
	if (!includes.length && !excludes.length) return query;

	let output = query;
	if (includes.length) output += `\n\nOnly use sources from: ${includes.join(", ")}`;
	if (excludes.length) output += `\nDo not use sources from: ${excludes.join(", ")}`;
	return output;
}

function buildCookieHeader(cookieMap: CookieMap): string {
	return Object.entries(cookieMap)
		.filter(([, value]) => typeof value === "string" && value.length > 0)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function parseSseEvents(raw: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	let dataLines: string[] = [];

	const flush = () => {
		if (dataLines.length === 0) return;
		const payload = dataLines.join("\n");
		dataLines = [];
		if (!payload || payload === "[DONE]") return;
		try {
			const parsed = JSON.parse(payload);
			if (parsed && typeof parsed === "object") {
				events.push(parsed as Record<string, unknown>);
			}
		} catch {}
	};

	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).trimStart());
			continue;
		}
		if (line.trim() === "") {
			flush();
		}
	}
	flush();
	return events;
}

function extractWebAnswer(events: Array<Record<string, unknown>>, maxResults: number): SearchResponse {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	let answer = "";

	for (const event of events) {
		const blocks = Array.isArray(event.blocks) ? event.blocks : [];
		for (const block of blocks) {
			if (!block || typeof block !== "object") continue;
			const record = block as Record<string, unknown>;

			if (record.intended_usage === "sources_answer_mode") {
				const sourceModeBlock = record.sources_mode_block as Record<string, unknown> | undefined;
				const webResults = Array.isArray(sourceModeBlock?.web_results) ? sourceModeBlock.web_results : [];
				for (const entry of webResults) {
					if (!entry || typeof entry !== "object") continue;
					const source = entry as Record<string, unknown>;
					const url = typeof source.url === "string" ? source.url : "";
					if (!url || seen.has(url)) continue;
					seen.add(url);
					results.push({
						title:
							typeof source.name === "string"
								? source.name
								: typeof source.title === "string"
									? source.title
									: `Source ${results.length + 1}`,
						url,
						snippet:
							typeof source.snippet === "string"
								? source.snippet
								: typeof source.preview_text === "string"
									? source.preview_text
									: "",
					});
					if (results.length >= maxResults) break;
				}
			}

			const diffBlock = record.diff_block as Record<string, unknown> | undefined;
			if (!diffBlock) continue;
			if (diffBlock.field !== "markdown_block") continue;
			const patches = Array.isArray(diffBlock.patches) ? diffBlock.patches : [];
			for (const patch of patches) {
				if (!patch || typeof patch !== "object") continue;
				const patchRecord = patch as Record<string, unknown>;
				if (patchRecord.path === "/progress") continue;
				const next = coercePatchText(patchRecord.value);
				if (!next) continue;
				if (next.startsWith(answer)) {
					answer = next;
				} else if (!answer.endsWith(next)) {
					answer += next;
				}
			}
		}
	}

	return {
		answer: answer.trim(),
		results: results.slice(0, maxResults),
	};
}

function coercePatchText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";

	const record = value as Record<string, unknown>;
	if (typeof record.answer === "string") return record.answer;
	if (typeof record.text === "string") return record.text;
	if (Array.isArray(record.chunks)) {
		return record.chunks.filter((chunk): chunk is string => typeof chunk === "string").join("");
	}
	return "";
}
