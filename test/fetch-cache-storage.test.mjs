import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalDateNow = Date.now;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-access-fetch-cache-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const { default: initializeExtension } = await import("../index.ts");
const {
	clearResults,
	deleteResult,
	getAllResults,
	getFetchCacheDir,
	getResult,
	pruneExpiredFetchCache,
	restoreFromSession,
	storeFetchedContentResult,
	storeResult,
} = await import("../storage.ts");

afterEach(() => {
	globalThis.fetch = originalFetch;
	Date.now = originalDateNow;
	clearResults();
});

after(() => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	rmSync(testAgentDir, { recursive: true, force: true });
});

async function useTempAgentDir() {
	rmSync(join(testAgentDir, "web-search-cache"), { recursive: true, force: true });
	return testAgentDir;
}

function registerTools() {
	const tools = [];
	const entries = [];
	initializeExtension({
		registerTool(tool) { tools.push(tool); },
		registerCommand() {},
		registerShortcut() {},
		on() {},
		appendEntry(type, data) { entries.push({ type, data }); },
	});
	return {
		entries,
		fetchTool: tools.find((tool) => tool.name === "fetch_content"),
		getContentTool: tools.find((tool) => tool.name === "get_search_content"),
	};
}

function restoreEntry(data) {
	restoreFromSession({
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: "web-search-results", data }],
		},
	});
}

function fetchedData(id, content = "cached content") {
	return {
		id,
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: `https://example.com/${id}`, title: id, content, error: null }],
	};
}

test("fetch_content stores full content in cache and writes a bounded session entry", async () => {
	await useTempAgentDir();
	const pageContent = "Cached page content. ".repeat(4_000);
	globalThis.fetch = async () => new Response(pageContent, { status: 200, headers: { "content-type": "text/plain" } });

	const { entries, fetchTool, getContentTool } = registerTools();
	assert.ok(fetchTool);
	assert.ok(getContentTool);

	const result = await fetchTool.execute("call", { url: "https://93.184.216.34/page" });
	const entry = entries.find((candidate) => candidate.type === "web-search-results");
	assert.ok(entry);
	assert.equal(entry.data.type, "fetch");
	assert.equal(entry.data.urls, undefined);
	assert.ok(entry.data.fetchCache?.key);
	assert.equal(entry.data.urlMetadata?.[0]?.contentLength, pageContent.length);

	const serialized = JSON.stringify(entry.data);
	assert.ok(serialized.length < 5_000, `session entry was ${serialized.length} chars`);
	assert.doesNotMatch(serialized, /Cached page content\. Cached page content\./);

	clearResults();
	restoreEntry(entry.data);
	const restored = await getContentTool.execute("call", {
		responseId: result.details.responseId,
		urlIndex: 0,
		offset: pageContent.length - 21,
		limit: 21,
	});
	assert.equal(restored.details.returnedChars, 21);
	assert.match(restored.content[0].text, /Cached page content\./);
});

test("legacy inline fetched session entries remain readable", async () => {
	await useTempAgentDir();
	const { getContentTool } = registerTools();
	assert.ok(getContentTool);
	const legacy = {
		id: "legacy-fetch",
		type: "fetch",
		timestamp: Date.now(),
		urls: [{ url: "https://example.com/legacy", title: "Legacy", content: "legacy inline content", error: null }],
	};

	restoreEntry(legacy);
	const result = await getContentTool.execute("call", { responseId: "legacy-fetch", urlIndex: 0 });
	assert.match(result.content[0].text, /legacy inline content/);
	assert.equal(result.details.contentLength, "legacy inline content".length);
});

