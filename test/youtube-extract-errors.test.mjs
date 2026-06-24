import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractorUrl = new URL("../extract.ts", import.meta.url).href;

test("YouTube extraction surfaces Gemini API errors", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-youtube-errors-"));
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GEMINI_API_KEY: "test-gemini-key",
		PERPLEXITY_API_KEY: "",
	};
	delete env.PI_ALLOW_BROWSER_COOKIES;
	delete env.FEYNMAN_ALLOW_BROWSER_COOKIES;

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: buildChildScript(extractorUrl),
		encoding: "utf8",
		env,
	});

	assert.equal(child.status, 0, child.stderr || child.stdout);
	const result = JSON.parse(child.stdout);
	assert.match(result.error, /Gemini API error 503/);
	assert.doesNotMatch(result.error, /Sign into Google in Chrome/);
});

function buildChildScript(moduleUrl) {
	return `
		process.on("uncaughtException", (error) => {
			console.error(error?.stack || error);
			process.exit(1);
		});
		process.on("unhandledRejection", (error) => {
			console.error(error?.stack || error);
			process.exit(1);
		});

		globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.startsWith("https://generativelanguage.googleapis.com/")) {
				return new Response(JSON.stringify({ error: { message: "model overloaded" } }), {
					status: 503,
					statusText: "Service Unavailable",
					headers: { "content-type": "application/json" },
				});
			}
			throw new Error("Unexpected fetch: " + url);
		};

		const { extractContent } = await import(${JSON.stringify(moduleUrl)});
		const result = await extractContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
		console.log(JSON.stringify(result));
	`;
}
