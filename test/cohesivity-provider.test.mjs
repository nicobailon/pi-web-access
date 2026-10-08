import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cohesivityModuleUrl = new URL("../cohesivity.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const activityModuleUrl = new URL("../activity.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;
const KEY = "coh_app_test0key0abc123xyz9";

async function withHome(config, run) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-cohesivity-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
		return await run(home);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	// Drop every provider credential and endpoint so only the mocked fetch decides availability.
	for (const key of Object.keys(childEnv)) {
		if (key === "PI_CODING_AGENT_DIR" || key === "XDG_CONFIG_HOME" || /(?:_KEY|_TOKEN|_BASE_URL)$/.test(key)) delete childEnv[key];
	}
	Object.assign(childEnv, env);
	const child = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: childEnv, maxBuffer: 2 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const envelope = (results) => JSON.stringify({ requestId: "r1", resolvedSearchType: "neural", results, searchTime: 120, costDollars: { total: 0.005 } });
const apiError = (code, message) => JSON.stringify({ error: { code, message: `[Cohesivity] ${message}` } });

test("Cohesivity posts the query with the key as a URL parameter and maps highlights", () => withHome({ cohesivityApplicationKey: KEY }, async (home) => {
	const output = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, redirect: init.redirect, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(envelope([
				{ id: "1", title: " Paper ", url: "https://example.com/paper", publishedDate: "2026-10-01T00:00:00.000Z", highlights: ["First line\n\n  second   line", "x".repeat(800)] },
				{ id: "2", title: "Again", url: "https://example.com/paper", highlights: ["duplicate"] },
				{ id: "3", title: "", url: "https://example.net/untitled" },
				{ id: "4", title: "Summary only", url: "https://example.org/summary", summary: "A summary" },
				{ id: "5", title: "File", url: "file:///tmp/result", highlights: ["skipped"] },
			]))}, { status: 200 });
		};
		const { searchWithCohesivity, isCohesivityAvailable } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const result = await searchWithCohesivity("node release", { numResults: 50, recencyFilter: "week" });
		console.log(JSON.stringify({ captured, available: isCohesivityAvailable(), result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(output.available, true);
	const { COHESIVITY_SEARCH_URL } = await import(cohesivityModuleUrl);
	const sent = new URL(output.captured.url);
	assert.equal(`${sent.origin}${sent.pathname}`, COHESIVITY_SEARCH_URL);
	assert.deepEqual([...sent.searchParams], [["key", KEY]]);
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.redirect, "manual");
	assert.equal(output.captured.headers["User-Agent"], "pi-web-access");
	assert.doesNotMatch(JSON.stringify(output.captured.headers), new RegExp(KEY));
	const { startPublishedDate, ...rest } = output.captured.body;
	assert.deepEqual(rest, { query: "node release", numResults: 20, type: "auto", contents: { highlights: { numSentences: 2 } } });
	const ageDays = (Date.now() - Date.parse(startPublishedDate)) / 86_400_000;
	assert.ok(ageDays >= 7 && ageDays < 7.01, `startPublishedDate should be a week back, got ${startPublishedDate}`);
	const [paper, untitled, summary, ...others] = output.result.results;
	assert.equal(paper.title, "Paper");
	assert.equal(paper.snippet.length, 500);
	assert.ok(paper.snippet.startsWith("First line second line x"));
	assert.deepEqual(untitled, { title: "Source 2", url: "https://example.net/untitled", snippet: "" });
	assert.equal(summary.snippet, "A summary");
	assert.deepEqual(others, []);
	assert.match(output.result.answer, /Source: Paper \(https:\/\/example\.com\/paper\)/);
	assert.doesNotMatch(JSON.stringify(output.result), new RegExp(KEY));
}));

