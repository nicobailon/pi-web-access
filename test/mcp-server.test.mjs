import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../mcp-server.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const TOOL_NAMES = ["fetch_content", "get_search_content", "source_check", "web_search"];

function fakeCore(overrides = {}) {
	const calls = [];
	const record = (method) => async (params, signal) => {
		calls.push({ method, params, signal });
		if (overrides[method]) return overrides[method](params, signal);
		return { content: [{ type: "text", text: `${method} ok` }], details: { method } };
	};
	return {
		calls,
		core: {
			webSearch: record("webSearch"),
			fetchContent: record("fetchContent"),
			getSearchContent: record("getSearchContent"),
			sourceCheck: record("sourceCheck"),
		},
	};
}

async function connect(core) {
	const server = createMcpServer(core, { name: "pi-web-access-test", version: "0.0.0" });
	const client = new Client({ name: "test-client", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, close: async () => { await client.close(); await server.close(); } };
}

test("tools/list exposes the four MCP tools with standalone-only input schemas", async () => {
	const { client, close } = await connect(fakeCore().core);
	try {
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
		for (const tool of tools) {
			assert.equal(tool.inputSchema.type, "object", tool.name);
			assert.ok(tool.description.length > 0, tool.name);
		}
		const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
		assert.deepEqual(byName.fetch_content.properties.mode.enum, ["readable", "raw"]);
		for (const piOnly of ["prompt", "answerModel", "timestamp", "frames", "model", "auth"]) {
			assert.equal(byName.fetch_content.properties[piOnly], undefined, `fetch_content exposes ${piOnly}`);
		}
		assert.equal(byName.web_search.properties.workflow, undefined);
		assert.deepEqual(byName.get_search_content.required, ["responseId"]);
		assert.deepEqual(byName.source_check.required, ["claim"]);
	} finally {
		await close();
	}
});

test("a valid call reaches the core with its arguments and returns the core's content", async () => {
	const image = { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" };
	const { core, calls } = fakeCore({
		webSearch: async () => ({
			content: [{ type: "text", text: "results for a, b" }, image],
			details: { responseId: "search-1", queryCount: 2 },
		}),
	});
	const { client, close } = await connect(core);
	try {
		const args = { queries: ["a", "b"], numResults: 3, provider: ["brave", "exa"], recencyFilter: "week" };
		const result = await client.callTool({ name: "web_search", arguments: args });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].method, "webSearch");
		assert.deepEqual(calls[0].params, args);
		assert.deepEqual(result.content, [{ type: "text", text: "results for a, b" }, image]);
		assert.deepEqual(result.structuredContent, { responseId: "search-1", queryCount: 2 });
		assert.notEqual(result.isError, true);

		await client.callTool({ name: "get_search_content", arguments: { responseId: "search-1", findText: ["x"] } });
		assert.equal(calls[1].method, "getSearchContent");
		assert.deepEqual(calls[1].params, { responseId: "search-1", findText: ["x"] });
	} finally {
		await close();
	}
});

test("invalid arguments return a tool error naming the problem without calling the core", async () => {
	const { core, calls } = fakeCore();
	const { client, close } = await connect(core);
	try {
		const cases = [
			["web_search", { query: "q", numResults: 0 }, "/numResults"],
			["web_search", { query: "q", workflow: "summary-review" }, "workflow"],
			["fetch_content", { url: "https://example.com", mode: "answer" }, "/mode"],
			["fetch_content", { url: "https://example.com", prompt: "summarize" }, "prompt"],
			["get_search_content", { offset: 1 }, "responseId"],
			["source_check", { claim: 42 }, "/claim"],
		];
		for (const [name, args, mention] of cases) {
			const result = await client.callTool({ name, arguments: args });
			assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
			assert.match(result.content[0].text, new RegExp(`Invalid arguments for ${name}`));
			assert.ok(result.content[0].text.includes(mention), `${result.content[0].text} should mention ${mention}`);
		}
		assert.equal(calls.length, 0);
	} finally {
		await close();
	}
});