test("loaded cached fetched content expires after the result lifetime", async () => {
	const startedAt = originalDateNow();
	Date.now = () => startedAt;
	await useTempAgentDir();
	const pageContent = "expiring cache-backed content";
	globalThis.fetch = async () => new Response(pageContent, { status: 200, headers: { "content-type": "text/plain" } });

	const { entries, fetchTool, getContentTool } = registerTools();
	assert.ok(fetchTool);
	assert.ok(getContentTool);
	const result = await fetchTool.execute("call", { url: "https://93.184.216.34/expiring-cache" });
	const entry = entries.find((candidate) => candidate.type === "web-search-results");
	assert.ok(entry?.data.fetchCache?.key);

	clearResults();
	restoreEntry(entry.data);
	const loaded = await getContentTool.execute("call", { responseId: result.details.responseId, urlIndex: 0 });
	assert.match(loaded.content[0].text, /expiring cache-backed content/);

	Date.now = () => startedAt + 60 * 60 * 1000;
	const expired = await getContentTool.execute("call", { responseId: result.details.responseId, urlIndex: 0 });
	assert.equal(expired.details.error, "Cached fetched content is missing or expired");
	assert.match(expired.content[0].text, /Cached fetched content is missing or expired/);
	assert.doesNotMatch(expired.content[0].text, /expiring cache-backed content/);
});

test("missing cache files return an actionable fetched-content error", async () => {
	const agentDir = await useTempAgentDir();
	const pageContent = "cache-backed content";
	globalThis.fetch = async () => new Response(pageContent, { status: 200, headers: { "content-type": "text/plain" } });

	const { entries, fetchTool, getContentTool } = registerTools();
	assert.ok(fetchTool);
	assert.ok(getContentTool);
	const result = await fetchTool.execute("call", { url: "https://93.184.216.34/missing-cache" });
	const entry = entries.find((candidate) => candidate.type === "web-search-results");
	assert.ok(entry?.data.fetchCache?.key);
	rmSync(join(getFetchCacheDir(), entry.data.fetchCache.key), { force: true });

	clearResults();
	restoreEntry(entry.data);
	const missing = await getContentTool.execute("call", { responseId: result.details.responseId, urlIndex: 0 });
	assert.equal(missing.details.error, "Cached fetched content is missing or expired");
	assert.match(missing.content[0].text, /Cached fetched content is missing or expired/);
});

test("cache pruning reclaims expired in-memory fetch payloads without changing the retrieval window or history", async () => {
	await useTempAgentDir();
	const startedAt = originalDateNow();
	const ttl = 60 * 60 * 1000;
	Date.now = () => startedAt;
	const sessionEntry = storeFetchedContentResult("expired", fetchedData("expired", "expired payload"));
	const sessionSnapshot = JSON.stringify(sessionEntry);
	const cachePath = join(getFetchCacheDir(), sessionEntry.fetchCache.key);
	utimesSync(cachePath, new Date(startedAt), new Date(startedAt));
	const search = { id: "search", type: "search", timestamp: startedAt, queries: [] };
	const research = { id: "research", type: "research", timestamp: startedAt, artifact: { answer: "keep" } };
	storeResult(search.id, search);
	storeResult(research.id, research);

	Date.now = () => startedAt + ttl - 1;
	pruneExpiredFetchCache();
	assert.equal(getAllResults().find((data) => data.id === "expired").urls[0].content, "expired payload");
	assert.equal(getResult("expired").urls[0].content, "expired payload");
	assert.ok(readdirSync(getFetchCacheDir()).includes(sessionEntry.fetchCache.key));
	storeFetchedContentResult("fresh", fetchedData("fresh", "fresh payload"));

	Date.now = () => startedAt + ttl;
	pruneExpiredFetchCache();
	assert.equal(readdirSync(getFetchCacheDir()).includes(sessionEntry.fetchCache.key), false);
	// Inspect the map before getResult can lazily expire the payload itself.
	const results = getAllResults();
	assert.equal(results.length, 4);
	const expired = results.find((data) => data.id === "expired");
	assert.equal(expired.urls[0].content, "");
	assert.equal(expired.urls[0].error, "Cached fetched content is missing or expired");
	assert.deepEqual(expired.urlMetadata, sessionEntry.urlMetadata);
	assert.equal(results.find((data) => data.id === "fresh").urls[0].content, "fresh payload");
	assert.equal(results.find((data) => data.id === "search"), search);
	assert.equal(results.find((data) => data.id === "research"), research);
	assert.equal(JSON.stringify(sessionEntry), sessionSnapshot);
	assert.equal(getResult("expired").urls[0].error, "Cached fetched content is missing or expired");
});

