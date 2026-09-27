import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { generateSummaryDraft } from "../summary-review.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-access-provider-summary-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(testAgentDir, { recursive: true, force: true });
});

test("summary generation preserves registered provider behavior", async () => {
	const model = {
		provider: "custom-gateway",
		id: "upstream/test-model",
		api: "custom-gateway-api",
		baseUrl: "https://gateway.example.test",
	};
	const result = await generateSummaryDraft(
		[{
			query: "test query",
			answer: "Provider search answer.",
			results: [{ title: "Source", url: "https://example.test/source" }],
			error: null,
			provider: "search-provider",
		}],
		{
			modelRegistry: {
				find: () => model,
				getAvailable: () => [model],
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
				complete: async (_model, _context, options) => {
					assert.equal(options.apiKey, undefined);
					assert.equal(options.headers, undefined);
					return {
						stopReason: "stop",
						content: [{ type: "text", text: "Summary from the registered gateway provider." }],
					};
				},
			},
			scopedModels: [],
		},
		undefined,
		"custom-gateway/upstream/test-model",
		undefined,
		undefined,
		1000,
	);

	assert.equal(result.summary, "Summary from the registered gateway provider.");
});
