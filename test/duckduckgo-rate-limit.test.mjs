import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DuckDuckGoBotCheckError, DuckDuckGoRateLimit } from "../duckduckgo-rate-limit.ts";

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

/** A clock whose sleeps only end when the test wakes them. */
function manualClock() {
	const clock = { now: 0, wakeups: [] };
	clock.options = { now: () => clock.now, sleep: () => new Promise(resolve => clock.wakeups.push(resolve)) };
	clock.wakeAt = async (now) => {
		clock.now = now;
		for (const wake of clock.wakeups.splice(0)) wake();
		await settle();
	};
	return clock;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-web-access-ddg-gate-"));
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

test("DuckDuckGo searches called together start one gap apart", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 2000 });
	const starts = [];
	await Promise.all([1, 2, 3].map(() => gate.run(async () => { starts.push(clock.now); })));
	assert.deepEqual(starts, [0, 2000, 4000]);
});

test("DuckDuckGo searches woken late still start a full gap after the previous start", async () => {
	const clock = manualClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 10_000, timeoutMs: 120_000 });
	const starts = [];
	const runs = [1, 2, 3].map(() => gate.run(async () => { starts.push(clock.now); }));
	await settle();
	assert.deepEqual(starts, [0]);
	// The process was suspended past two slots; every pending timer fires on resume.
	await clock.wakeAt(21_000);
	assert.deepEqual(starts, [0, 21_000]);
	await clock.wakeAt(31_000);
	await Promise.all(runs);
	assert.deepEqual(starts, [0, 21_000, 31_000]);
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

test("DuckDuckGo fails a search at once when the searches queued ahead of it fill its deadline", async () => {
	const clock = manualClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 10_000, timeoutMs: 30_000 });
	let calls = 0;
	const queued = [1, 2, 3].map(() => gate.run(async () => { calls++; }));
	await assert.rejects(gate.run(async () => { calls++; }), /one search every 10s .*next free slot is in 30s \(rate limited\)/);
	await settle();
	await clock.wakeAt(10_000);
	await clock.wakeAt(20_000);
	await Promise.all(queued);
	assert.equal(calls, 3, "the three searches that fit before their deadline ran");
});

test("DuckDuckGo bot check starts a cooldown that fails fast, doubles, and resets after success", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, cooldownMs: 60_000, maxCooldownMs: 150_000 });
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

test("DuckDuckGo counts one bot check when searches already in flight see it too", async () => {
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, cooldownMs: 60_000 });
	const releases = [];
	const blockedLater = () => new Promise((_, reject) => releases.push(() => reject(new DuckDuckGoBotCheckError(202))));
	const first = assert.rejects(gate.run(blockedLater));
	const second = assert.rejects(gate.run(blockedLater));
	await settle();
	assert.equal(releases.length, 2);
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

test("DuckDuckGo bot-check pause recorded by one gate stops another using the same state file", async () => {
	const statePath = join(tempDir(), "config", "duckduckgo-cooldown.json");
	const clock = fakeClock();
	const options = { ...clock.options, minIntervalMs: 0, cooldownMs: 60_000, statePath };
	const first = new DuckDuckGoRateLimit(options);
	const second = new DuckDuckGoRateLimit(options);
	await assert.rejects(first.run(async () => { throw new DuckDuckGoBotCheckError(202); }));
	let ran = false;
	await assert.rejects(second.run(async () => { ran = true; }), /not retrying for 1m/);
	assert.equal(ran, false);
	clock.now += 60_000;
	assert.equal(await second.run(async () => "ok"), "ok");
});

test("DuckDuckGo searches still work when the state file is garbled or cannot be written", async () => {
	const dir = tempDir();
	const garbled = join(dir, "duckduckgo-cooldown.json");
	writeFileSync(garbled, "not json");
	assert.equal(await new DuckDuckGoRateLimit({ minIntervalMs: 0, statePath: garbled }).run(async () => "ok"), "ok");

	const notADirectory = join(dir, "file");
	writeFileSync(notADirectory, "");
	const clock = fakeClock();
	const gate = new DuckDuckGoRateLimit({ ...clock.options, minIntervalMs: 0, cooldownMs: 60_000, statePath: join(notADirectory, "duckduckgo-cooldown.json") });
	await assert.rejects(gate.run(async () => { throw new DuckDuckGoBotCheckError(202); }), /bot check/);
	await assert.rejects(gate.run(async () => {}), /not retrying for 1m/, "the pause still holds in this process");
	clock.now += 60_000;
	assert.equal(await gate.run(async () => "ok"), "ok", "a failed write does not discard the result");
});
