import type { Model } from "@mariozechner/pi-ai";
import type { SearchResponse } from "./perplexity.js";

type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

export interface SearchModelRegistry {
	find(provider: string, modelId: string): Model<any> | undefined;
	getApiKeyAndHeaders(model: Model<any>): Promise<ResolvedRequestAuth>;
}

export interface OpenAISearchAuth {
	provider: "openai" | "openai-codex";
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	accountId?: string;
}

interface SearchWithOpenAIOptions {
	auth: OpenAISearchAuth;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

const CODEX_JWT_CLAIM = "https://api.openai.com/auth";
const FALLBACK_OPENAI_MODELS = ["gpt-4.1-mini", "gpt-5", "gpt-5.4"] as const;
const FALLBACK_CODEX_MODELS = ["gpt-5.1", "gpt-5.1-codex-max", "gpt-5.1-codex-mini"] as const;

export function extractCodexAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
		const accountId = payload?.[CODEX_JWT_CLAIM]?.chatgpt_account_id;
		if (typeof accountId !== "string" || accountId.length === 0) {
			throw new Error("Missing account id");
		}
		return accountId;
	} catch {
		throw new Error("Failed to extract Codex account id");
	}
}

export function extractSearchResultsFromResponse(response: unknown): SearchResponse {
	const output = Array.isArray((response as { output?: unknown }).output)
		? ((response as { output: unknown[] }).output)
		: [];

	const results: SearchResult[] = [];
	const seen = new Set<string>();
	let answer = "";

	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = Array.isArray((item as { content?: unknown }).content)
			? ((item as { content: unknown[] }).content)
			: [];
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			if (!answer && typeof (part as { text?: unknown }).text === "string") {
				answer = (part as { text: string }).text;
			}
			const annotations = Array.isArray((part as { annotations?: unknown }).annotations)
				? ((part as { annotations: unknown[] }).annotations)
				: [];
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object") continue;
				if ((annotation as { type?: unknown }).type !== "url_citation") continue;
				const url = typeof (annotation as { url?: unknown }).url === "string"
					? (annotation as { url: string }).url.replace(/\?utm_source=openai$/, "")
					: "";
				if (!url || seen.has(url)) continue;
				seen.add(url);
				results.push({
					title:
						typeof (annotation as { title?: unknown }).title === "string"
							? (annotation as { title: string }).title
							: url,
					url,
					snippet: "",
				});
			}
		}
	}

	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "web_search_call") continue;
		const sources = Array.isArray((item as { action?: { sources?: unknown } }).action?.sources)
			? ((item as { action: { sources: unknown[] } }).action.sources)
			: [];
		for (const source of sources) {
			if (!source || typeof source !== "object") continue;
			const url = typeof (source as { url?: unknown }).url === "string"
				? (source as { url: string }).url.replace(/\?utm_source=openai$/, "")
				: "";
			if (!url || seen.has(url)) continue;
			seen.add(url);
			results.push({
				title:
					typeof (source as { title?: unknown }).title === "string"
						? (source as { title: string }).title
						: url,
				url,
				snippet: "",
			});
		}
	}

	return { answer, results };
}

async function resolveModelAuth(
	modelRegistry: SearchModelRegistry,
	model: Model<any>,
): Promise<OpenAISearchAuth | null> {
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return null;
	return {
		provider: model.provider === "openai-codex" ? "openai-codex" : "openai",
		model,
		apiKey: auth.apiKey,
		headers: auth.headers,
		accountId: model.provider === "openai-codex" ? extractCodexAccountId(auth.apiKey) : undefined,
	};
}

export async function resolveOpenAISearchAuth(options: {
	modelRegistry: SearchModelRegistry;
	currentModel?: Model<any> | null;
}): Promise<OpenAISearchAuth | null> {
	const { modelRegistry, currentModel } = options;
	if (currentModel && (currentModel.provider === "openai" || currentModel.provider === "openai-codex")) {
		const current = await resolveModelAuth(modelRegistry, currentModel);
		if (current) return current;
	}

	for (const modelId of FALLBACK_CODEX_MODELS) {
		const model = modelRegistry.find("openai-codex", modelId);
		if (!model) continue;
		const resolved = await resolveModelAuth(modelRegistry, model);
		if (resolved) return resolved;
	}

	for (const modelId of FALLBACK_OPENAI_MODELS) {
		const model = modelRegistry.find("openai", modelId);
		if (!model) continue;
		const resolved = await resolveModelAuth(modelRegistry, model);
		if (resolved) return resolved;
	}

	return null;
}

