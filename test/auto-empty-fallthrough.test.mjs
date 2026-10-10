import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("AUTO keeps going when a provider answers 200 with nothing", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const target = String(url);
		if (target.includes("brave.com")) {
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		}
		if (target.includes("perplexity.ai")) {
			return new Response(JSON.stringify({
				results: [{ title: "Source", url: "https://example.com/a", snippet: "text" }],
			}), { status: 200 });
		}
		throw new Error(`unexpected fetch: ${target}`);
	};
	// Only these two providers, so the chain is exactly "empty, then working".
	const configDir = mkdtempSync(join(tmpdir(), "web-search-"));
	writeFileSync(join(configDir, "web-search.json"), JSON.stringify({ allowedProviders: ["brave", "perplexity"] }));
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.env.BRAVE_API_KEY = "brave-key";
	process.env.PERPLEXITY_API_KEY = "pplx-key";
	try {
		const { search } = await import(`../gemini-search.ts?empty=${Date.now()}`);
		// Only these two are allowed, so the chain is exactly "empty, then working".
		const result = await search("query", { provider: "auto" });

		assert.equal(result.provider, "perplexity");
		assert.equal(result.results.length, 1);
	} finally {
		globalThis.fetch = original;
		delete process.env.BRAVE_API_KEY;
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PI_CODING_AGENT_DIR;
	}
});
