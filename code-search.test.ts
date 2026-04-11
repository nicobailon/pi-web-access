import { afterEach, expect, test } from "bun:test";
import { executeCodeSearch } from "./code-search.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("code_search uses web_search_exa instead of deprecated get_code_context_exa", async () => {
	let requestBody: any;
	globalThis.fetch = async (_input, init) => {
		requestBody = JSON.parse(String(init?.body));
		const payload = JSON.stringify({
			result: {
				content: [{ type: "text", text: "Title: Example\nURL: https://example.com\nText: OAuth example" }],
			},
		});
		return new Response(`data: ${payload}\n\n`, {
			status: 200,
			headers: { "Content-Type": "text/event-stream" },
		});
	};

	const result = await executeCodeSearch("call-1", { query: "OAuth 2.0 example", maxTokens: 4321 });

	expect(requestBody.params.name).toBe("web_search_exa");
	expect(requestBody.params.name).not.toBe("get_code_context_exa");
	expect(requestBody.params.arguments.query).toBe("OAuth 2.0 example");
	expect(requestBody.params.arguments.contextMaxCharacters).toBeNumber();
	expect(requestBody.params.arguments.contextMaxCharacters).toBeGreaterThan(0);
	expect(requestBody.params.arguments).not.toHaveProperty("tokensNum");
	expect(result.details).toEqual({ query: "OAuth 2.0 example", maxTokens: 4321 });
	expect(result.content[0]?.text).toContain("OAuth example");
});
