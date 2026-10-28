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

// Keyless auto search with only Exa allowed, so the free MCP endpoint is the one provider tried.
function autoSearch(body, options = {}) {
	const home = mkdtempSync(join(tmpdir(), "pi-web-access-exa-mcp-"));
	writeFileSync(join(home, "web-search.json"), JSON.stringify({ webSearch: { allowedProviders: ["exa"] } }));
	const env = { ...process.env, PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: join(home, "home"), USERPROFILE: join(home, "home") };
	delete env.EXA_API_KEY;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async () => new Response(${JSON.stringify(body)}, { status: 200, headers: { "content-type": "text/event-stream" } });
			const { search } = await import(${JSON.stringify(searchUrl)});
			try {
				const response = await search("q", { provider: "auto", ...${JSON.stringify(options)} });
				console.log(JSON.stringify({ response }));
			} catch (error) {
				console.log(JSON.stringify({ error: String(error) }));
			}
		`,
		encoding: "utf8",
		env,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim());
}

test("a rate-limited Exa MCP reply is reported as an Exa rate limit, not as no provider configured", () => {
	const { error } = autoSearch(rateLimitedBody);
	assert.match(error, /Exa: Exa's free MCP search is rate-limited\. Add "exaApiKey"/);
	assert.doesNotMatch(error, /No search provider available/);
});

test("an Exa MCP reply without results is reported with what Exa sent", () => {
	const { error } = autoSearch(mcpBody("Something unexpected happened"));
	assert.match(error, /Exa: Exa MCP returned a reply without search results: Something unexpected happened/);
});

test("an Exa MCP reply with zero results is an empty result, not an error", () => {
	const { response } = autoSearch(mcpBody(JSON.stringify({ results: [] })), { domainFilter: ["example.com"] });
	assert.deepEqual({ provider: response.provider, results: response.results }, { provider: "exa", results: [] });
});
