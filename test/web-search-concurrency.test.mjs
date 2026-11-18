import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;

test("web_search bounds batch concurrency and preserves query order", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-concurrency-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({
		customSearchProviders: {
			stub: { url: "https://search.example.com/serp", method: "POST", body: { q: "{query}" }, results: "organic_results", fields: { title: "title", url: "link", snippet: "snippet" } },
		},
		autoOpenBrowser: false,
		curatorTimeoutSeconds: 1,
	}) + "\n", "utf8");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: home };
	for (const key of [
		"OPENAI_API_KEY", "BRAVE_API_KEY", "PARALLEL_API_KEY", "TINYFISH_API_KEY",
		"TAVILY_API_KEY", "JINA_API_KEY", "EXA_API_KEY", "PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			let active = 0;
			let maxActive = 0;
			let started = [];
			let completed = [];
			const delays = new Map([["q1", 90], ["q2", 70], ["q3", 50], ["q4", 30], ["q5", 10]]);
			globalThis.fetch = async (_url, init) => {
				const query = JSON.parse(init.body).q;
				started.push(query);
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise(resolve => setTimeout(resolve, delays.get(query)));
				active--;
				completed.push(query);
				return new Response(JSON.stringify({
					organic_results: [{ position: 1, title: query, link: "https://example.com/" + query, snippet: query }],
				}), { status: 200 });
			};
			const tools = [];
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			initializeExtension({
				registerTool(tool) { tools.push(tool); },
				registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {}, sendMessage() {},
			});
			const webSearch = tools.find(tool => tool.name === "web_search");
			const updates = [];
			const rawResult = await webSearch.execute(
				"concurrency-test",
				{ queries: ["q1", "q2", "q3", "q4", "q5"], provider: "stub", workflow: "none" },
				undefined,
				update => updates.push(update.details),
			);
			const raw = { maxActive, started, completed, updates, text: rawResult.content[0].text };

			active = 0;
			maxActive = 0;
			started = [];
			completed = [];
			const curatedResult = await webSearch.execute(
				"curator-concurrency-test",
				{ queries: ["q1", "q2", "q3", "q4", "q5"], provider: "stub", workflow: "summary-review" },
				undefined,
				undefined,
				{
					hasUI: true,
					model: undefined,
					modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
					cwd: process.cwd(),
					isProjectTrusted() { return true; },
					ui: { notify() {} },
				},
			);
			const curated = {
				maxActive,
				started,
				completed,
				queries: curatedResult.details.curatedQueries.map(entry => entry.query),
			};
			const queriesDescription = webSearch.parameters.properties.queries.description;
			console.log(JSON.stringify({ raw, curated, queriesDescription }));
		`,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});

	assert.equal(child.status, 0, child.stderr);
	const { raw, curated, queriesDescription } = JSON.parse(child.stdout.trim());
	assert.equal(raw.maxActive, 3);
	assert.deepEqual(raw.started, ["q1", "q2", "q3", "q4", "q5"]);
	assert.notDeepEqual(raw.completed, raw.started);
	let previous = -1;
	for (const query of raw.started) {
		const position = raw.text.indexOf(`## Query: "${query}"`);
		assert.ok(position > previous, `${query} was returned out of order`);
		previous = position;
	}
	assert.equal(raw.updates.at(-1).progress, 1);
	assert.equal(curated.maxActive, 3);
	assert.deepEqual(curated.started, raw.started);
	assert.notDeepEqual(curated.completed, curated.started);
	assert.deepEqual(curated.queries, raw.started);
	assert.match(queriesDescription, /concurrently \(up to three at a time\)/);
});
