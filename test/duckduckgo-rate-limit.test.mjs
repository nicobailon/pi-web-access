import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDuckGoBotCheckError, DuckDuckGoRateLimit, FileDuckDuckGoGateStore } from "../duckduckgo-rate-limit.ts";

const rateLimitModuleUrl = new URL("../duckduckgo-rate-limit.ts", import.meta.url).href;

function fakeClock() {
	const clock = { now: 0, sleeps: [] };
	clock.options = {
		now: () => clock.now,
		sleep: async (ms) => {
			clock.sleeps.push(ms);
			clock.now += ms;
		},
	};
	return clock;
}

function stateFile() {
	return join(mkdtempSync(join(tmpdir(), "pi-web-access-ddg-gate-")), "duckduckgo-rate-limit.json");
}

test("DuckDuckGo searches start at least the minimum gap apart", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 2000 });
	const starts = [];
	const operation = async () => {
		starts.push(clock.now);
		clock.now += 500;
		return starts.length;
	};
	assert.equal(await gate.run(operation), 1);
	assert.equal(await gate.run(operation), 2);
	assert.equal(await gate.run(operation), 3);
	assert.deepEqual(starts, [0, 2000, 4000]);
	assert.deepEqual(clock.sleeps, [1500, 1500]);
});

test("DuckDuckGo searches called together take consecutive slots", async () => {
	const clock = { now: 0 };
	const sleeps = [];
	const gate = new DuckDuckGoRateLimit({ now: () => clock.now, sleep: async (ms) => { sleeps.push(ms); }, minIntervalMs: 2000 });
	await Promise.all([gate.run(async () => {}), gate.run(async () => {}), gate.run(async () => {})]);
	assert.deepEqual(sleeps, [2000, 4000]);
});

test("DuckDuckGo limits starts per window and fails at once when the slot is past the deadline", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, windowMs: 10_000, maxStarts: 2, timeoutMs: 60_000 });
	let calls = 0;
	const ok = async () => { calls++; };
	await gate.run(ok);
	await gate.run(ok);
	await gate.run(ok);
	assert.deepEqual(clock.sleeps, [10_000], "the third start waits until the first leaves the window");

	const tight = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, windowMs: 10_000, maxStarts: 2, timeoutMs: 15_000 });
	await tight.run(ok);
	await tight.run(ok);
	await assert.rejects(tight.run(ok), /2 every 10s .*next free slot is in 10s \(rate limited\)/);
	assert.equal(calls, 5, "a search past its deadline never runs");
});

test("DuckDuckGo bot check starts a cooldown that fails fast, doubles, and resets after success", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 150_000, maxStrikes: 0 });
	let calls = 0;
	const blocked = async () => { calls++; throw new DuckDuckGoBotCheckError(202); };
	const ok = async () => { calls++; return "ok"; };

	await assert.rejects(gate.run(blocked), /bot check \(HTTP 202, rate limited\)/);
	await assert.rejects(gate.run(ok), /not retrying for 1m .*rate limited/);
	assert.equal(calls, 1);

	clock.now += 60_000;
	await assert.rejects(gate.run(blocked));
	clock.now += 119_000;
	await assert.rejects(gate.run(ok), /not retrying for 1s/);
	clock.now += 1000;
	await assert.rejects(gate.run(blocked));
	clock.now += 149_000;
	await assert.rejects(gate.run(ok), /not retrying/, "cooldown is capped at maxCooldownMs");
	clock.now += 1000;
	assert.equal(await gate.run(ok), "ok");

	await assert.rejects(gate.run(blocked));
	clock.now += 60_000;
	assert.equal(await gate.run(ok), "ok", "success resets the cooldown to its initial length");
	assert.equal(calls, 6);
});

test("DuckDuckGo slows down after each bot check and speeds up again over time", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({
		...clock.options, minIntervalMs: 5000, windowMs: 600_000, maxStarts: 20, cooldownMs: 60_000,
		maxStrikes: 2, strikeDecayMs: 3_600_000, timeoutMs: 40_000,
	});
	const ok = async () => {};
	const blocked = async () => { throw new DuckDuckGoBotCheckError(202); };
	const gapAfter = async () => {
		await gate.run(ok);
		const before = clock.sleeps.length;
		await gate.run(ok);
		return clock.sleeps.slice(before).reduce((sum, ms) => sum + ms, 0);
	};

	assert.equal(await gapAfter(), 5000);
	await assert.rejects(gate.run(blocked));
	clock.now += 600_000;
	assert.equal(await gapAfter(), 10_000, "one strike doubles the gap");
	await assert.rejects(gate.run(blocked));
	clock.now += 600_000;
	assert.equal(await gapAfter(), 20_000, "two strikes");
	clock.now += 600_000;
	for (let i = 0; i < 5; i++) await gate.run(ok);
	await assert.rejects(gate.run(ok), /one search every 20s and 5 every 10m .*rate limited/, "and the budget is quartered");

	clock.now += 3_600_000 + 600_000;
	assert.equal(await gapAfter(), 10_000, "an hour without a bot check forgives one strike");
	clock.now += 3_600_000;
	assert.equal(await gapAfter(), 5000);
});

