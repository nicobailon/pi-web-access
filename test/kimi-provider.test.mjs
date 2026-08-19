import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const kimiModuleUrl = new URL("../kimi-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const { isKimiSearchAvailable, searchWithKimi } = await import(kimiModuleUrl);

function registryContext({
	models = [{ provider: "kimi-coding", id: "kimi-for-coding" }],
	auth = { ok: true, apiKey: "kimi-oauth-token", headers: {} },
} = {}) {
	const selected = [];
	return {
		selected,
		context: {
			modelRegistry: {
				getAll: () => models,
				getApiKeyAndHeaders: async (model) => {
					selected.push({ provider: model.provider, id: model.id });
					return typeof auth === "function" ? auth(model) : auth;
				},
			},
		},
	};
}

async function withFetch(mock, action) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock;
	try {
		return await action();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("Kimi resolves primary model-registry auth and sends the verified search request", async () => {
	const models = [
		{ provider: "kimi-code", id: "compat-model" },
		{ provider: "other", id: "unrelated" },
		{ provider: "kimi-coding", id: "primary-model" },
	];
	const { context, selected } = registryContext({
		models,
		auth: {
			ok: true,
			apiKey: "kimi-registry-token",
			headers: {
				"X-Registry": "forwarded",
				"X-Nullable": null,
				authorization: "Bearer stale-token",
				"content-type": "text/plain",
				"x-msh-tool-call-id": "stale-call-id",
			},
		},
	});
	let captured;
	const result = await withFetch(async (url, init) => {
		captured = {
			url: String(url),
			method: init.method,
			headers: Object.fromEntries(new Headers(init.headers)),
			body: JSON.parse(init.body),
		};
		return new Response(JSON.stringify({
			search_results: [
				{ title: "Kimi result", url: "https://example.com/one", snippet: "First snippet", site_name: "Example" },
				{ title: "   ", url: "https://example.com/two" },
				{ title: "Missing URL", snippet: "must be ignored" },
			],
		}), { status: 200 });
	}, async () => {
		assert.equal(await isKimiSearchAvailable(context), true);
		return searchWithKimi("Kimi Code Plan search", {}, context);
	});

	assert.deepEqual(selected, [
		{ provider: "kimi-coding", id: "primary-model" },
		{ provider: "kimi-coding", id: "primary-model" },
	]);
	assert.equal(captured.url, "https://api.kimi.com/coding/v1/search");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.authorization, "Bearer kimi-registry-token");
	assert.equal(captured.headers["content-type"], "application/json");
	assert.equal(captured.headers["x-registry"], "forwarded");
	assert.equal(captured.headers["x-nullable"], undefined);
	assert.match(captured.headers["x-msh-tool-call-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(captured.headers["x-msh-tool-call-id"], "stale-call-id");
	assert.deepEqual(captured.body, { text_query: "Kimi Code Plan search" });
	assert.deepEqual(result, {
		answer: "First snippet\nSource: Kimi result (https://example.com/one)\n\nSource: https://example.com/two (https://example.com/two)",
		results: [
			{ title: "Kimi result", url: "https://example.com/one", snippet: "First snippet" },
			{ title: "https://example.com/two", url: "https://example.com/two", snippet: "" },
		],
	});
});

test("Kimi accepts Pi OAuth returned only in the Authorization header", async () => {
	const { context } = registryContext({
		auth: { ok: true, headers: { Authorization: "Bearer kimi-header-token" } },
	});
	let authorization;
	const result = await withFetch(async (_url, init) => {
		authorization = new Headers(init.headers).get("authorization");
		return new Response(JSON.stringify({
			search_results: [{ title: "Header auth", url: "https://example.com/header", snippet: "ok" }],
		}), { status: 200 });
	}, () => searchWithKimi("header auth", {}, context));

	assert.equal(authorization, "Bearer kimi-header-token");
	assert.equal(result.results[0]?.url, "https://example.com/header");
});

test("Kimi accepts the kimi-code registry provider as a compatibility fallback", async () => {
	const { context, selected } = registryContext({
		models: [{ provider: "kimi-code", id: "compat-only" }],
	});
	assert.equal(await isKimiSearchAvailable(context), true);
	assert.deepEqual(selected, [{ provider: "kimi-code", id: "compat-only" }]);
});

test("Kimi without model-registry auth fails before making a request", async () => {
	const { context } = registryContext({
		models: [{ provider: "kimi-coding", id: "signed-out" }],
		auth: { ok: false, error: "not authenticated" },
	});
	let requests = 0;
	await withFetch(async () => {
		requests++;
		throw new Error("must not reach the network");
	}, async () => {
		assert.equal(await isKimiSearchAvailable(context), false);
		await assert.rejects(
			() => searchWithKimi("signed out", {}, context),
			/error.*\/login kimi-coding|\/login kimi-coding/i,
		);
	});
	assert.equal(requests, 0);
});

test("Kimi API errors redact the model-registry credential", async () => {
	const secret = "kimi-oauth-secret";
	const { context } = registryContext({ auth: { ok: true, apiKey: secret, headers: {} } });
	await withFetch(
		async () => new Response(`denied for ${secret}`, { status: 401 }),
		async () => {
			await assert.rejects(
				() => searchWithKimi("redact", {}, context),
				(error) => {
					assert.match(error.message, /Kimi Code search API error 401/);
					assert.match(error.message, /\[redacted\]/);
					assert.doesNotMatch(error.message, new RegExp(secret));
					return true;
				},
			);
		},
	);
});

test("Kimi applies normalized domain filters and numResults locally", async () => {
	const { context } = registryContext();
	let body;
	const response = await withFetch(async (_url, init) => {
		body = JSON.parse(init.body);
		return new Response(JSON.stringify({
			search_results: [
				{ title: "First", url: "https://allowed.example/first", snippet: "one" },
				{ title: "Blocked", url: "https://ads.allowed.example/tracker", snippet: "blocked" },
				{ title: "Second", url: "https://docs.allowed.example/second", snippet: "two" },
				{ title: "Other", url: "https://other.example/no", snippet: "other" },
				{ title: "Third", url: "https://allowed.example/third", snippet: "three" },
			],
		}), { status: 200 });
	}, () => searchWithKimi("local filtering", {
		numResults: 2,
		domainFilter: [" HTTPS://Allowed.Example/scope ", "-https://ADS.allowed.example/path", "not a domain"],
	}, context));

	assert.deepEqual(body, { text_query: "local filtering" });
	assert.deepEqual(response.results.map(({ title, url }) => ({ title, url })), [
		{ title: "First", url: "https://allowed.example/first" },
		{ title: "Second", url: "https://docs.allowed.example/second" },
	]);
	assert.equal(response.answer, "one\nSource: First (https://allowed.example/first)\n\ntwo\nSource: Second (https://docs.allowed.example/second)");
});

test("Kimi rejects invalid JSON and empty result envelopes", async () => {
	const { context } = registryContext();
	await withFetch(
		async () => new Response("{", { status: 200 }),
		() => assert.rejects(() => searchWithKimi("invalid", {}, context), /returned invalid JSON/),
	);
	await withFetch(
		async () => new Response(JSON.stringify({ search_results: [] }), { status: 200 }),
		() => assert.rejects(() => searchWithKimi("empty", {}, context), /returned no results/),
	);
});

test("explicit kimi routing dispatches through the Kimi Code search endpoint", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-kimi-routing-"));
	await writeFile(join(agentDir, "web-search.json"), "{}\n", "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { search } = await import(`${searchModuleUrl}?kimi-routing=${Date.now()}`);
		const { context } = registryContext();
		const calls = [];
		const result = await withFetch(async (url) => {
			calls.push(String(url));
			return new Response(JSON.stringify({
				search_results: [{ title: "Dispatched", url: "https://example.com/dispatch", snippet: "ok" }],
			}), { status: 200 });
		}, () => search("dispatch", { provider: "kimi", extensionContext: context }));

		assert.equal(result.provider, "kimi");
		assert.deepEqual(calls, ["https://api.kimi.com/coding/v1/search"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
});