test("Cohesivity needs a key, and COHESIVITY_APPLICATION_KEY takes precedence over the config value", async () => {
	await withHome({}, (home) => {
		const output = runChild(`
			globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
			const { searchWithCohesivity, isCohesivityAvailable } = await import(${JSON.stringify(cohesivityModuleUrl)});
			let error;
			try { await searchWithCohesivity("q"); } catch (err) { error = String(err); }
			console.log(JSON.stringify({ available: isCohesivityAvailable(), error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.available, false);
		assert.match(output.error, /Cohesivity application key not found/);
		assert.match(output.error, /COHESIVITY_APPLICATION_KEY/);
		assert.match(output.error, /npx @cohesivity\/init/);
	});
	for (const [config, env, expected] of [
		[{ cohesivityApplicationKey: "coh_app_configkey0000000000" }, { COHESIVITY_APPLICATION_KEY: "coh_app_envkey000000000000" }, "coh_app_envkey000000000000"],
		[{ cohesivityApplicationKey: "$MY_COH_KEY" }, { MY_COH_KEY: "coh_app_named0000000000000", COHESIVITY_APPLICATION_KEY: "coh_app_envkey000000000000" }, "coh_app_named0000000000000"],
	]) {
		await withHome(config, (home) => {
			const output = runChild(`
				let key;
				globalThis.fetch = async (url) => { key = new URL(String(url)).searchParams.get("key"); return new Response(${JSON.stringify(envelope([]))}); };
				const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
				const result = await searchWithCohesivity("q");
				console.log(JSON.stringify({ key, results: result.results }));
			`, { PI_CODING_AGENT_DIR: home, ...env });
			assert.equal(output.key, expected);
			assert.deepEqual(output.results, []);
		});
	}
});

test("Cohesivity sends domain filters natively and reapplies them locally", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		const bodies = [];
		globalThis.fetch = async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response(${JSON.stringify(envelope([
				{ title: "Allowed", url: "https://docs.example.com/a", highlights: ["a"] },
				{ title: "Excluded", url: "https://private.docs.example.com/b", highlights: ["b"] },
				{ title: "Outside", url: "https://example.net/c", highlights: ["c"] },
				{ title: "Other allowed", url: "https://example.org/d", highlights: ["d"] },
			]))});
		};
		const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const single = await searchWithCohesivity("single", { domainFilter: ["https://example.com/"], numResults: 3 });
		const several = await searchWithCohesivity("several", { domainFilter: ["example.com", "example.org", "-private.docs.example.com", "-not a domain"], numResults: 3 });
		console.log(JSON.stringify({ bodies, single: single.results.map(r => r.url), several: several.results.map(r => r.url) }));
	`, { PI_CODING_AGENT_DIR: home });
	const [singleBody, severalBody] = output.bodies;
	assert.deepEqual(singleBody.includeDomains, ["example.com"]);
	assert.equal(singleBody.excludeDomains, undefined);
	assert.equal(singleBody.startPublishedDate, undefined);
	assert.equal(singleBody.query, "single");
	assert.equal(singleBody.numResults, 3);
	assert.deepEqual(severalBody.includeDomains, ["example.com", "example.org"]);
	assert.deepEqual(severalBody.excludeDomains, ["private.docs.example.com"]);
	assert.deepEqual(output.single, ["https://docs.example.com/a", "https://private.docs.example.com/b"]);
	assert.deepEqual(output.several, ["https://docs.example.com/a", "https://example.org/d"]);
}));

test("Cohesivity is selectable explicitly, in provider arrays, and in searchRouting, but excluded from auto and provider all", async () => {
	await withHome({ cohesivityApplicationKey: KEY }, (home) => {
		const output = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target);
				if (target.startsWith("https://cohesivity.ai/")) return new Response(${JSON.stringify(envelope([{ title: "Cohesivity", url: "https://example.com", highlights: ["result"] }]))});
				// Every other provider fails, so auto and all can only succeed by using Cohesivity.
				return new Response("unavailable", { status: 503 });
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const explicit = await search("explicit", { provider: "cohesivity" });
			const array = await search("array", { provider: ["cohesivity"] });
			const before = calls.length;
			const outcomes = [];
			for (const provider of ["auto", "all"]) {
				try { outcomes.push((await search(provider, { provider })).provider ?? "aggregate"); } catch { outcomes.push("failed"); }
			}
			console.log(JSON.stringify({ explicitProvider: explicit.provider, arrayProviders: array.providerResponses.map(result => result.provider), outcomes, laterCalls: calls.slice(before), calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.explicitProvider, "cohesivity");
		assert.deepEqual(output.arrayProviders, ["cohesivity"]);
		assert.deepEqual(output.outcomes, ["failed", "failed"]);
		assert.ok(output.laterCalls.length > 0, "auto and all should have tried other providers");
		assert.equal(output.laterCalls.filter(url => url.startsWith("https://cohesivity.ai/")).length, 0);
		assert.equal(output.calls.filter(url => url.startsWith("https://cohesivity.ai/")).length, 2);
	});

	await withHome({
		cohesivityApplicationKey: KEY,
		braveApiKey: "brave-test-key",
		searchRouting: { providers: ["cohesivity", "brave"], fallbackOn: ["quota"] },
	}, (home) => {
		const output = runChild(`
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(new URL(target).hostname);
				if (target.startsWith("https://cohesivity.ai/")) return new Response(${JSON.stringify(apiError(429, "Rate limit exceeded"))}, { status: 429 });
				if (target.startsWith("https://api.search.brave.com/res/v1/web/search")) {
					return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "fallback" }] } }), { status: 200 });
				}
				throw new Error("Unexpected fetch " + target);
			};
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const routed = await search("limited", { provider: "auto" });
			console.log(JSON.stringify({ provider: routed.provider, routed, calls }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(output.provider, "brave");
		assert.deepEqual(output.calls, ["cohesivity.ai", "api.search.brave.com"]);
		assert.doesNotMatch(JSON.stringify(output.routed), new RegExp(KEY));
	});
});

test("Cohesivity errors name the provider and status, give hints, and never contain the key", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		const responses = [
			() => new Response(${JSON.stringify(apiError(400, "Missing authentication"))}, { status: 400 }),
			() => new Response(${JSON.stringify(apiError(401, "Invalid application key"))}, { status: 401 }),
			() => new Response(${JSON.stringify(apiError(403, "Service not provisioned"))}, { status: 403 }),
			() => new Response(${JSON.stringify(apiError(403, "Search type 'deep' is not allowed"))}, { status: 403 }),
			() => new Response(${JSON.stringify(apiError(429, "Rate limit exceeded"))}, { status: 429 }),
			// A hostile or buggy upstream that echoes the request URL must still be redacted.
			(url) => new Response("upstream failure for " + url, { status: 502 }),
			(url) => { throw new TypeError("fetch failed for " + url, { cause: new Error("connect ECONNREFUSED " + url) }); },
			() => new Response(JSON.stringify({ requestId: "r" }), { status: 200 }),
			() => new Response("not json", { status: 200 }),
		];
		globalThis.fetch = async (url) => responses.shift()(String(url));
		const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const { activityMonitor } = await import(${JSON.stringify(activityModuleUrl)});
		const errors = [];
		for (let i = 0; i < 9; i++) {
			try { await searchWithCohesivity("broken"); } catch (error) { errors.push({ text: String(error), cause: error.cause === undefined ? null : String(error.cause), name: error.name }); }
		}
		console.log(JSON.stringify({ errors, activity: activityMonitor.getEntries() }));
	`, { PI_CODING_AGENT_DIR: home });
	const [missing, invalid, unprovisioned, blocked, limited, echoed, network, malformed, json] = output.errors;
	assert.equal(missing.text, "Error: Cohesivity search error 400: Missing authentication");
	assert.match(invalid.text, /^Error: Cohesivity search error 401: Invalid application key \(check that cohesivityApplicationKey or COHESIVITY_APPLICATION_KEY is the coh_application_key/);
	assert.match(unprovisioned.text, /^Error: Cohesivity search error 403: Service not provisioned \(search must be provisioned once .*ask your coding agent/);
	assert.equal(blocked.text, "Error: Cohesivity search error 403: Search type 'deep' is not allowed");
	assert.match(limited.text, /^Error: Cohesivity search error 429: Rate limit exceeded \(rate limited; anonymous projects allow 5 search requests per minute/);
	assert.match(echoed.text, /^Error: Cohesivity search error 502: upstream failure for .*key=\[redacted\]/);
	assert.match(network.text, /^TypeError: fetch failed for .*key=\[redacted\]/);
	assert.equal(network.cause, null);
	assert.match(malformed.text, /Cohesivity search returned invalid response: expected results array/);
	assert.match(json.text, /Cohesivity search returned invalid JSON/);
	assert.doesNotMatch(JSON.stringify(output), new RegExp(KEY));
	assert.ok(output.activity.some(entry => /error 401/.test(entry.error ?? "")));
}));

test("Cohesivity routing diagnostics for a failed named provider never contain the key", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		globalThis.fetch = async (url) => { throw new TypeError("fetch failed for " + url); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		let failure;
		try { await search("q", { provider: "cohesivity" }); } catch (error) { failure = { text: String(error), json: JSON.stringify(error, Object.getOwnPropertyNames(error)), cause: String(error.cause?.message ?? "") }; }
		console.log(JSON.stringify(failure));
	`, { PI_CODING_AGENT_DIR: home });
	assert.match(output.text, /fetch failed/);
	assert.doesNotMatch(JSON.stringify(output), new RegExp(KEY));
}));

test("Cohesivity refuses redirects so the key never reaches another URL", () => withHome({ cohesivityApplicationKey: KEY }, (home) => {
	const output = runChild(`
		const calls = [];
		const locations = ["https://collector.example/steal?key=" + ${JSON.stringify(KEY)}, "/edge/moved"];
		globalThis.fetch = async (url, init) => {
			calls.push({ target: String(url), redirect: init.redirect });
			if (calls.length <= 2) return new Response(null, { status: 307, headers: { location: locations[calls.length - 1] } });
			return new Response(${JSON.stringify(envelope([]))});
		};
		const { searchWithCohesivity } = await import(${JSON.stringify(cohesivityModuleUrl)});
		const errors = [];
		for (let i = 0; i < 2; i++) {
			try { await searchWithCohesivity("redirect"); } catch (error) { errors.push(String(error)); }
		}
		console.log(JSON.stringify({ calls: calls.map(call => ({ origin: new URL(call.target).origin, redirect: call.redirect })), errors }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.deepEqual(output.calls, [
		{ origin: "https://cohesivity.ai", redirect: "manual" },
		{ origin: "https://cohesivity.ai", redirect: "manual" },
	]);
	assert.deepEqual(output.errors, [
		"Error: Cohesivity search error 307: refused an unexpected redirect",
		"Error: Cohesivity search error 307: refused an unexpected redirect",
	]);
}));

test("Cohesivity appears in the Curator", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const available = new Proxy({ all: false, cohesivity: true }, { get: (target, property) => target[property] ?? false });
	const page = generateCuratorPage(["query"], "token", 20, available, "cohesivity", "cohesivity", [], null);
	assert.match(page, /data-provider="cohesivity"/);
	assert.match(page, />Cohesivity<\/button>/);
	assert.match(page, /provider === "cohesivity"\) return "Cohesivity"/);
});
