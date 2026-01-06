import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface PerplexityResponse {
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

function getApiKey(): string {
	const config = loadConfig();
	const key = config.perplexityApiKey || process.env.PERPLEXITY_API_KEY;
	if (!key) {
		throw new Error(
			"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api"
		);
	}
	return key;
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

export async function searchWithPerplexity(query: string, options: SearchOptions = {}): Promise<PerplexityResponse> {
	checkRateLimit();

	const apiKey = getApiKey();
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

	return { answer, results };
}
