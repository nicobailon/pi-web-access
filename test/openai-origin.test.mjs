import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../openai-search.ts", import.meta.url).href;
const official = "https://api.openai.com/v1/responses";
const gateway = "http://127.0.0.1:8921/v1";

const cases = [
	{ name: "invalid explicit endpoint remains an availability error", endpoint: "not a URL", configError: true },
	{ name: "custom Pi base URL refuses before fetch", baseUrl: gateway, blocked: true },
	{ name: "auth-resolved custom URL overrides official model URL", baseUrl: "https://api.openai.com/v1", authBaseUrl: gateway, blocked: true },
	{ name: "invalid Pi base URL refuses before fetch", baseUrl: "not a URL", blocked: true },
	{ name: "lookalike official host refuses before fetch", baseUrl: "https://api.openai.com.example/v1", blocked: true },
	{ name: "HTTP official host refuses before fetch", baseUrl: "http://api.openai.com/v1", blocked: true },
	{ name: "official Pi base URL keeps default", baseUrl: "https://api.openai.com/v1", expectedUrl: official },
	{ name: "official trailing slash keeps default", baseUrl: "https://api.openai.com/v1/", expectedUrl: official },
	{ name: "absent Pi base URL keeps default", expectedUrl: official },
	{ name: "auth-resolved official URL overrides custom model URL", baseUrl: gateway, authBaseUrl: "https://api.openai.com/v1", expectedUrl: official },
	{ name: "explicit gateway full endpoint takes precedence", baseUrl: gateway, endpoint: "http://127.0.0.1:8921/custom/responses?version=1", expectedUrl: "http://127.0.0.1:8921/custom/responses?version=1" },
	{ name: "explicit official endpoint opts in", baseUrl: gateway, endpoint: official, expectedUrl: official },
	{ name: "standalone API key keeps default", standalone: true, expectedUrl: official },
	{ name: "Codex keeps its existing endpoint", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api", expectedUrl: "https://chatgpt.com/backend-api/codex/responses" },
];

for (const scenario of cases) {
	test(`OpenAI origin: ${scenario.name}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-openai-origin-"));
		try {
			await writeFile(join(dir, "web-search.json"), JSON.stringify({
				openaiResponsesUrl: scenario.endpoint,
				// A blocked Pi credential must not silently fall through to this key.
				openaiApiKey: "standalone-test-key",
			}));
			const child = spawnSync(process.execPath, ["--input-type=module"], {
				encoding: "utf8",
				env: { ...process.env, PI_CODING_AGENT_DIR: dir, OPENAI_API_KEY: "" },
				input: `
					const scenario = ${JSON.stringify(scenario)};
					const requests = [];
					const model = { id: "gpt-5.6-terra", provider: scenario.provider ?? "openai", api: "openai-responses", baseUrl: scenario.baseUrl };
					const ctx = scenario.standalone ? undefined : { modelRegistry: {
						getAll: () => [model],
						getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "pi-gateway-test-key", headers: { "X-Gateway": "test" }, baseUrl: scenario.authBaseUrl }),
					} };
					globalThis.fetch = async (url, init) => {
						requests.push({ url: String(url), headers: init.headers });
						return new Response(JSON.stringify({ output: [
							{ type: "web_search_call" },
							{ type: "message", content: [{ type: "output_text", text: "Test answer" }] },
						] }), { status: 200 });
					};
					const { searchWithOpenAI, isOpenAISearchAvailable } = await import(${JSON.stringify(moduleUrl)});
					let error, availabilityError, available;
					try { await searchWithOpenAI("private query", {}, ctx); } catch (err) { error = err.message; }
					try { available = await isOpenAISearchAvailable(ctx); } catch (err) { availabilityError = err.message; }
					console.log(JSON.stringify({ requests, error, available, availabilityError }));
				`,
			});
			assert.equal(child.status, 0, child.stderr);
			const output = JSON.parse(child.stdout.trim());
			if (scenario.configError) {
				assert.deepEqual(output.requests, []);
				assert.match(output.error, /openaiResponsesUrl.*absolute http\(s\) URL/);
				assert.equal(output.availabilityError, output.error);
			} else if (scenario.blocked) {
				assert.deepEqual(output.requests, []);
				assert.match(output.error, /custom baseUrl.*openaiResponsesUrl/);
				assert.equal(output.availabilityError, undefined);
				assert.equal(output.available, false);
				assert.ok(!output.error.includes("pi-gateway-test-key"));
			} else {
				assert.equal(output.error, undefined);
				assert.equal(output.available, true);
				assert.equal(output.requests.length, 1);
				assert.equal(output.requests[0].url, scenario.expectedUrl);
				assert.equal(output.requests[0].headers.Authorization, `Bearer ${scenario.standalone ? "standalone-test-key" : "pi-gateway-test-key"}`);
				if (!scenario.standalone) assert.equal(output.requests[0].headers["X-Gateway"], "test");
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
}
