import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TINYFISH_API_KEY",
		"TAVILY_API_KEY",
		"JINA_API_KEY",
		"EXA_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

async function setupHome() {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-317-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		customSearchProviders: {
			stub: { url: "https://search.example.com/serp", method: "POST", body: { q: "{query}" }, results: "organic_results", fields: { title: "title", url: "link", snippet: "snippet" } },
		},
	}) + "\n", "utf8");
	return home;
}

// Runs web_search with the given params and returns the result plus queries the stub provider received.
function runWebSearch(home, params) {
	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (url, init) => {
			let q = null;
			try { q = JSON.parse(init.body).q; } catch {}
			requests.push({ url: String(url), q });
			return new Response(JSON.stringify({
				organic_results: [
					{ position: 1, title: "R1", link: "https://example.com/1", snippet: "s1" },
					{ position: 2, title: "R2", link: "https://example.com/2", snippet: "s2" },
				],
			}), { status: 200 });
		};
		const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
		const tools = [];
		initializeExtension({
			registerTool(tool) { tools.push(tool); },
			registerCommand() {},
			registerShortcut() {},
			on() {},
			appendEntry() {},
			sendMessage() {},
			exec() { return { code: 0 }; },
		});
		const webSearch = tools.find((tool) => tool.name === "web_search");
		const result = await webSearch.execute("call", ${JSON.stringify(params)});
		const queries = requests
			.filter((request) => request.url === "https://search.example.com/serp")
			.map((request) => request.q);
		console.log(JSON.stringify({ result, queries }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

function capturedQueries(home, params) {
	return runWebSearch(home, params).queries;
}

test("web_search expands a JSON-array string in query into separate searches", async () => {
	const home = await setupHome();
	// What a small/local model actually sends: the queries array serialized as
	// a JSON string inside the single-string `query` field.
	const queries = capturedQueries(home, {
		query: '["AGP version", "Compose BOM", "CameraX"]',
		provider: "stub",
		workflow: "none",
		numResults: 2,
	});
	assert.deepEqual(queries, ["AGP version", "Compose BOM", "CameraX"]);
});

test("web_search keeps mixed JSON arrays in query as a single literal query", async () => {
	const home = await setupHome();
	const queries = capturedQueries(home, {
		query: '["AGP version", 5]',
		provider: "stub",
		workflow: "none",
		numResults: 2,
	});
	// Not an unambiguous string array — keep it verbatim rather than silently
	// dropping the non-string member.
	assert.deepEqual(queries, ['["AGP version", 5]']);
});

test("web_search does not reinterpret already-structured queries entries", async () => {
	const home = await setupHome();
	const queries = capturedQueries(home, {
		queries: ['["AGP version", "Compose BOM"]'],
		provider: "stub",
		workflow: "none",
		numResults: 2,
	});
	// The plural `queries` field is already structured — expansion stays scoped
	// to the malformed singular `query` field.
	assert.deepEqual(queries, ['["AGP version", "Compose BOM"]']);
});

test("web_search reports the existing no-query error for empty JSON-array strings", async () => {
	const home = await setupHome();
	for (const query of ["[]", '["   "]']) {
		const { result, queries } = runWebSearch(home, {
			query,
			provider: "stub",
			workflow: "none",
			numResults: 2,
		});
		assert.deepEqual(queries, []);
		assert.equal(result.details.error, "No query provided");
		assert.equal(result.content[0].text, "Error: No query provided. Use 'query' or 'queries' parameter.");
	}
});