test("DuckDuckGo counts one bot check when searches already in flight see it too", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, cooldownMs: 60_000 });
	const releases = [];
	const blockedLater = () => new Promise((_, reject) => releases.push(() => reject(new DuckDuckGoBotCheckError(202))));
	const first = assert.rejects(gate.run(blockedLater));
	const second = assert.rejects(gate.run(blockedLater));
	await new Promise(resolve => setImmediate(resolve));
	for (const release of releases) release();
	await Promise.all([first, second]);
	await assert.rejects(gate.run(async () => {}), /not retrying for 1m/, "the second bot check did not double the cooldown");
});

test("DuckDuckGo errors other than bot checks do not start a cooldown", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0 });
	await assert.rejects(gate.run(async () => { throw new Error("DuckDuckGo search error 503"); }), /503/);
	assert.equal(await gate.run(async () => "ok"), "ok");
});

test("DuckDuckGo waiting searches can be aborted without running", async () => {
	const gate = new DuckDuckGoRateLimit({ minIntervalMs: 60_000, timeoutMs: 120_000 });
	let calls = 0;
	await gate.run(async () => { calls++; });
	const controller = new AbortController();
	const waiting = gate.run(async () => { calls++; }, controller.signal);
	controller.abort();
	await assert.rejects(waiting, /Aborted/);
	await assert.rejects(gate.run(async () => { calls++; }, AbortSignal.abort()), /Aborted/);
	assert.equal(calls, 1);
});

test("DuckDuckGo deadline reports a timeout, not an abort", async () => {
	// AbortSignal.timeout does not keep Node running; a real request's socket would.
	const keepAlive = setTimeout(() => {}, 5000);
	const gate = new DuckDuckGoRateLimit({ minIntervalMs: 0, timeoutMs: 100 });
	const started = Date.now();
	await assert.rejects(
		gate.run(signal => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))),
		/DuckDuckGo request timed out after 1s/,
	);
	assert.ok(Date.now() - started < 1000);
	clearTimeout(keepAlive);
});

test("DuckDuckGo caller aborts still report an abort", async () => {
	const gate = new DuckDuckGoRateLimit({ minIntervalMs: 0, timeoutMs: 10_000 });
	const controller = new AbortController();
	const pending = gate.run(signal => new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(new Error("This operation was aborted")), { once: true });
	}), controller.signal);
	controller.abort();
	await assert.rejects(pending, /abort/i);
});

test("DuckDuckGo gates sharing a state file share slots and the cooldown", async () => {
	const path = stateFile();
	const clock = fakeClock();
	const options = { ...clock.options, minIntervalMs: 5000, cooldownMs: 60_000 };
	const first = new DuckDuckGoRateLimit({ ...options, store: new FileDuckDuckGoGateStore(path, 60_000) });
	const second = new DuckDuckGoRateLimit({ ...options, store: new FileDuckDuckGoGateStore(path, 60_000) });
	await first.run(async () => {});
	await second.run(async () => {});
	assert.deepEqual(clock.sleeps, [5000], "the second gate waited for the first gate's slot");

	await assert.rejects(first.run(async () => { throw new DuckDuckGoBotCheckError(202); }));
	let ran = false;
	await assert.rejects(second.run(async () => { ran = true; }), /not retrying for 1m/);
	assert.equal(ran, false);
	assert.equal(existsSync(`${path}.lock`), false, "the lock is released");
	const saved = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(saved.nextCooldownMs, 120_000);
	assert.equal(saved.strikes, 1, "the slower pace after a bot check is shared too");
});

test("DuckDuckGo cooldown recorded by another process stops this one", () => {
	const path = stateFile();
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { DuckDuckGoBotCheckError, DuckDuckGoRateLimit, FileDuckDuckGoGateStore } = await import(${JSON.stringify(rateLimitModuleUrl)});
			const gate = new DuckDuckGoRateLimit({ minIntervalMs: 0, store: new FileDuckDuckGoGateStore(${JSON.stringify(path)}) });
			await gate.run(async () => { throw new DuckDuckGoBotCheckError(202); }).catch(() => {});
		`,
		encoding: "utf8",
	});
	assert.equal(child.status, 0, child.stderr);
	const gate = new DuckDuckGoRateLimit({ minIntervalMs: 0, store: new FileDuckDuckGoGateStore(path) });
	return assert.rejects(gate.run(async () => {}), /not retrying for 30m so the block can clear/);
});

test("DuckDuckGo state file survives a stale lock and an unreadable file", async () => {
	const path = stateFile();
	writeFileSync(path, "not json");
	writeFileSync(`${path}.lock`, "");
	const old = new Date(Date.now() - 60_000);
	utimesSync(`${path}.lock`, old, old);
	const gate = new DuckDuckGoRateLimit({ minIntervalMs: 0, store: new FileDuckDuckGoGateStore(path) });
	assert.equal(await gate.run(async () => "ok"), "ok");
	assert.equal(existsSync(`${path}.lock`), false);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).starts.length, 1);
});
