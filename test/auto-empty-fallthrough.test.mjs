import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const empty = { brave: { web: { results: [] } }, perplexity: { results: [] } };

async function autoSearch(responses) {
	const original = globalThis.fetch;
	const called = [];
	globalThis.fetch = async (url) => {
		const target = String(url);
		const provider = target.includes("brave.com") ? "brave" : target.includes("perplexity.ai") ? "perplexity" : null;
		if (!provider) throw new Error(`unexpected fetch: ${target}`);
		called.push(provider);
		return new Response(JSON.stringify(responses[provider]), { status: 200 });
	};
	// Only these two providers, so the chain is exactly Brave, then Perplexity.
	const configDir = mkdtempSync(join(tmpdir(), "web-search-"));
	writeFileSync(join(configDir, "web-search.json"), JSON.stringify({ webSearch: { allowedProviders: ["brave", "perplexity"] } }));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-key";
	process.env.PERPLEXITY_API_KEY = "pplx-key";
	try {
		const { search } = await import(`../gemini-search.ts?empty=${Date.now()}`);
		return { result: await search("query", { provider: "auto" }), called };
	} finally {
		globalThis.fetch = original;
		delete process.env.BRAVE_API_KEY;
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

test("AUTO keeps going when a provider answers 200 with nothing", async () => {
	const { result } = await autoSearch({
		...empty,
		perplexity: { results: [{ title: "Source", url: "https://example.com/a", snippet: "text" }] },
	});

	assert.equal(result.provider, "perplexity");
	assert.equal(result.results.length, 1);
});

test("AUTO returns the first empty response when every provider is empty", async () => {
	const { result, called } = await autoSearch(empty);

	assert.deepEqual(called, ["brave", "perplexity"]);
	assert.equal(result.provider, "brave");
	assert.deepEqual(result.results, []);
});