test("storing a later fetch reclaims expired in-memory payloads before retrieval", async () => {
	await useTempAgentDir();
	const startedAt = originalDateNow();
	const ttl = 60 * 60 * 1000;
	Date.now = () => startedAt;
	storeFetchedContentResult("earlier", fetchedData("earlier", "earlier payload"));

	Date.now = () => startedAt + ttl;
	storeFetchedContentResult("later", fetchedData("later", "later payload"));
	const results = getAllResults();
	assert.equal(results.find((data) => data.id === "earlier").urls[0].content, "");
	assert.equal(results.find((data) => data.id === "later").urls[0].content, "later payload");
});

test("cache pruning reclaims expired inline payloads even without a disk cache", async () => {
	await useTempAgentDir();
	const startedAt = originalDateNow();
	Date.now = () => startedAt;
	const legacy = fetchedData("legacy", "legacy payload");
	restoreEntry(legacy);
	// An invalid cache id exercises the in-memory fallback after a cache write failure.
	const failed = storeFetchedContentResult("failed/id", fetchedData("failed/id", "fallback payload"));
	assert.ok(failed.fetchCacheError);
	rmSync(getFetchCacheDir(), { recursive: true, force: true });

	pruneExpiredFetchCache(startedAt + 60 * 60 * 1000 - 1);
	assert.deepEqual(getAllResults().map((data) => data.urls[0].content), ["legacy payload", "fallback payload"]);
	pruneExpiredFetchCache(startedAt + 60 * 60 * 1000);
	assert.deepEqual(getAllResults().map((data) => data.urls[0].content), ["", ""]);
	assert.ok(getAllResults().every((data) => data.urls[0].error === "Cached fetched content is missing or expired"));
	assert.equal(legacy.urls[0].content, "legacy payload");
});

test("cache pruning evicts the oldest entries by count and bytes", async () => {
	await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const now = Date.now();
	for (const [name, content, ageSeconds] of [
		["oldest.json", "1111", 30],
		["middle.json", "222222", 20],
		["newest.json", "33333333", 10],
	]) {
		const path = join(cacheDir, name);
		writeFileSync(path, content);
		utimesSync(path, new Date(now - ageSeconds * 1000), new Date(now - ageSeconds * 1000));
	}

	pruneExpiredFetchCache(now, { maxEntries: 2, maxBytes: 1024 });
	assert.deepEqual(readdirSync(cacheDir).sort(), ["middle.json", "newest.json"]);

	pruneExpiredFetchCache(now, { maxEntries: 10, maxBytes: 8 });
	assert.deepEqual(readdirSync(cacheDir), ["newest.json"]);
	assert.throws(() => pruneExpiredFetchCache(now, { maxEntries: 0 }), /finite positive integers/);
	assert.throws(() => pruneExpiredFetchCache(now, { maxBytes: Infinity }), /finite positive integers/);
});

test("default cache pruning keeps the newest 128 entries", async () => {
	await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const now = Date.now();
	for (let index = 0; index < 129; index++) {
		const path = join(cacheDir, `entry-${index.toString().padStart(3, "0")}.json`);
		writeFileSync(path, "{}");
		const modified = new Date(now - (129 - index) * 1000);
		utimesSync(path, modified, modified);
	}

	pruneExpiredFetchCache(now);
	const remaining = readdirSync(cacheDir).sort();
	assert.equal(remaining.length, 128);
	assert.equal(remaining.includes("entry-000.json"), false);
	assert.equal(remaining.includes("entry-128.json"), true);
});

test("default cache pruning enforces the 128 MiB byte limit", async () => {
	await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const now = Date.now();
	for (const [name, ageSeconds] of [["older.json", 20], ["newer.json", 10]]) {
		const path = join(cacheDir, name);
		writeFileSync(path, "");
		truncateSync(path, 65 * 1024 * 1024);
		const modified = new Date(now - ageSeconds * 1000);
		utimesSync(path, modified, modified);
	}

	pruneExpiredFetchCache(now);
	assert.deepEqual(readdirSync(cacheDir), ["newer.json"]);
});

