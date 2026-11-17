import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const exaModuleUrl = new URL("../exa.ts", import.meta.url).href;

async function requestBodyFor(args) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-category-"));
	try {
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, EXA_API_KEY: "exa-category-key" };
		delete env.EXA_BASE_URL;
		delete env.XDG_CONFIG_HOME;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const requests = [];
				globalThis.fetch = async (url, init) => {
					requests.push({ url: String(url), body: JSON.parse(init.body) });
					return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } });
				};
				const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
				await searchWithExa(...${JSON.stringify(args)});
				console.log(JSON.stringify(requests));
			`,
			encoding: "utf8",
			env,
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("keyed Exa forwards category to /search when set, and omits it when unset", async () => {
	const [withCategory] = await requestBodyFor(["papers only", { category: "research paper" }]);
	assert.deepEqual(withCategory.body, {
		query: "papers only",
		type: "auto",
		numResults: 5,
		category: "research paper",
		contents: { highlights: true },
	});

	const [withoutCategory] = await requestBodyFor(["plain query"]);
	assert.deepEqual(withoutCategory.body, {
		query: "plain query",
		type: "auto",
		numResults: 5,
		contents: { highlights: true },
	});
});

async function keylessMcpRequestsFor(query, options, { advancedMissing = false } = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-exa-category-mcp-"));
	try {
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home };
		delete env.EXA_API_KEY;
		delete env.EXA_BASE_URL;
		delete env.XDG_CONFIG_HOME;
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const requests = [];
				globalThis.fetch = async (url, init) => {
					const body = JSON.parse(init.body);
					requests.push({ tool: body.params.name, arguments: body.params.arguments });
					if (${advancedMissing} && body.params.name === "web_search_advanced_exa") {
						return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool web_search_advanced_exa not found" } }), { status: 200 });
					}
					const text = body.params.name === "web_search_advanced_exa"
						? JSON.stringify({ results: [{ title: "Paper", url: "https://example.org/paper", highlights: ["finding"] }] })
						: "Title: Paper\\nURL: https://example.org/paper\\nText: finding\\n---";
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }), { status: 200 });
				};
				const { searchWithExa } = await import(${JSON.stringify(exaModuleUrl)});
				await searchWithExa(${JSON.stringify(query)}, ${JSON.stringify(options)});
				console.log(JSON.stringify(requests));
			`,
			encoding: "utf8",
			env,
		});
		assert.equal(child.status, 0, child.stderr);
		return JSON.parse(child.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("keyless Exa sends category to the advanced MCP tool and degrades it into the basic-tool query", async () => {
	const [advanced] = await keylessMcpRequestsFor("transformer scaling", { category: "research paper", objective: "Compare scaling laws" });
	assert.equal(advanced.tool, "web_search_advanced_exa");
	assert.equal(advanced.arguments.category, "research paper");
	assert.equal(advanced.arguments.query, "transformer scaling");
	assert.equal(Object.hasOwn(advanced.arguments, "objective"), false);

	const fallback = await keylessMcpRequestsFor("transformer scaling", { category: "research paper", objective: "Compare scaling laws" }, { advancedMissing: true });
	assert.deepEqual(fallback.map(request => request.tool), ["web_search_advanced_exa", "web_search_exa"]);
	assert.deepEqual(fallback[1].arguments, { query: "transformer scaling research paper", numResults: 5 });
});
