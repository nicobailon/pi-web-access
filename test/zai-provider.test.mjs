import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { before, after, test } from "node:test";

const key = "synthetic-zai-credential";
const endpoints = {
	global: "https://api.z.ai/api/mcp/web_search_prime/mcp",
	china: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
};
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let home, server, origin, searchWithZai, isZaiAvailable;
let calls = [], requestedUrls = [], mode = "json";
const items = [
	{ refer: "ref_1", title: "First", link: "https://example.com/a", media: "Example", content: "First summary" },
	{ refer: "ref_2", title: "Not web", link: "javascript:alert(1)", content: "dropped" },
	{ refer: "ref_3", title: "Off domain", link: "https://example.org/x", content: "dropped by filter" },
	{ refer: "ref_4", title: "", link: "https://docs.example.com/b", content: "Second summary" },
	{ refer: "ref_5", title: "Third", link: "https://example.net/c", content: "Third summary" },
];

async function writeConfig(config) {
	await writeFile(join(home, "web-search.json"), JSON.stringify({ webSearch: { allowedProviders: ["zai"] }, ...config }));
}

before(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-web-zai-"));
	process.env.PI_CODING_AGENT_DIR = home;
	process.env.ZAI_API_KEY = key;
	await writeConfig({});
	server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const rpc = body ? JSON.parse(body) : null;
		calls.push({ method: req.method, rpc, authCorrect: req.headers.authorization === `Bearer ${key}` });
		if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end(`bad key ${key}`); return; }
		if (req.method === "GET") { res.writeHead(405); res.end(); return; }
		if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
		if (mode === "redirect") { res.writeHead(307, { location: "https://untrusted.example/mcp" }); res.end(); return; }
		if (rpc.method === "initialize") {
			res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "synthetic-session" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "synthetic-only", version: "1.0.0" } } }));
			return;
		}
		if (!rpc.id && rpc.id !== 0) { res.writeHead(202); res.end(); return; }
		const text = mode === "not-json" ? `quota exhausted for ${key}` : JSON.stringify(JSON.stringify(items));
		const result = mode === "tool-error" ? { content: [{ type: "text", text: `secret ${key}` }], isError: true } : { content: [{ type: "text", text }] };
		const reply = mode === "rpc-error" ? { error: { code: -32603, message: `internal ${key}` } } : { result };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...reply })}\n\n`);
	});
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	origin = `http://127.0.0.1:${server.address().port}/mcp`;
	globalThis.fetch = async (url, init) => {
		assert.ok(Object.values(endpoints).includes(String(url)), "unexpected external network request");
		assert.equal(init.redirect, "error");
		requestedUrls.push(String(url));
		return originalFetch(origin, init);
	};
	({ searchWithZai, isZaiAvailable } = await import("../zai.ts"));
});
after(async () => {
	globalThis.fetch = originalFetch;
	process.env = savedEnv;
	server?.closeAllConnections();
	await new Promise(resolve => server?.close(resolve));
	await rm(home, { recursive: true, force: true });
});
function reset(nextMode = "json") { calls = []; requestedUrls = []; mode = nextMode; }

test("Z.ai calls webSearchPrime with mapped filters and returns web results", async () => {
	reset();
	const result = await searchWithZai("  GLM news  ", { numResults: 2, recencyFilter: "week", domainFilter: ["https://example.com/path"] });
	assert.deepEqual(calls.filter(c => c.rpc).map(c => c.rpc.method), ["initialize", "notifications/initialized", "tools/call"]);
	assert.deepEqual(calls.find(c => c.rpc?.method === "tools/call").rpc.params, {
		name: "webSearchPrime",
		arguments: { search_query: "GLM news", search_recency_filter: "oneWeek", search_domain_filter: "example.com" },
	});
	assert.deepEqual(result.results, [
		{ title: "First", url: "https://example.com/a", snippet: "First summary" },
		{ title: "Source 2", url: "https://docs.example.com/b", snippet: "Second summary" },
	]);
	assert.match(result.answer, /First summary\nSource: First \(https:\/\/example\.com\/a\)/);
	assert.ok(calls.every(c => c.authCorrect));
	assert.equal(calls.at(-1).method, "DELETE");
	assert.ok(requestedUrls.every(url => url === endpoints.global));
});

test("zaiEndpoint selects the China endpoint and rejects unknown values", async () => {
	try {
		await writeConfig({ zaiEndpoint: "china" });
		reset();
		await searchWithZai("q");
		assert.ok(requestedUrls.length > 0 && requestedUrls.every(url => url === endpoints.china));

		await writeConfig({ zaiEndpoint: "https://attacker.example/mcp" });
		reset();
		await assert.rejects(searchWithZai("q"), /zaiEndpoint .* must be "global" or "china"/);
		assert.equal(calls.length, 0);
	} finally {
		await writeConfig({});
	}
});

test("Z.ai errors never disclose the key", async () => {
	for (const variant of ["tool-error", "not-json"]) {
		reset(variant);
		await assert.rejects(searchWithZai("q"), err => !String(err).includes(key) && /Z\.ai/.test(String(err)));
	}
	// Routing classifies errors by message text, so a generic failure must not read as quota.
	reset("rpc-error");
	await assert.rejects(searchWithZai("q"), err => !String(err).includes(key) && !/quota/i.test(String(err)));
	reset();
	process.env.ZAI_API_KEY = "wrong-synthetic";
	try {
		await assert.rejects(searchWithZai("q"), err => !String(err).includes(key) && /HTTP 401/.test(String(err)));
		assert.ok(!calls.some(c => c.rpc?.method === "tools/call"));
	} finally {
		process.env.ZAI_API_KEY = key;
	}
});

test("Z.ai rejects redirects without contacting a second origin", async () => {
	reset("redirect");
	await assert.rejects(searchWithZai("q"), /Z\.ai network request failed/);
	assert.equal(calls.length, 1);
});

test("Z.ai rejects unsupported filters, empty queries and missing keys before network", async () => {
	reset();
	await assert.rejects(searchWithZai("q", { domainFilter: ["a.com", "b.com"] }), /single included domain/);
	await assert.rejects(searchWithZai("q", { domainFilter: ["-a.com"] }), /single included domain/);
	await assert.rejects(searchWithZai("   "), /must not be empty/);
	delete process.env.ZAI_API_KEY;
	try {
		assert.equal(isZaiAvailable(), false);
		await assert.rejects(searchWithZai("q"), /Z\.ai API key not found/);
	} finally {
		process.env.ZAI_API_KEY = key;
	}
	assert.equal(calls.length, 0);
	assert.equal(isZaiAvailable(), true);
});
