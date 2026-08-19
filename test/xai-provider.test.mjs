import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const xaiModuleUrl = new URL("../xai-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-xai-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XAI_API_KEY", "ANYSEARCH_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "SEARXNG_BASE_URL", "EXA_API_KEY",
		"PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

// The shape a live SuperGrok account actually returns: sources are split across
// `url_citation` annotations on the answer and the raw `web_search_call` sources.
// There is deliberately no top-level `citations` array — reading one is the bug
// this fixture exists to catch.
function successBody() {
	return JSON.stringify({
		output: [
			{ type: "web_search_call", action: { sources: [{ url: "https://x.ai/news", title: "xAI News" }] } },
			{
				type: "message",
				content: [{
					type: "output_text",
					text: "Grok Imagine v1.5 shipped with reference images.",
					annotations: [{ type: "url_citation", url: "https://x.ai/news/grok-imagine", title: "Grok Imagine", start_index: 0, end_index: 12 }],
				}],
			},
		],
		citations: ["https://wrong.example.com/never-read-this"],
	});
}

test("xAI posts the verified minimal Responses body and reads both source shapes", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(successBody())}, { status: 200 });
		};
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		const result = await searchWithXai("what shipped?");
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());

	assert.equal(captured.url, "https://api.x.ai/v1/responses");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.authorization, "Bearer xai-key");
	// Only these three fields are verified against a live account. Adding
	// stream/include/tool_choice/parallel_tool_calls risks a 400 that costs the
	// user the whole search, so the body must stay exactly this shape.
	assert.deepEqual(Object.keys(captured.body).sort(), ["input", "model", "tools"]);
	assert.deepEqual(captured.body.tools, [{ type: "web_search" }]);
	assert.match(captured.body.input, /what shipped\?$/);

	assert.match(result.answer, /Grok Imagine v1\.5 shipped/);
	// Annotations carry titles, so they win the dedupe and come first; the
	// web_search_call sources fill in what they missed.
	assert.deepEqual(result.results.map((r) => r.url), ["https://x.ai/news/grok-imagine", "https://x.ai/news"]);
	assert.equal(result.results[0].title, "Grok Imagine");
});

test("xAI folds recency and domain filters into the prompt rather than tool params", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("filtered", { recencyFilter: "week", domainFilter: ["example.com", "-spam.example"], numResults: 4 });
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const body = JSON.parse(child.stdout.trim());
	assert.deepEqual(body.tools, [{ type: "web_search" }]);
	assert.match(body.input, /past week/);
	assert.match(body.input, /Only use sources from: example\.com\./);
	assert.match(body.input, /Do not use sources from: spam\.example\./);
	assert.match(body.input, /around 4 distinct sources/);
});

// The registry path survives model retirement by walking AUTH_MODEL_CANDIDATES
// against models pi actually knows. The api-key path can't — nothing tells it
// which ids are live — so `xaiSearchModel` is its escape hatch, the same one
// `openaiSearchModel` gives the OpenAI backend.
test("xaiSearchModel pins the model id on the api-key path", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchModel: "  grok-5  " });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("pinned");
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).model, "grok-5");
});

test("xAI defaults to the first candidate model when xaiSearchModel is unset", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("default");
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).model, "grok-4.5");
});

test("a non-string or empty xaiSearchModel is rejected rather than silently ignored", async () => {
	for (const bad of [42, "   "]) {
		const home = await createHome({ xaiApiKey: "xai-key", xaiSearchModel: bad });
		const child = runChild(`
			globalThis.fetch = async () => { throw new Error("must not reach the network"); };
			const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			try {
				await searchWithXai("bad model");
				console.log(JSON.stringify({ threw: false }));
			} catch (err) {
				console.log(JSON.stringify({ threw: true, message: err.message }));
			}
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const { threw, message } = JSON.parse(child.stdout.trim());
		assert.equal(threw, true, `xaiSearchModel ${JSON.stringify(bad)} should be rejected`);
		assert.match(message, /xaiSearchModel .* must be a non-empty string/);
	}
});

test("explicit xai provider routing works", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "xai" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "xai-env-key" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { provider: "xai", calls: ["https://api.x.ai/v1/responses"] });
});

test("xAI is never part of auto fallback, even with a key configured", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("unexpected auto provider"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { await search("auto", { provider: "auto" }); console.log(JSON.stringify({ ok: true, calls })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error), calls })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.x.ai/")));
});

test("provider \"all\" does not fan out to xAI", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", braveApiKey: "brave-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.x.ai/")) throw new Error("xAI must not be part of all");
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("fan out", { provider: "all" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "all");
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.x.ai/")));
});

test("xAI without any credential explains all three ways to supply one", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async () => { throw new Error("must not reach the network"); };
		const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
		const available = await isXaiSearchAvailable();
		try { await searchWithXai("nope"); console.log(JSON.stringify({ available, ok: true })); }
		catch (error) { console.log(JSON.stringify({ available, ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
	assert.equal(output.ok, false);
	assert.match(output.error, /SuperGrok or X Premium subscription/);
	assert.match(output.error, /xaiApiKey/);
	assert.match(output.error, /XAI_API_KEY/);
});

test("xAI HTTP errors redact the credential", async () => {
	const home = await createHome({ xaiApiKey: "xai-secret" });
	const child = runChild(`
		globalThis.fetch = async () => new Response("denied for xai-secret", { status: 401 });
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		try { await searchWithXai("redact"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.doesNotMatch(output.error, /xai-secret/);
	assert.match(output.error, /\[redacted\]/);
});

test("curator page exposes xAI as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["query"],
		"token",
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
			gemini: false,
			kimi: false,
			anysearch: false,
			xai: true,
		},
		"xai",
		"xai",
		[],
		null,
	);

	assert.match(page, />xAI<\/button>/);
	assert.match(page, /"xai":true/);
});

test("xAI answers with no answer text and no sources fail loudly", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ output: [] }), { status: 200 });
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		try { await searchWithXai("empty"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /returned no answer or sources/);
});
