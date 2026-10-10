import assert from "node:assert/strict";
import test from "node:test";

test("a Perplexity request carries its own deadline", async () => {
	const original = globalThis.fetch;
	let signal;
	globalThis.fetch = async (_url, init) => {
		signal = init.signal;
		return new Response(JSON.stringify({ results: [] }), { status: 200 });
	};
	process.env.PERPLEXITY_API_KEY = "test-key";
	try {
		const { searchWithPerplexity } = await import(`../perplexity.ts?deadline=${Date.now()}`);
		await searchWithPerplexity("query");

		assert.ok(signal, "request had no signal at all");
		assert.equal(signal.aborted, false);
	} finally {
		globalThis.fetch = original;
		delete process.env.PERPLEXITY_API_KEY;
	}
});
