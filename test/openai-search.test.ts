import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@mariozechner/pi-ai";
import {
	extractCodexAccountId,
	extractSearchResultsFromResponse,
	resolveOpenAISearchAuth,
	searchWithOpenAI,
	type SearchModelRegistry,
} from "../openai-search.ts";

function makeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.signature`;
}

function makeModel(provider: string, id: string, baseUrl: string): Model<any> {
	return {
		id,
		name: id,
		api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	};
}

test("extractCodexAccountId returns the ChatGPT account id from a codex JWT", () => {
	const token = makeJwt({
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_123",
		},
	});

	assert.equal(extractCodexAccountId(token), "acct_123");
});

test("extractSearchResultsFromResponse returns citations from message annotations and search call sources", () => {
	const response = {
		output: [
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "Answer with citation",
						annotations: [
							{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://docs.example.com",
								title: "Docs",
							},
						],
					},
				],
			},
			{
				type: "web_search_call",
				action: {
					sources: [
						{
							url: "https://blog.example.com/post",
							title: "Blog",
						},
					],
				},
			},
		],
	};

	const parsed = extractSearchResultsFromResponse(response);

	assert.equal(parsed.answer, "Answer with citation");
	assert.deepEqual(
		parsed.results.map((result) => ({ title: result.title, url: result.url })),
		[
			{ title: "Docs", url: "https://docs.example.com" },
			{ title: "Blog", url: "https://blog.example.com/post" },
		],
	);
});

test("resolveOpenAISearchAuth prefers the current openai-codex model when auth is available", async () => {
	const token = makeJwt({
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_current",
		},
	});
	const currentModel = makeModel("openai-codex", "gpt-5.1", "https://chatgpt.com/backend-api");

	const registry: SearchModelRegistry = {
		find() {
			return undefined;
		},
		async getApiKeyAndHeaders(model) {
			if (model === currentModel) {
				return { ok: true, apiKey: token };
			}
			return { ok: false, error: "missing" };
		},
	};

	const resolved = await resolveOpenAISearchAuth({
		modelRegistry: registry,
		currentModel,
	});

	assert.equal(resolved?.provider, "openai-codex");
	assert.equal(resolved?.model.id, "gpt-5.1");
	assert.equal(resolved?.accountId, "acct_current");
});

test("searchWithOpenAI calls the public Responses API for openai models", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const model = makeModel("openai", "gpt-4.1-mini", "https://api.openai.com/v1");

	const result = await searchWithOpenAI("latest typescript news", {
		auth: {
			provider: "openai",
			model,
			apiKey: "sk-test",
		},
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), init: init ?? {} });
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [
								{
									type: "output_text",
									text: "hello",
									annotations: [],
								},
							],
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	});

	assert.equal(result.answer, "hello");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://api.openai.com/v1/responses");
	assert.match(String((calls[0]!.init.headers as Record<string, string>).Authorization), /^Bearer sk-test$/);
});

test("searchWithOpenAI calls the Codex backend path and adds account headers for openai-codex models", async () => {
	const token = makeJwt({
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_456",
		},
	});
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const model = makeModel("openai-codex", "gpt-5.1", "https://chatgpt.com/backend-api");

	await searchWithOpenAI("find release notes", {
		auth: {
			provider: "openai-codex",
			model,
			apiKey: token,
			accountId: "acct_456",
		},
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), init: init ?? {} });
			return new Response(
				JSON.stringify({
					output: [],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://chatgpt.com/backend-api/codex/responses");
	const headers = calls[0]!.init.headers as Record<string, string>;
	assert.equal(headers["chatgpt-account-id"], "acct_456");
	assert.equal(headers.originator, "pi-web-access");
});

test("searchWithOpenAI parses streamed output items when the completed envelope has empty output", async () => {
	const token = makeJwt({
		"https://api.openai.com/auth": {
			chatgpt_account_id: "acct_stream",
		},
	});
	const model = makeModel("openai-codex", "gpt-5.1", "https://chatgpt.com/backend-api");

	const result = await searchWithOpenAI("latest release notes", {
		auth: {
			provider: "openai-codex",
			model,
			apiKey: token,
			accountId: "acct_stream",
		},
		fetchImpl: async () =>
			new Response(
				[
					'data: {"type":"response.output_item.done","item":{"id":"ws_1","type":"web_search_call","status":"completed","action":{"type":"search","sources":[{"url":"https://openai.com/release-notes","title":"Release notes"}]}}}',
					'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"output_text","text":"Found release notes","annotations":[]}]}}',
					'data: {"type":"response.completed","response":{"output":[]}}',
				].join("\n"),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			),
	});

	assert.equal(result.answer, "Found release notes");
	assert.deepEqual(result.results, [
		{
			title: "Release notes",
			url: "https://openai.com/release-notes",
			snippet: "",
		},
	]);
});
