import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;
const fixtureUrl = new URL("./pdf-fixture.mjs", import.meta.url).href;
const POLICY = /is blocked by the retrieval-only policy \(PI_WEB_ACCESS_RETRIEVAL_ONLY=1\)/;
const MODEL_HOSTS = /generativelanguage\.googleapis\.com|gemini\.google\.com|api\.perplexity\.ai/;

// Model hosts answer successfully, so a call that slips through shows up as content, not only as a request.
function run(config, call, env = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-retrieval-only-routes-"));
	writeFileSync(join(root, "web-search.json"), JSON.stringify(config) + "\n");
	const childEnv = { ...process.env, PI_CODING_AGENT_DIR: root, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: "", PI_WEB_ACCESS_RETRIEVAL_ONLY: "1", ...env };
	for (const key of ["PERPLEXITY_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY", "EXA_API_KEY"]) if (!(key in env)) delete childEnv[key];
	if (!("GEMINI_API_KEY" in env)) delete childEnv.GEMINI_API_KEY;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { makePdf } = await import(${JSON.stringify(fixtureUrl)});
			const calls = [];
			globalThis.fetch = async (input) => {
				const url = String(input instanceof Request ? input.url : input);
				calls.push(url);
				if (url.includes("generativelanguage.googleapis.com")) {
					return Response.json({ candidates: [{ content: { parts: [{ text: "# Gemini wrote this\\n\\n" + "model text ".repeat(40) }] }, finishReason: "STOP" }] });
				}
				if (url.includes("api.perplexity.ai")) return Response.json({ choices: [{ message: { content: "perplexity wrote this" } }] });
				if (url === "https://example.com/doc.pdf") return new Response(makePdf("Hello unpdf text"), { headers: { "content-type": "application/pdf" } });
				return new Response("blocked", { status: 403 });
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
			const result = await (${call})(extractContent, lookup, ${JSON.stringify(root)});
			console.log(JSON.stringify({ calls, content: result.content, error: result.error }));
		`,
		encoding: "utf8",
		env: childEnv,
		timeout: 60_000,
		maxBuffer: 4 * 1024 * 1024,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

const assertNoModelCall = (out) => assert.ok(!out.calls.some(url => MODEL_HOSTS.test(url)), out.calls.join(", "));

test("PDF auto skips Gemini and uses unpdf; pdf.provider gemini is refused", () => {
	const fetchPdf = `(extractContent, lookup) => extractContent("https://example.com/doc.pdf", undefined, { lookup })`;
	const auto = run({}, fetchPdf, { GEMINI_API_KEY: "g-test" });
	assertNoModelCall(auto);
	assert.equal(auto.error, null);
	assert.match(auto.content, /Hello unpdf text/);

	const gemini = run({ pdf: { provider: "gemini" } }, fetchPdf, { GEMINI_API_KEY: "g-test" });
	assertNoModelCall(gemini);
	assert.match(gemini.error, /PDF provider "gemini" is blocked by the retrieval-only policy/);
});

test("the Gemini fetch provider is dropped from routing, and a Gemini-only route is refused", () => {
	const fetchPage = `(extractContent, lookup) => extractContent("https://example.com/page", undefined, { lookup })`;
	const only = run({ fetchRouting: { providers: ["gemini"], allowRemoteHostedProviders: true } }, fetchPage, { GEMINI_API_KEY: "g-test" });
	assertNoModelCall(only);
	assert.match(only.error, /No retrieval route is available under the retrieval-only policy .*fetch provider routes that use a model were skipped: gemini\./);

	const mixed = run({ fetchRouting: { providers: ["http", "gemini"], allowRemoteHostedProviders: true } }, fetchPage, { GEMINI_API_KEY: "g-test" });
	assertNoModelCall(mixed);
	assert.ok(mixed.calls.includes("https://example.com/page"));
	assert.match(mixed.error, /403/);
	assert.doesNotMatch(mixed.error, /GEMINI_API_KEY|gemini\.google\.com/);
});

test("YouTube and local video analysis are refused, while local frames still take the frame path", () => {
	const youtube = run({}, `(extractContent, lookup) => extractContent("https://www.youtube.com/watch?v=dQw4w9WgXcQ", undefined, { lookup })`, { GEMINI_API_KEY: "g-test", PERPLEXITY_API_KEY: "p-test" });
	assertNoModelCall(youtube);
	assert.match(youtube.error, /YouTube video analysis is blocked by the retrieval-only policy/);

	const video = (options) => `async (extractContent, _lookup, root) => {
		const { writeFileSync } = await import("node:fs");
		const path = root + "/clip.mp4";
		writeFileSync(path, Buffer.alloc(1024));
		return extractContent(path, undefined, ${JSON.stringify(options)});
	}`;
	const analysis = run({}, video({ prompt: "summarize" }), { GEMINI_API_KEY: "g-test" });
	assertNoModelCall(analysis);
	assert.match(analysis.error, /Local video analysis is blocked by the retrieval-only policy/);

	// The fake clip has no frames to decode, so success depends on ffmpeg; the route is what matters here.
	const frames = run({}, video({ timestamp: "0" }), { GEMINI_API_KEY: "g-test" });
	assertNoModelCall(frames);
	assert.doesNotMatch(frames.error ?? "", POLICY);
	assert.match(frames.error ?? "", /ffmpeg|ffprobe|failed|not installed/i);
});

test("a local frame request still returns a frame under the policy", (t) => {
	if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("needs ffmpeg");
	const clip = join(mkdtempSync(join(tmpdir(), "pi-web-access-retrieval-only-clip-")), "clip.mp4");
	const made = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5", "-pix_fmt", "yuv420p", "-y", clip]);
	assert.equal(made.status, 0, String(made.stderr));
	const out = run({}, `(extractContent) => extractContent(${JSON.stringify(clip)}, undefined, { timestamp: "0" })`);
	assert.equal(out.error, null);
	assert.match(out.content, /Video frame at 0/);
});
