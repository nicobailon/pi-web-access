import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const olostepModuleUrl = new URL("../olostep.ts", import.meta.url).href;
const extractModuleUrl = new URL("../extract.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR",
		"XDG_CONFIG_HOME",
		"OPENAI_API_KEY",
		"BRAVE_API_KEY",
		"PARALLEL_API_KEY",
		"TAVILY_API_KEY",
		"EXA_API_KEY",
		"OLOSTEP_API_KEY",
		"PERPLEXITY_API_KEY",
		"GEMINI_API_KEY",
	]) {
		delete childEnv[key];
	}
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

test("isOlostepAvailable returns false with no key", () => {
	const child = runChild(`
		const { isOlostepAvailable } = await import(${JSON.stringify(olostepModuleUrl)});
		process.stdout.write(JSON.stringify(isOlostepAvailable()));
	`, {});
	assert.strictEqual(child.status, 0, child.stderr);
	assert.strictEqual(JSON.parse(child.stdout), false);
});

test("isOlostepAvailable returns true when OLOSTEP_API_KEY is set", () => {
	const child = runChild(`
		const { isOlostepAvailable } = await import(${JSON.stringify(olostepModuleUrl)});
		process.stdout.write(JSON.stringify(isOlostepAvailable()));
	`, { OLOSTEP_API_KEY: "test-key" });
	assert.strictEqual(child.status, 0, child.stderr);
	assert.strictEqual(JSON.parse(child.stdout), true);
});

test("searchWithOlostep returns null with no API key", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-olostep-"));
	const child = runChild(`
		const { searchWithOlostep } = await import(${JSON.stringify(olostepModuleUrl)});
		const result = await searchWithOlostep("test query");
		process.stdout.write(JSON.stringify(result));
	`, { XDG_CONFIG_HOME: home });
	assert.strictEqual(child.status, 0, child.stderr);
	assert.strictEqual(JSON.parse(child.stdout), null);
});

test("searchWithOlostep sends correct request and returns shaped result", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-olostep-"));
	const child = runChild(`
		let capturedUrl = "";
		let capturedHeaders = null;
		let capturedBody = null;
		globalThis.fetch = async (url, init) => {
			capturedUrl = String(url);
			capturedHeaders = Object.fromEntries(Object.entries(init.headers));
			capturedBody = JSON.parse(init.body);
			return new Response(JSON.stringify({
				answer: "Olostep is a web scraping API.",
				results: [
					{ url: "https://olostep.com", title: "Olostep", description: "Web scraping API" },
					{ url: "https://docs.olostep.com", title: "Olostep Docs", description: "API docs" },
				],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { searchWithOlostep } = await import(${JSON.stringify(olostepModuleUrl)});
		const result = await searchWithOlostep("what is olostep", { numResults: 3 });
		process.stdout.write(JSON.stringify({ capturedUrl, capturedHeaders, capturedBody, result }));
	`, { OLOSTEP_API_KEY: "test-key-123", XDG_CONFIG_HOME: home });

	assert.strictEqual(child.status, 0, child.stderr);
	const { capturedUrl, capturedHeaders, capturedBody, result } = JSON.parse(child.stdout);

	assert.ok(capturedUrl.includes("olostep.com"), "should call Olostep API");
	assert.ok(capturedHeaders["Authorization"]?.includes("test-key-123"), "should send Bearer auth");
	assert.strictEqual(capturedBody.query, "what is olostep");
	assert.strictEqual(capturedBody.numResults, 3);
	assert.strictEqual(typeof result.answer, "string");
	assert.ok(result.answer.length > 0, "answer should be non-empty");
	assert.ok(Array.isArray(result.results), "results should be an array");
	assert.strictEqual(result.results.length, 2);
	assert.strictEqual(result.results[0].url, "https://olostep.com");
	assert.strictEqual(result.results[0].title, "Olostep");
});

test("auto search fallback chain skips Olostep when no key", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-olostep-auto-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify({ provider: "auto" }));

	const child = runChild(`
		const olostepCalled = { value: false };
		globalThis.fetch = async (url, init) => {
			if (String(url).includes("olostep")) {
				olostepCalled.value = true;
			}
			// Simulate Exa MCP unavailable, all providers fail
			return new Response(JSON.stringify({ error: "unavailable" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		};

		const { isOlostepAvailable } = await import(${JSON.stringify(olostepModuleUrl)});
		process.stdout.write(JSON.stringify({
			olostepAvailable: isOlostepAvailable(),
		}));
	`, { XDG_CONFIG_HOME: home });

	assert.strictEqual(child.status, 0, child.stderr);
	const { olostepAvailable } = JSON.parse(child.stdout);
	assert.strictEqual(olostepAvailable, false, "Olostep should not be available without a key");
});

test("extractWithOlostep returns null with no API key", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-olostep-ext-"));
	const child = runChild(`
		const { extractWithOlostep } = await import(${JSON.stringify(olostepModuleUrl)});
		const result = await extractWithOlostep("https://example.com");
		process.stdout.write(JSON.stringify(result));
	`, { XDG_CONFIG_HOME: home });
	assert.strictEqual(child.status, 0, child.stderr);
	assert.strictEqual(JSON.parse(child.stdout), null);
});

test("extractWithOlostep returns ExtractedContent on success", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-olostep-ext-"));
	const child = runChild(`
		globalThis.fetch = async (url, init) => {
			return new Response(JSON.stringify({
				markdown_content: "# Hello from Olostep\\n\\nThis is extracted content.",
				page_title: "Test Page",
				url: "https://example.com",
			}), { status: 200, headers: { "content-type": "application/json" } });
		};

		const { extractWithOlostep } = await import(${JSON.stringify(olostepModuleUrl)});
		const result = await extractWithOlostep("https://example.com");
		process.stdout.write(JSON.stringify(result));
	`, { OLOSTEP_API_KEY: "test-key-456", XDG_CONFIG_HOME: home });

	assert.strictEqual(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.strictEqual(result.url, "https://example.com");
	assert.strictEqual(result.title, "Test Page");
	assert.ok(result.content.includes("Hello from Olostep"), "content should be markdown");
	assert.strictEqual(result.error, null);
});
