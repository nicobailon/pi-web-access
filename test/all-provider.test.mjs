import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

function runChild(script, env = {}) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"SEARCH1API_KEY",
		"SEARCHINFINITY_API_KEY",
		"QUERIT_API_KEY",
		"TAVILY_API_KEY",
		"FIRECRAWL_BASE_URL",
		"FIRECRAWL_API_KEY",
		"JINA_API_KEY",
		"SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY",
		"ANYSEARCH_API_KEY",
		"SEARXNG_BASE_URL",
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
		"CLOUDFLARE_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
		timeout: 10_000,
	});
}

test('provider "all" starts every eligible provider together, excludes AnySearch, and deduplicates sources', async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-all-"));
	const child = runChild(`
		const started = [];
		const expected = new Set(["exa", "brave", "tinyfish", "search1api"]);
		let releaseGate;
		const gate = new Promise((resolve) => { releaseGate = resolve; });

		async function waitForPeers(provider) {
			started.push(provider);
			if (expected.size === new Set(started).size && [...expected].every((name) => started.includes(name))) {
				releaseGate();
			}
			await gate;
		}

		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target.startsWith("https://api.anysearch.com/")) {
				throw new Error("AnySearch must not run for provider all");
			}
			if (target.startsWith("https://mcp.exa.ai/mcp")) {
				await waitForPeers("exa");
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{
							type: "text",
							text: "Title: Shared result\\nURL: https://example.com/shared\\nText: Exa answer\\n---",
						}],
					},
				}), { status: 200 });
			}
			if (target.startsWith("https://api.search.brave.com/")) {
				await waitForPeers("brave");
				return new Response(JSON.stringify({
					web: { results: [{ title: "Shared result", url: "https://example.com/shared", description: "Brave answer" }] },
				}), { status: 200 });
			}
			if (target.startsWith("https://api.search.tinyfish.ai")) {
				await waitForPeers("tinyfish");
				return new Response(JSON.stringify({
					query: "combined",
					results: [{ title: "TinyFish result", url: "https://example.com/tinyfish", snippet: "TinyFish answer" }],
					total_results: 1,
					page: 0,
				}), { status: 200 });
			}
			if (target === "https://api.search1api.com/search") {
				await waitForPeers("search1api");
				return new Response(JSON.stringify({
					searchParameters: { query: "combined" },
					results: [{ title: "Search1API result", link: "https://example.com/search1api", snippet: "Search1API answer" }],
				}), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("combined", { provider: "all" });
		console.log(JSON.stringify({ started, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TINYFISH_API_KEY: "tinyfish-test-key",
		SEARCH1API_KEY: "search1api-test-key",
	});

	assert.equal(child.status, 0, child.stderr || child.error?.message);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual([...output.started].sort(), ["brave", "exa", "search1api", "tinyfish"]);
	assert.equal(output.result.provider, "all");
	assert.deepEqual(output.result.providerResponses.map((result) => result.provider), ["exa", "brave", "tinyfish", "search1api"]);
	assert.deepEqual(output.result.results.map((result) => result.url), [
		"https://example.com/shared",
		"https://example.com/tinyfish",
		"https://example.com/search1api",
	]);
	assert.match(output.result.answer, /## Exa/);
	assert.match(output.result.answer, /## Brave/);
	assert.match(output.result.answer, /## TinyFish/);
	assert.match(output.result.answer, /## Search1API/);
	assert.doesNotMatch(output.result.answer, /AnySearch/);
});

test('provider array searches only the selected providers concurrently and preserves their order', async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-selected-"));
	const child = runChild(`
		const started = [];
		let releaseGate;
		const gate = new Promise((resolve) => { releaseGate = resolve; });

		async function waitForPeer(provider) {
			started.push(provider);
			if (started.length === 2) releaseGate();
			await gate;
		}

		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target.startsWith("https://mcp.exa.ai/mcp")) {
				await waitForPeer("exa");
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { content: [{ type: "text", text: "Title: Exa result\\nURL: https://example.com/exa\\nText: Exa answer\\n---" }] },
				}), { status: 200 });
			}
			if (target.startsWith("https://api.search.brave.com/")) {
				await waitForPeer("brave");
				return new Response(JSON.stringify({
					web: { results: [{ title: "Brave result", url: "https://example.com/brave", description: "Brave answer" }] },
				}), { status: 200 });
			}
			if (target.startsWith("https://api.search.tinyfish.ai")) {
				throw new Error("Unselected TinyFish provider must not run");
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("selected", { provider: ["brave", "exa"] });
		console.log(JSON.stringify({ started, result }));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
		TINYFISH_API_KEY: "tinyfish-test-key",
	});

	assert.equal(child.status, 0, child.stderr || child.error?.message);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual([...output.started].sort(), ["brave", "exa"]);
	assert.deepEqual(output.result.providerResponses.map((result) => result.provider), ["brave", "exa"]);
	assert.deepEqual(output.result.results.map((result) => result.url), [
		"https://example.com/brave",
		"https://example.com/exa",
	]);
});

