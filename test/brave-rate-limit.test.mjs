import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const limiterModuleUrl = new URL("../brave-rate-limit.ts", import.meta.url).href;
const braveModuleUrl = new URL("../brave.ts", import.meta.url).href;

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "BRAVE_API_KEY", "BRAVE_BASE_URL"]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("parses Brave's parallel rate-limit buckets", async () => {
	const { parseBraveRateLimitHeaders } = await import(limiterModuleUrl);
	const headers = new Headers({
		"x-ratelimit-limit": "1, 2000",
		"x-ratelimit-policy": "1;w=1, 2000;w=2592000",
		"x-ratelimit-remaining": "0, 1945",
		"x-ratelimit-reset": "1, 45999",
	});
	assert.deepEqual(parseBraveRateLimitHeaders(headers), [
		{ limit: 1, windowSeconds: 1, remaining: 0, resetSeconds: 1 },
		{ limit: 2000, windowSeconds: 2592000, remaining: 1945, resetSeconds: 45999 },
	]);
});

test("serializes parallel work and delays the next request after an exhausted short bucket", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	let now = 0;
	const sleeps = [];
	const events = [];
	const limiter = new BraveRateLimitCoordinator({
		now: () => now,
		sleep: async ms => { sleeps.push(ms); now += ms; },
		safetyMarginMs: 100,
	});
	const headers = new Headers({
		"x-ratelimit-limit": "1, 2000",
		"x-ratelimit-policy": "1;w=1, 2000;w=2592000",
		"x-ratelimit-remaining": "0, 1999",
		"x-ratelimit-reset": "1, 2592000",
	});

	const first = limiter.run(async () => {
		events.push("first:start");
		limiter.observe(headers);
		events.push("first:end");
		return 1;
	});
	const second = limiter.run(async () => {
		events.push("second");
		return 2;
	});

	assert.deepEqual(await Promise.all([first, second]), [1, 2]);
	assert.deepEqual(events, ["first:start", "first:end", "second"]);
	assert.deepEqual(sleeps, [1100]);
});

test("does not throttle when Brave reports remaining capacity", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const sleeps = [];
	const limiter = new BraveRateLimitCoordinator({ sleep: async ms => { sleeps.push(ms); } });
	limiter.observe(new Headers({
		"x-ratelimit-limit": "20",
		"x-ratelimit-policy": "20;w=1",
		"x-ratelimit-remaining": "19",
		"x-ratelimit-reset": "1",
	}));
	await limiter.run(async () => undefined);
	assert.deepEqual(sleeps, []);
});

test("a failed operation does not poison the queue", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator();
	await assert.rejects(limiter.run(async () => { throw new Error("boom"); }), /boom/);
	assert.equal(await limiter.run(async () => "recovered"), "recovered");
});

test("aborting while queued prevents the queued operation from running", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator();
	let release;
	const first = limiter.run(() => new Promise(resolve => { release = resolve; }));
	const controller = new AbortController();
	let ran = false;
	const second = limiter.run(async () => { ran = true; }, controller.signal);
	controller.abort();
	await assert.rejects(second, /Aborted/);
	release();
	await first;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(ran, false);
});

test("a queued operation respects its caller deadline", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator();
	let release;
	const first = limiter.run(() => new Promise(resolve => { release = resolve; }));
	let ran = false;
	const second = limiter.run(async () => { ran = true; }, AbortSignal.timeout(10));
	await assert.rejects(second, /Aborted/);
	release();
	await first;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(ran, false);
});

test("refuses a long quota wait instead of sleeping inside a search call", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator({ maxWaitMs: 30_000 });
	limiter.observe(new Headers({
		"x-ratelimit-limit": "2000",
		"x-ratelimit-policy": "2000;w=2592000",
		"x-ratelimit-remaining": "0",
		"x-ratelimit-reset": "45999",
	}));
	await assert.rejects(limiter.run(async () => undefined), /quota exhausted.*Refusing to wait longer than 30s/i);
});

test("retry delay honors the longest advertised exhausted bucket", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator({ now: () => 0, safetyMarginMs: 100 });
	const headers = new Headers({
		"retry-after": "1",
		"x-ratelimit-limit": "1, 2000",
		"x-ratelimit-policy": "1;w=1, 2000;w=2592000",
		"x-ratelimit-remaining": "0, 0",
		"x-ratelimit-reset": "1, 45999",
	});
	assert.equal(limiter.retryDelay(headers), 45_999_100);
});