test("cache pruning removes only stale owned temp files", async () => {
	await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const now = Date.now();
	const stale = ["old.json.123.456.tmp", `new.json.123.456.${"a".repeat(32)}.tmp`];
	const fresh = `fresh.json.123.456.${"b".repeat(32)}.tmp`;
	const preserved = ["foreign.tmp", "old.json.not-ours.tmp", fresh];
	for (const name of [...stale, ...preserved]) {
		const path = join(cacheDir, name);
		writeFileSync(path, name);
		if (name !== fresh) utimesSync(path, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
	}

	pruneExpiredFetchCache(now);
	assert.deepEqual(readdirSync(cacheDir).sort(), preserved.sort());
});

test("cache pruning corrects directory and entry permissions", { skip: process.platform === "win32" }, async () => {
	await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const entryPath = join(cacheDir, "permissions.json");
	writeFileSync(entryPath, "{}");
	chmodSync(cacheDir, 0o777);
	chmodSync(entryPath, 0o666);

	pruneExpiredFetchCache();
	assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
	assert.equal(statSync(entryPath).mode & 0o777, 0o600);
});

test("cache write and rename failures degrade without leaving temp files", async () => {
	await useTempAgentDir();
	const unwritable = fetchedData("unwritable");
	unwritable.circular = unwritable;
	const failed = storeFetchedContentResult("unwritable", unwritable);
	assert.equal(failed.fetchCache, undefined);
	assert.match(failed.fetchCacheError, /circular/i);
	assert.equal(readdirSync(dirname(getFetchCacheDir())).includes("web-search-cache"), false);

	const written = storeFetchedContentResult("normal", fetchedData("normal"));
	assert.ok(written.fetchCache);
	mkdirSync(join(getFetchCacheDir(), "blocked.json"));
	const blocked = storeFetchedContentResult("blocked", fetchedData("blocked"));
	assert.equal(blocked.fetchCache, undefined);
	assert.equal(readdirSync(getFetchCacheDir()).some((name) => name.endsWith(".tmp")), false);
});

test("corrupt cache files remain unavailable without throwing", async () => {
	await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(join(cacheDir, "corrupt.json"), "not json");
	restoreEntry({
		id: "corrupt",
		type: "fetch",
		timestamp: Date.now(),
		fetchCache: { version: 1, key: "corrupt.json", storedAt: Date.now() },
		urlMetadata: [{ url: "https://example.com/corrupt", title: "corrupt", error: null, contentLength: 8 }],
	});

	const restored = getResult("corrupt");
	assert.equal(restored.urls[0].content, "");
	assert.match(restored.urls[0].error, /could not be read/);
});

test("cache file symlinks are not followed", { skip: process.platform === "win32" }, async () => {
	const agentDir = await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	mkdirSync(cacheDir, { recursive: true });
	const target = join(agentDir, "outside.json");
	writeFileSync(target, JSON.stringify(fetchedData("linked")));
	symlinkSync(target, join(cacheDir, "linked.json"));
	restoreEntry({
		id: "linked",
		type: "fetch",
		timestamp: Date.now(),
		fetchCache: { version: 1, key: "linked.json", storedAt: Date.now() },
		urlMetadata: [{ url: "https://example.com/linked", title: "linked", error: null, contentLength: 14 }],
	});

	const restored = getResult("linked");
	assert.equal(restored.urls[0].content, "");
	assert.match(restored.urls[0].error, /not a regular file/);
	assert.match(readFileSync(target, "utf8"), /cached content/);
});

test("cache directory symlinks are rejected for writes and deletes", { skip: process.platform === "win32" }, async () => {
	const agentDir = await useTempAgentDir();
	const cacheDir = getFetchCacheDir();
	const outside = join(agentDir, "outside-cache");
	mkdirSync(dirname(cacheDir), { recursive: true });
	mkdirSync(outside);
	symlinkSync(outside, cacheDir);

	const rejected = storeFetchedContentResult("dir-link", fetchedData("dir-link"));
	assert.equal(rejected.fetchCache, undefined);
	assert.match(rejected.fetchCacheError, /not a safe directory/);
	assert.deepEqual(readdirSync(outside), []);

	unlinkSync(cacheDir);
	const stored = storeFetchedContentResult("delete-link", fetchedData("delete-link"));
	assert.ok(stored.fetchCache);
	rmSync(cacheDir, { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, stored.fetchCache.key), "outside");
	symlinkSync(outside, cacheDir);
	assert.equal(deleteResult("delete-link"), true);
	assert.equal(readFileSync(join(outside, stored.fetchCache.key), "utf8"), "outside");
});
