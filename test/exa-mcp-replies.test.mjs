import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchUrl = new URL("../gemini-search.ts", import.meta.url).href;

// Captured from https://mcp.exa.ai/mcp without a key after a few calls in a row (issue #638).
const rateLimitedBody = `event: message\ndata: ${JSON.stringify({
	result: {
		_meta: { "ai.exa/rateLimited": true },
		content: [{ type: "text", text: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY" }],
	},
	jsonrpc: "2.0",
	id: 1,
})}\n`;

function mcpBody(text) {
	return `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id: 1 })}\n`;
}

const onlyExa = { webSearch: { allowedProviders: ["exa"] } };

// Keyless search where every Exa MCP call gets `body`; Brave (keyed) answers with one result.
function exaSearch(body, { config = onlyExa, options = {} } = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-exa-mcp-"));
	writeFileSync(join(home, "web-search.json"), JSON.stringify(config));
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home"), BRAVE_API_KEY: "brave-test-key" };
	delete env.EXA_API_KEY;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const calls = [];
			globalThis.fetch = async (url) => {
				const target = String(url);
				calls.push(target.includes("mcp.exa.ai") ? new URL(target).searchParams.get("tools") : "brave");
				return target.includes("mcp.exa.ai")
					? new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "text/event-stream" } })
					: new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://example.com/b", description: "brave" }] } }), { status: 200 });
			};
			const { search } = await import(${JSON.stringify(searchUrl)});
			try {
				const response = await search("q", { provider: "auto", ...${JSON.stringify(options)} });
				console.log(JSON.stringify({ response, calls }));
			} catch (error) {
				console.log(JSON.stringify({ error: String(error), calls }));
			}
		`,
		encoding: "utf8",
		env,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

const unreadableBody = mcpBody("Something unexpected happened");

test("a rate-limited Exa MCP reply is reported as an Exa rate limit, not as no provider configured", () => {
	const { error } = exaSearch(rateLimitedBody);
	assert.match(error, /Exa: Exa's free MCP search hit its rate limit\. Add "exaApiKey"/);
	assert.doesNotMatch(error, /No search provider available/);
});

test("an Exa MCP reply without results is reported with what Exa sent", () => {
	const { error } = exaSearch(unreadableBody);
	assert.match(error, /Exa: Exa MCP returned no parseable results: Something unexpected happened/);
});

test("search routing moves past a rate-limited or unreadable Exa MCP reply on quota or invalid-response", () => {
	for (const [body, kind] of [[rateLimitedBody, "quota"], [unreadableBody, "invalid-response"]]) {
		const { response } = exaSearch(body, { config: { searchRouting: { providers: ["exa", "brave"], fallbackOn: [kind] } } });
		assert.equal(response?.provider, "brave", kind);
	}
});

test("an unreadable filtered Exa MCP reply is not retried without the filters", () => {
	const { error, calls } = exaSearch(unreadableBody, { options: { domainFilter: ["example.com"] } });
	assert.match(error, /Exa MCP returned no parseable results/);
	assert.deepEqual(calls, ["web_search_advanced_exa"]);
});

test("an Exa MCP reply with zero results is an empty result, not an error", () => {
	const { response } = exaSearch(mcpBody(JSON.stringify({ results: [] })), { options: { domainFilter: ["example.com"] } });
	assert.deepEqual({ provider: response.provider, results: response.results }, { provider: "exa", results: [] });
});