test("core failures become tool errors and core error results keep isError", async () => {
	const { core } = fakeCore({
		fetchContent: async () => { throw new Error("Blocked by fetch domain policy"); },
		sourceCheck: async () => ({ content: [{ type: "text", text: "No provider configured" }], details: {}, isError: true }),
	});
	const { client, close } = await connect(core);
	try {
		const thrown = await client.callTool({ name: "fetch_content", arguments: { url: "https://example.com" } });
		assert.equal(thrown.isError, true);
		assert.deepEqual(thrown.content, [{ type: "text", text: "Blocked by fetch domain policy" }]);

		const failed = await client.callTool({ name: "source_check", arguments: { claim: "c" } });
		assert.equal(failed.isError, true);
		assert.deepEqual(failed.content, [{ type: "text", text: "No provider configured" }]);
	} finally {
		await close();
	}
});

test("unknown tools are rejected as protocol errors", async () => {
	const { core, calls } = fakeCore();
	const { client, close } = await connect(core);
	try {
		await assert.rejects(client.callTool({ name: "code_search", arguments: {} }), (error) => {
			assert.equal(error.code, -32602);
			assert.match(error.message, /Unknown tool: code_search/);
			return true;
		});
		assert.equal(calls.length, 0);
	} finally {
		await close();
	}
});

test("client cancellation aborts the signal passed to the core", { timeout: 5_000 }, async () => {
	let started;
	const startedPromise = new Promise((resolve) => { started = resolve; });
	let observed;
	const abortedPromise = new Promise((resolve) => { observed = resolve; });
	const { core } = fakeCore({
		webSearch: (_params, signal) => new Promise(() => {
			signal.addEventListener("abort", () => observed(signal.aborted), { once: true });
			started(signal.aborted);
		}),
	});
	const { client, close } = await connect(core);
	try {
		const controller = new AbortController();
		const call = client.callTool({ name: "web_search", arguments: { query: "slow" } }, undefined, { signal: controller.signal });
		assert.equal(await startedPromise, false);
		controller.abort("user cancelled");
		await assert.rejects(call);
		assert.equal(await abortedPromise, true);
	} finally {
		await close();
	}
});

// Runs the built bin from a directory whose node_modules mirrors the repo's
// without typebox, proving the bundle carries typebox and needs no peers from pi.
test("built pi-web-access-mcp bin serves tools/list over stdio with JSON-RPC-only stdout", { timeout: 30_000 }, async () => {
	const build = spawnSync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf8", shell: process.platform === "win32" });
	assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);

	const dir = await mkdtemp(join(tmpdir(), "pi-web-access-mcp-bin-"));
	try {
		await writeFile(join(dir, "package.json"), JSON.stringify({ type: "module" }));
		await copyFile(join(repoRoot, "dist", "mcp-cli.js"), join(dir, "mcp-cli.js"));
		const modules = join(dir, "node_modules");
		await mkdir(modules);
		for (const entry of await readdir(join(repoRoot, "node_modules"))) {
			if (entry === "typebox" || entry.startsWith(".")) continue;
			await symlink(join(repoRoot, "node_modules", entry), join(modules, entry));
		}

		const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, "mcp-cli.js")], cwd: dir, stderr: "pipe" });
		const transportErrors = [];
		let stderr = "";
		transport.stderr.on("data", (chunk) => { stderr += chunk; });
		const client = new Client({ name: "stdio-smoke", version: "0.0.0" });
		client.onerror = (error) => transportErrors.push(error);
		await client.connect(transport);
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
		assert.equal(client.getServerVersion().name, "pi-web-access");

		const closeStarted = Date.now();
		await client.close();
		// StdioClientTransport sends SIGTERM only if the child is still running 2s after stdin ends.
		assert.ok(Date.now() - closeStarted < 1900, "server did not exit when stdin closed");
		// Any non-JSON-RPC stdout line would surface as a transport parse error.
		assert.deepEqual(transportErrors, [], stderr);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