test("429 retry falls back to the exhausted rate-limit reset", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator({ now: () => 0, safetyMarginMs: 100 });
	const headers = new Headers({
		"x-ratelimit-limit": "1, 2000",
		"x-ratelimit-policy": "1;w=1, 2000;w=2592000",
		"x-ratelimit-remaining": "0, 1945",
		"x-ratelimit-reset": "1, 45999",
	});
	assert.equal(limiter.retryDelay(headers), 1_100);
});

test("Retry-After accepts an HTTP date", async () => {
	const { parseRetryAfterMs } = await import(limiterModuleUrl);
	assert.equal(parseRetryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 1970 00:00:02 GMT" }), 1_000), 1_000);
});

test("a rejected long Retry-After remains recorded for the next queued call", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	let now = 0;
	let slept = false;
	const limiter = new BraveRateLimitCoordinator({
		now: () => now,
		sleep: async () => { slept = true; },
		maxWaitMs: 30_000,
	});
	await assert.rejects(limiter.waitForRetry(60_000), /quota exhausted/i);
	await assert.rejects(limiter.run(async () => undefined), /quota exhausted/i);
	assert.equal(slept, false);
	now = 60_000;
	assert.equal(await limiter.run(async () => "ready"), "ready");
});

test("Brave records cooldown and retries when cancelling the 429 body rejects", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-cancel-reject-"));
	const child = runChild(`
		const calls = [];
		let cancelCalls = 0;
		globalThis.fetch = async url => {
			calls.push({ url: String(url), at: Date.now() });
			if (calls.length === 1) {
				const body = new ReadableStream({ cancel() { cancelCalls++; throw new Error("cancel failed"); } });
				return new Response(body, { status: 429, headers: { "retry-after": "0.01" } });
			}
			return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
		};
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		await searchWithBrave("cancel rejection");
		console.log(JSON.stringify({ calls: calls.length, cancelCalls, elapsed: calls[1].at - calls[0].at }));
	`, { HOME: home, USERPROFILE: home, BRAVE_API_KEY: "brave-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 2);
	assert.equal(output.cancelCalls, 1);
	assert.ok(output.elapsed >= 90, `retry happened before recorded cooldown: ${output.elapsed}ms`);
});

test("Brave cancels a retryable 429 body before retrying", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-retry-"));
	const child = runChild(`
		const calls = [];
		let cancelled = false;
		globalThis.fetch = async url => {
			calls.push(String(url));
			if (calls.length === 1) {
				const body = new ReadableStream({ cancel() { cancelled = true; } });
				return new Response(body, {
					status: 429,
					headers: { "retry-after": "0", "x-ratelimit-limit": "1", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" },
				});
			}
			return new Response(JSON.stringify({ web: { results: [{ title: "Result", url: "https://example.com", description: "ok" }] } }), { status: 200 });
		};
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		const result = await searchWithBrave("retry", { numResults: 1 });
		console.log(JSON.stringify({ calls: calls.length, cancelled, result }));
	`, { HOME: home, USERPROFILE: home, BRAVE_API_KEY: "brave-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 2);
	assert.equal(output.cancelled, true);
	assert.equal(output.result.results[0].url, "https://example.com");
});

test("aborting a rate-limit wait rejects without running the operation", async () => {
	const { BraveRateLimitCoordinator } = await import(limiterModuleUrl);
	const limiter = new BraveRateLimitCoordinator();
	limiter.observe(new Headers({
		"x-ratelimit-limit": "1",
		"x-ratelimit-policy": "1;w=1",
		"x-ratelimit-remaining": "0",
		"x-ratelimit-reset": "1",
	}));
	const controller = new AbortController();
	let ran = false;
	const pending = limiter.run(async () => { ran = true; }, controller.signal);
	controller.abort();
	await assert.rejects(pending, /Aborted/);
	assert.equal(ran, false);
});

test("Brave retries at most once", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-brave-retry-once-"));
	const child = runChild(`
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response("still limited", { status: 429, headers: { "retry-after": "0" } });
		};
		const { searchWithBrave } = await import(${JSON.stringify(braveModuleUrl)});
		try { await searchWithBrave("retry once"); }
		catch (error) { console.log(JSON.stringify({ calls, error: error.message })); }
	`, { HOME: home, USERPROFILE: home, BRAVE_API_KEY: "brave-test-key" });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.calls, 2);
	assert.match(output.error, /Brave Search API error 429/);
});
