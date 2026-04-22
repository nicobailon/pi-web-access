import test from "node:test";
import assert from "node:assert/strict";
import {
	getAutoProviderOrder,
	isOpenAIAutoCompatible,
	pickAutoProvider,
} from "../search-provider-order.ts";

test("isOpenAIAutoCompatible allows requests OpenAI can handle", () => {
	assert.equal(isOpenAIAutoCompatible({}), true);
	assert.equal(isOpenAIAutoCompatible({ domainFilter: ["openai.com", "platform.openai.com"] }), true);
});

test("isOpenAIAutoCompatible rejects recency filters and excluded domains", () => {
	assert.equal(isOpenAIAutoCompatible({ recencyFilter: "week" }), false);
	assert.equal(isOpenAIAutoCompatible({ domainFilter: ["openai.com", "-reddit.com"] }), false);
});

test("getAutoProviderOrder prefers OpenAI first when compatible", () => {
	assert.deepEqual(
		getAutoProviderOrder({ openai: true, exa: true, perplexity: true, gemini: true }),
		["openai", "exa", "perplexity", "gemini"],
	);
});

test("getAutoProviderOrder skips OpenAI when the request is incompatible", () => {
	assert.deepEqual(
		getAutoProviderOrder(
			{ openai: true, exa: true, perplexity: true, gemini: true },
			{ recencyFilter: "week" },
		),
		["exa", "perplexity", "gemini"],
	);
	assert.deepEqual(
		getAutoProviderOrder(
			{ openai: true, exa: true, perplexity: true, gemini: true },
			{ domainFilter: ["openai.com", "-reddit.com"] },
		),
		["exa", "perplexity", "gemini"],
	);
});

test("pickAutoProvider returns the first compatible provider in order", () => {
	assert.equal(
		pickAutoProvider({ openai: true, exa: true, perplexity: true, gemini: true }),
		"openai",
	);
	assert.equal(
		pickAutoProvider(
			{ openai: true, exa: true, perplexity: true, gemini: true },
			{ recencyFilter: "week" },
		),
		"exa",
	);
	assert.equal(
		pickAutoProvider({ openai: false, exa: false, perplexity: true, gemini: true }),
		"perplexity",
	);
});
