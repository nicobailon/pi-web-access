import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const storageUrl = new URL("../storage.ts", import.meta.url).href;

async function runScenario(maxInlineContentChars) {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-inline-content-"));
	if (maxInlineContentChars !== undefined) {
		await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ maxInlineContentChars }) + "\n", "utf8");
	}
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			import { clearResults } from ${JSON.stringify(storageUrl)};
			clearResults();
			globalThis.fetch = async () => new Response("A".repeat(40000) + "TAIL", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const fetchTool = tools.find(tool => tool.name === "fetch_content");
			const contentTool = tools.find(tool => tool.name === "get_search_content");
			const fetched = await fetchTool.execute("call", { url: "https://93.184.216.34/page" });
			const retrieved = await contentTool.execute("call", { responseId: fetched.details.responseId, urlIndex: 0 });
			const tail = await contentTool.execute("call", { responseId: fetched.details.responseId, urlIndex: 0, offset: 40000, limit: 4 });
			const rejected = await contentTool.execute("call", { responseId: fetched.details.responseId, urlIndex: 0, limit: ${maxInlineContentChars === undefined ? 30_001 : maxInlineContentChars + 1} });
			console.log(JSON.stringify({
				schemaMax: contentTool.parameters.properties.limit.maximum,
				fetchTruncated: fetched.details.truncated,
				fetchEndOffset: fetched.content.find(item => item.type === "text").text.indexOf("\\n\\n---"),
				retrievedChars: retrieved.details.returnedChars,
				retrievedNextOffset: retrieved.details.nextOffset,
				tail: tail.content[0].text.includes("TAIL"),
				rejectedMax: rejected.details.maxLimit,
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

test("inline content defaults to 30,000 characters", async () => {
	const result = await runScenario();
	assert.deepEqual(result, {
		schemaMax: 30_000,
		fetchTruncated: true,
		fetchEndOffset: 30_000,
		retrievedChars: 30_000,
		retrievedNextOffset: 30_000,
		tail: true,
		rejectedMax: 30_000,
	});
});

test("maxInlineContentChars applies to direct and stored content slices", async () => {
	const result = await runScenario(40_000);
	assert.deepEqual(result, {
		schemaMax: 40_000,
		fetchTruncated: true,
		fetchEndOffset: 40_000,
		retrievedChars: 40_000,
		retrievedNextOffset: 40_000,
		tail: true,
		rejectedMax: 40_000,
	});
});

test("stored content schema and execution keep one registered limit", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-inline-content-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ maxInlineContentChars: 40_000 }) + "\n", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			import { storeResult, clearResults } from ${JSON.stringify(storageUrl)};
			import { writeFile } from "node:fs/promises";
			import { join } from "node:path";
			clearResults();
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			await writeFile(join(process.env.PI_CODING_AGENT_DIR, "web-search.json"), JSON.stringify({ maxInlineContentChars: 20_000 }) + "\\n", "utf8");
			storeResult("stored", { id: "stored", type: "fetch", timestamp: Date.now(), urls: [{ url: "https://example.test", title: "Stored", content: "A".repeat(50_000), error: null }] });
			const contentTool = tools.find(tool => tool.name === "get_search_content");
			const rejected = await contentTool.execute("call", { responseId: "stored", urlIndex: 0, limit: 40_001 });
			console.log(JSON.stringify({ schemaMax: contentTool.parameters.properties.limit.maximum, rejectedMax: rejected.details.maxLimit }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { schemaMax: 40_000, rejectedMax: 40_000 });
});

test("the first fetch_content page never ends inside a surrogate pair", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-web-access-inline-content-"));
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ maxInlineContentChars: 1000 }) + "\n", "utf8");
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			import initializeExtension from ${JSON.stringify(indexUrl)};
			import { clearResults } from ${JSON.stringify(storageUrl)};
			clearResults();
			globalThis.fetch = async () => new Response("A".repeat(999) + "\\u{1F600}" + "B".repeat(2000), {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
			const tools = [];
			initializeExtension({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const fetchTool = tools.find(tool => tool.name === "fetch_content");
			const fetched = await fetchTool.execute("call", { url: "https://93.184.216.34/page" });
			const text = fetched.content.find(item => item.type === "text").text;
			console.log(JSON.stringify({
				wellFormed: text.isWellFormed(),
				nextOffset: Number(/offset: (\\d+) \\}\\) for the next slice/.exec(text)?.[1]),
			}));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: undefined },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { wellFormed: true, nextOffset: 999 });
});
