import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, test } from "node:test";

import initializeExtension from "../index.ts";
import { clearResults, getResult } from "../storage.ts";

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

// A host that serves several conversations at once (an app or chat server built on the SDK)
// runs one extension instance per session, in one process. Each instance's session events
// must touch only its own results.
const started = [];
afterEach(async () => {
	// Every test ends every session it started, so the module's live-instance set is empty again.
	for (const instance of started.splice(0)) await instance.emit("session_shutdown");
	clearResults();
});

function startInstance(entries = []) {
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	initializeExtension({
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerShortcut() {},
		on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
	});
	const ctx = {
		hasUI: false,
		model: undefined,
		modelRegistry: {},
		scopedModels: [],
		sessionManager: { getBranch: () => entries },
		// `/search` picks the first stored result, then Delete.
		ui: { setWidget() {}, notify() {}, select: async (title, choices) => (title.startsWith("Result ") ? "Delete" : choices[0]) },
	};
	const emit = async (event) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
	};
	const call = (name, params) => tools.get(name).execute(`${name}-call`, params, undefined, undefined, ctx);
	const deleteFirstResult = () => commands.get("search").handler("", ctx);
	const instance = { emit, call, deleteFirstResult, entries };
	started.push(instance);
	return instance;
}

function servePage(text) {
	globalThis.fetch = async () => new Response(
		`<!doctype html><html><head><title>Page</title></head><body><article><h1>Page</h1><p>${text}</p></article></body></html>`,
		{ status: 200, headers: { "content-type": "text/html" } },
	);
}

const retrieve = async (instance, responseId) =>
	(await instance.call("get_search_content", { responseId, urlIndex: 0 })).content[0].text;

test("one session starting or ending leaves another session's stored results in place", async () => {
	servePage("Alpha content. ".repeat(80));
	const a = startInstance();
	await a.emit("session_start");
	const responseId = (await a.call("fetch_content", { url: "https://93.184.216.34/alpha" })).details.responseId;
	assert.ok(responseId);

	// Another conversation starts and ends while the first is mid-turn.
	const b = startInstance();
	await b.emit("session_start");
	await b.emit("session_shutdown");

	const text = await retrieve(a, responseId);
	assert.doesNotMatch(text, /No stored results/);
	assert.match(text, /Alpha content/);
});

test("a session's end releases only its own results, and its journal restores them", async () => {
	servePage("Beta content. ".repeat(80));
	const a = startInstance();
	const b = startInstance();
	await a.emit("session_start");
	await b.emit("session_start");
	const fromA = (await a.call("fetch_content", { url: "https://93.184.216.34/a" })).details.responseId;
	const fromB = (await b.call("fetch_content", { url: "https://93.184.216.34/b" })).details.responseId;

	await a.emit("session_shutdown");
	assert.equal(getResult(fromA), null);
	assert.ok(getResult(fromB));

	// The next turn of the first conversation is a new instance over the same journal.
	const again = startInstance([...a.entries]);
	await again.emit("session_start");
	assert.match(await retrieve(again, fromA), /Beta content/);
});

test("sessions forked from one history each keep the results they share", async () => {
	servePage("Shared content. ".repeat(80));
	const room = startInstance();
	await room.emit("session_start");
	const shared = (await room.call("fetch_content", { url: "https://93.184.216.34/shared" })).details.responseId;

	// A thread forked from the room carries the room's journal, so both hold the same id.
	const thread = startInstance([...room.entries]);
	await thread.emit("session_start");
	await thread.emit("session_shutdown");
	assert.match(await retrieve(room, shared), /Shared content/);

	await room.emit("session_shutdown");
	assert.equal(getResult(shared), null);
});

test("a session forked from history keeps the live session's fetched content when the disk cache is gone", async (t) => {
	const cacheRoot = await mkdtemp(join(tmpdir(), "pi-web-access-fork-cache-"));
	process.env.PI_WEB_ACCESS_CACHE_ROOT = cacheRoot;
	t.after(async () => {
		delete process.env.PI_WEB_ACCESS_CACHE_ROOT;
		await rm(cacheRoot, { recursive: true, force: true });
	});
	servePage("Live content. ".repeat(80));
	const room = startInstance();
	await room.emit("session_start");
	const shared = (await room.call("fetch_content", { url: "https://93.184.216.34/live" })).details.responseId;
	// The cache file is pruned (or was never written) while the room still holds the content.
	await rm(join(cacheRoot, "web-search-cache"), { recursive: true, force: true });

	const thread = startInstance([...room.entries]);
	await thread.emit("session_start");
	assert.match(await retrieve(room, shared), /Live content/);
	assert.match(await retrieve(thread, shared), /Live content/);
});

test("deleting a shared result in one session leaves it with the other sessions holding it", async () => {
	servePage("Kept content. ".repeat(80));
	const room = startInstance();
	await room.emit("session_start");
	const shared = (await room.call("fetch_content", { url: "https://93.184.216.34/kept" })).details.responseId;
	const thread = startInstance([...room.entries]);
	await thread.emit("session_start");

	await room.deleteFirstResult();
	assert.match(await retrieve(thread, shared), /Kept content/);

	// A later session over the same history, then the thread ending, must not drop it.
	const later = startInstance([...room.entries]);
	await later.emit("session_start");
	await thread.emit("session_shutdown");
	assert.match(await retrieve(later, shared), /Kept content/);
});

test("a session forked from history keeps the clones its results point at after the original session ends", { skip: process.platform === "win32" }, async () => {
	// Cloning runs a real child process, so the scenario runs in a child Node with a fake `git` on PATH.
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-forked-clone-"));
	const agentDir = join(root, "agent-dir");
	const binDir = join(root, "bin");
	await mkdir(agentDir, { recursive: true });
	await mkdir(binDir, { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ githubClone: { clonePath: join(root, "repos") } }), "utf8");
	const fake = async (name, source) => writeFile(join(binDir, name), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
	await fake("gh", "process.exit(1);");
	await fake("git", `
		const { mkdirSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const destination = process.argv.at(-1);
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "README.md"), "fixture");
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { existsSync } = await import("node:fs");
			const { default: initializeExtension } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
			const start = (entries) => {
				const tools = new Map();
				const handlers = new Map();
				initializeExtension({
					registerTool(tool) { tools.set(tool.name, tool); },
					registerCommand() {},
					registerShortcut() {},
					on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
					appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
				});
				const ctx = { hasUI: false, model: undefined, modelRegistry: {}, scopedModels: [], sessionManager: { getBranch: () => entries }, ui: { setWidget() {}, notify() {} } };
				const emit = async (event) => { for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx); };
				return { emit, entries, call: (name, params) => tools.get(name).execute(name, params, undefined, undefined, ctx) };
			};
			const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
			const a = start([]);
			await a.emit("session_start");
			const fetched = await a.call("fetch_content", { url: "https://github.com/owner/repo", forceClone: true });
			const path = fetched.content[0].text.match(/Repository cloned to: (.+)/)?.[1] ?? null;
			await sleep(5);
			// B is forked from A's history after the clone was last fetched.
			const b = start([...a.entries]);
			await b.emit("session_start");
			await a.emit("session_shutdown");
			const keptForB = path !== null && existsSync(path);
			await b.emit("session_shutdown");
			console.log(JSON.stringify({ path, keptForB, removedAfterLast: path !== null && !existsSync(path) }));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.trim().split("\n").at(-1));
	assert.ok(result.path, "fetch_content returned no clone path");
	assert.equal(result.keptForB, true);
	assert.equal(result.removedAfterLast, true);
});