export async function isOpenAIAvailable(options?: {
	modelRegistry?: SearchModelRegistry;
	currentModel?: Model<any> | null;
}): Promise<boolean> {
	if (!options?.modelRegistry) return false;
	return (await resolveOpenAISearchAuth({
		modelRegistry: options.modelRegistry,
		currentModel: options.currentModel,
	})) !== null;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function resolveResponsesUrl(auth: OpenAISearchAuth): string {
	const normalized = normalizeBaseUrl(auth.model.baseUrl);
	if (auth.provider === "openai-codex") {
		return normalized.endsWith("/codex/responses") ? normalized : `${normalized}/codex/responses`;
	}
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function buildHeaders(auth: OpenAISearchAuth): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${auth.apiKey}`,
		...auth.headers,
	};

	if (auth.provider === "openai-codex" && auth.accountId) {
		headers["chatgpt-account-id"] = auth.accountId;
		headers.originator = "pi-web-access";
		headers["OpenAI-Beta"] = "responses=experimental";
	}

	return headers;
}

export async function searchWithOpenAI(query: string, options: SearchWithOpenAIOptions): Promise<SearchResponse> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(resolveResponsesUrl(options.auth), {
		method: "POST",
		headers: buildHeaders(options.auth),
		body: JSON.stringify({
			model: options.auth.model.id,
			instructions: "Search the web and return a concise answer with inline citations.",
			input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
			tools: [{ type: "web_search" }],
			include: ["web_search_call.action.sources"],
			store: false,
			stream: true,
			tool_choice: "auto",
			parallel_tool_calls: true,
			text: { verbosity: "low" },
		}),
		signal: options.signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "");
		throw new Error(`OpenAI search failed with status ${response.status}: ${errorText.slice(0, 1000)}`);
	}

	return extractSearchResultsFromResponse(await parseOpenAIResponse(response));
}

async function parseOpenAIResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(trimmed);
	}

	const outputItems: unknown[] = [];
	const textByMessageId = new Map<string, string>();
	let completedResponse: unknown = null;

	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		const parsed = JSON.parse(payload);
		if (
			(parsed.type === "response.done" || parsed.type === "response.completed") &&
			parsed.response
		) {
			completedResponse = parsed.response;
			continue;
		}
		if (parsed.type === "response.output_item.done" && parsed.item) {
			outputItems.push(parsed.item);
			continue;
		}
		if (parsed.type === "response.output_text.delta" && typeof parsed.item_id === "string" && typeof parsed.delta === "string") {
			textByMessageId.set(parsed.item_id, (textByMessageId.get(parsed.item_id) ?? "") + parsed.delta);
			continue;
		}
		if (parsed.type === "response.done" || parsed.type === "response.completed") {
			return parsed.response;
		}
	}

	if (
		completedResponse &&
		Array.isArray((completedResponse as { output?: unknown }).output) &&
		((completedResponse as { output: unknown[] }).output.length > 0 || (outputItems.length === 0 && textByMessageId.size === 0))
	) {
		const output = ((completedResponse as { output: unknown[] }).output).map((item) => {
			if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") return item;
			const itemId = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "";
			const content = Array.isArray((item as { content?: unknown }).content)
				? ((item as { content: unknown[] }).content)
				: [];
			if (content.length > 0) return item;
			const text = textByMessageId.get(itemId);
			if (!text) return item;
			return {
				...item,
				content: [{ type: "output_text", text, annotations: [] }],
			};
		});
		return { ...(completedResponse as Record<string, unknown>), output };
	}

	if (outputItems.length > 0 || textByMessageId.size > 0) {
		const synthesizedOutput = [...outputItems];
		for (const [itemId, textContent] of textByMessageId) {
			const alreadyPresent = synthesizedOutput.some(
				(item) => item && typeof item === "object" && (item as { id?: unknown }).id === itemId,
			);
			if (alreadyPresent) continue;
			synthesizedOutput.push({
				id: itemId,
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: textContent, annotations: [] }],
			});
		}
		return { output: synthesizedOutput };
	}

	throw new Error("OpenAI search response could not be parsed");
}