test('provider array reports an unavailable selection without discarding successful providers', async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-selected-unavailable-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target.startsWith("https://mcp.exa.ai/mcp")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: { content: [{ type: "text", text: "Title: Exa result\\nURL: https://example.com/exa\\nText: Exa answer\\n---" }] },
				}), { status: 200 });
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("partial selection", { provider: ["brave", "exa"] });
		console.log(JSON.stringify(result));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});

	assert.equal(child.status, 0, child.stderr || child.error?.message);
	const output = JSON.parse(child.stdout.trim());
	assert.deepEqual(output.providerResponses.map((result) => result.provider), ["exa"]);
	assert.equal(output.providerErrors.length, 1);
	assert.equal(output.providerErrors[0].provider, "brave");
	assert.match(output.providerErrors[0].error, /Brave Search API key not found/);
	assert.match(output.answer, /\*\*Brave:\*\* Brave Search API key not found/);
});

test('provider "all" uses Gemini API without falling back to Gemini Web', async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-all-gemini-api-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target.startsWith("https://mcp.exa.ai/mcp")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{
							type: "text",
							text: "Title: Exa result\\nURL: https://example.com/exa\\nText: Exa answer\\n---",
						}],
					},
				}), { status: 200 });
			}
			if (target.includes("generativelanguage.googleapis.com")) {
				return new Response("api unavailable", { status: 503 });
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("gemini api failure", { provider: "all" });
		console.log(JSON.stringify(result));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		GEMINI_API_KEY: "synthetic-gemini-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "all");
	assert.deepEqual(output.providerResponses.map((result) => result.provider), ["exa"]);
	assert.equal(output.providerErrors.length, 1);
	assert.equal(output.providerErrors[0].provider, "gemini");
	assert.match(output.providerErrors[0].error, /Gemini API error 503/);
	assert.doesNotMatch(output.providerErrors[0].error, /Gemini Web/);
});

test('provider "all" keeps successful providers when another available provider fails', async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-all-partial-"));
	const child = runChild(`
		globalThis.fetch = async (url) => {
			const target = String(url);
			if (target.startsWith("https://mcp.exa.ai/mcp")) {
				return new Response(JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					result: {
						content: [{
							type: "text",
							text: "Title: Exa result\\nURL: https://example.com/exa\\nText: Exa answer\\n---",
						}],
					},
				}), { status: 200 });
			}
			if (target.startsWith("https://api.search.brave.com/")) {
				return new Response("temporarily unavailable", { status: 503 });
			}
			throw new Error("Unexpected fetch " + target);
		};

		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("partial", { provider: "all" });
		console.log(JSON.stringify(result));
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
		BRAVE_API_KEY: "brave-test-key",
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "all");
	assert.deepEqual(output.providerResponses.map((result) => result.provider), ["exa"]);
	assert.equal(output.providerErrors.length, 1);
	assert.equal(output.providerErrors[0].provider, "brave");
	assert.match(output.providerErrors[0].error, /Brave Search API error 503/);
	assert.equal(output.results[0].url, "https://example.com/exa");
	assert.match(output.answer, /## Provider errors/);
	assert.match(output.answer, /\*\*Brave:\*\* Brave Search API error 503/);
});

test('provider arrays reject empty, duplicate, and aggregate entries', async () => {
	const { normalizeSearchProviderSelection } = await import(searchModuleUrl);
	assert.deepEqual(normalizeSearchProviderSelection([" Brave ", "EXA"]), ["brave", "exa"]);
	assert.throws(() => normalizeSearchProviderSelection([]), /must be a non-empty array/);
	assert.throws(() => normalizeSearchProviderSelection(["exa", "exa"]), /must not contain duplicates: exa/);
	assert.throws(() => normalizeSearchProviderSelection(["all"]), /contains an invalid provider: all/);
});

test('"all" is a Curator provider but remains invalid inside sequential searchRouting', async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["combined query"],
		"session-token",
		20,
		{
			all: true,
			openai: false,
			brave: true,
			parallel: false,
			tinyfish: true,
			search1api: false,
			searchinfinity: false,
			querit: false,
			tavily: false,
			serpdive: false,
			searxng: false,
			perplexity: false,
			exa: true,
			gemini: false,
			kimi: false,
			anysearch: true,
		},
		"all",
		"all",
		[],
		null,
	);
	assert.match(page, /data-provider="all"/);
	assert.match(page, />All<\/button>/);
	assert.match(page, /provider-tag\.provider-all/);
	assert.match(page, /function applySearchResponseEntries/);
	assert.match(page, /data\.slotIndex/);
	assert.match(page, /var idleSec = searchesDone \? Math\.floor/,
		"curator timeout must not start while initial provider searches are still running");

	const geminiWebOnlyPage = generateCuratorPage(
		["gemini web only"],
		"session-token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			search1api: false,
			searchinfinity: false,
			querit: false,
			tavily: false,
			serpdive: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: true,
			kimi: false,
			anysearch: false,
		},
		"gemini",
		"gemini",
		[],
		null,
	);
	assert.doesNotMatch(geminiWebOnlyPage, /data-provider="all"/);
	assert.match(geminiWebOnlyPage, /data-provider="gemini"/);

	const home = await mkdtemp(join(tmpdir(), "pi-web-access-all-routing-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		searchRouting: { providers: ["all"], fallbackOn: ["network"] },
	}));
	const child = runChild(`
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try {
			await search("invalid routing", { provider: "auto" });
			console.log(JSON.stringify({ ok: true }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: String(error) }));
		}
	`, {
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: home,
	});
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /searchRouting\.providers .*invalid provider: all/);
});
