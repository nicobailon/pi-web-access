import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../openai-search.ts", import.meta.url).href;

const sse = (events) => events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n");

const cases = [
	{
		name: "captured failure: error event + response.failed",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.in_progress", response: { status: "in_progress" } },
			{ type: "error", error: { type: "invalid_request_error", code: "subscription_sharing_usage_limit_exceeded", message: "The ChatGPT user has reached their Subscription Sharing usage limit. Try again later." } },
			{ type: "response.failed", response: { status: "failed", error: { type: "invalid_request_error", code: "subscription_sharing_usage_limit_exceeded", message: "The ChatGPT user has reached their Subscription Sharing usage limit. Try again later." } } },
		]),
		expectError: ["subscription_sharing_usage_limit_exceeded", "Subscription Sharing usage limit"],
		rejectError: "no parseable response output",
	},
	{
		name: "top-level error event",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "error", code: "rate_limit_exceeded", message: "slow down" },
		]),
		expectError: ["rate_limit_exceeded", "slow down"],
		rejectError: "no parseable response output",
	},
	{
		name: "success path regression",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com", title: "Example" }] } } },
			{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "The answer" }] } },
			{ type: "response.completed", response: { status: "completed", output: [
				{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com", title: "Example" }] } },
				{ type: "message", content: [{ type: "output_text", text: "The answer" }] },
			] } },
		]),
		expectResult: { answer: "The answer" },
	},
	{
		name: "no-error fallback regression",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.in_progress", response: { status: "in_progress" } },
		]),
		expectError: ["no parseable response output"],
	},
	{
		name: "string error payload",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "error", error: "quota exceeded" },
		]),
		expectError: ["quota exceeded"],
		rejectError: "OpenAI API stream failed",
	},
	{
		name: "incomplete response with usable output",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com", title: "Example" }] } } },
			{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Partial answer" }] } },
			{ type: "response.incomplete", response: { status: "incomplete", error: null, incomplete_details: { reason: "max_output_tokens" }, output: [
				{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com", title: "Example" }] } },
				{ type: "message", content: [{ type: "output_text", text: "Partial answer" }] },
			] } },
		]),
		expectResult: { answer: "Partial answer" },
	},
	{
		name: "response.failed with null error still errors",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.failed", response: { status: "failed", error: null } },
		]),
		// A failed response must never parse as success, even without an
		// error payload; surfaces as a generic stream error instead.
		expectError: ["stream error", "failed"],
	},
	{
		name: "response.failed with partial output is not a success",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com", title: "Example" }] } } },
			{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Partial answer" }] } },
			{ type: "response.failed", response: { status: "failed", error: null } },
		]),
		expectError: ["stream error", "failed"],
	},
	{
		name: "error event takes precedence over later completion",
		body: sse([
			{ type: "response.created", response: { status: "in_progress" } },
			{ type: "error", error: { type: "server_error", code: "internal_error", message: "backend exploded" } },
			{ type: "response.completed", response: { status: "completed", output: [
				{ type: "message", content: [{ type: "output_text", text: "ignored" }] },
			] } },
		]),
		expectError: ["internal_error", "backend exploded"],
		rejectError: "no parseable response output",
	},
	{
		name: "plain JSON body path",
		json: { output: [
			{ type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.com", title: "Example" }] } },
			{ type: "message", content: [{ type: "output_text", text: "JSON answer" }] },
		] },
		expectResult: { answer: "JSON answer" },
	},
];

for (const scenario of cases) {
	test(`OpenAI stream parse: ${scenario.name}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-openai-stream-"));
		try {
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "test-key" },
				input: `
					const scenario = ${JSON.stringify(scenario)};
					globalThis.fetch = async () => new Response(
						scenario.json !== undefined ? JSON.stringify(scenario.json) : scenario.body,
						{ status: 200, headers: { "content-type": scenario.json !== undefined ? "application/json" : "text/event-stream" } },
					);
					const { searchWithOpenAI } = await import(${JSON.stringify(moduleUrl)});
					let result, error;
					try { result = await searchWithOpenAI("test query", { numResults: 5 }); } catch (err) { error = err.message; }
					console.log(JSON.stringify({ result, error }));
				`,
			});
			assert.equal(child.status, 0, child.stderr);
			const output = JSON.parse(child.stdout.trim());
			if (scenario.expectResult) {
				assert.equal(output.error, undefined);
				assert.equal(output.result.answer, scenario.expectResult.answer);
			} else {
				assert.equal(output.result, undefined);
				for (const fragment of scenario.expectError) assert.ok(output.error.includes(fragment), `error ${JSON.stringify(output.error)} missing ${fragment}`);
				if (scenario.rejectError) assert.ok(!output.error.includes(scenario.rejectError), `error unexpectedly contains ${scenario.rejectError}`);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
