import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const savedEnv = { ...process.env };
let home;
let searchWithPerplexity;

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-web-perplexity-timeout-"));
	process.env.PI_CODING_AGENT_DIR = home;
	process.env.PERPLEXITY_API_KEY = "test-key";
	({ searchWithPerplexity } = await import("../perplexity.ts"));
});

after(async () => {
	globalThis.fetch = originalFetch;
	AbortSignal.timeout = originalTimeout;
	process.env = savedEnv;
	await rm(home, { recursive: true, force: true });
});

const timeoutReason = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

test("Perplexity's own deadline surfaces as a 408 timeout, not a cancellation", async () => {
	AbortSignal.timeout = () => AbortSignal.abort(timeoutReason());
	globalThis.fetch = async (_url, init) => { throw init.signal.reason; };
	try {
		await assert.rejects(searchWithPerplexity("headers stall"), { message: "Perplexity API error 408: request timed out" });
	} finally {
		AbortSignal.timeout = originalTimeout;
	}
});

test("a deadline while reading the body is also a 408 timeout", async () => {
	const deadline = new AbortController();
	AbortSignal.timeout = () => deadline.signal;
	globalThis.fetch = async (_url, init) => ({
		ok: true,
		status: 200,
		json: async () => {
			deadline.abort(timeoutReason());
			throw init.signal.reason;
		},
	});
	try {
		await assert.rejects(searchWithPerplexity("body stall"), { message: "Perplexity API error 408: request timed out" });
	} finally {
		AbortSignal.timeout = originalTimeout;
	}
});

test("caller cancellation still surfaces as an abort", async () => {
	const caller = new AbortController();
	globalThis.fetch = async (_url, init) => {
		caller.abort();
		throw init.signal.reason;
	};
	await assert.rejects(searchWithPerplexity("cancelled", { signal: caller.signal }), { name: "AbortError" });
});
