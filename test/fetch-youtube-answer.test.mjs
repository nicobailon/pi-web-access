import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { chmod, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// A YouTube analysis succeeds as TEXT and attaches the video thumbnail as a
// bonus. The answer-mode gate must key on the payload (mimeType / frames), not
// on the mere presence of a thumbnail, or it discards a perfectly good answer.
const envNames = ["PI_CODING_AGENT_DIR", "TMPDIR", "TMP", "TEMP", "GEMINI_API_KEY", "PATH"];
const previousEnv = new Map(envNames.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "pi-fetch-youtube-answer-"));
for (const name of ["PI_CODING_AGENT_DIR", "TMPDIR", "TMP", "TEMP"]) process.env[name] = root;
delete process.env.GEMINI_API_KEY;
const configPath = join(root, "web-search.json");
await writeFile(configPath, JSON.stringify({ geminiApiKey: "synthetic-test-key" }));
// Frame extraction shells out to yt-dlp and ffmpeg; stub both so frame
// results are produced without network or installed binaries.
const binDir = join(root, "bin");
await mkdir(binDir);
await writeFile(join(binDir, "yt-dlp"), "#!/bin/sh\nprintf '60\\nhttps://stream.invalid/video\\n'\n");
await writeFile(join(binDir, "ffmpeg"), "#!/bin/sh\nprintf 'fake-jpeg-bytes'\n");
await chmod(join(binDir, "yt-dlp"), 0o755);
await chmod(join(binDir, "ffmpeg"), 0o755);
process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;

const { default: initializeExtension } = await import("../index.ts");
const { clearResults, getResult } = await import("../storage.ts");
const tools = [];
initializeExtension({
	registerTool(tool) { tools.push(tool); },
	registerCommand() {},
	registerShortcut() {},
	on() {},
	appendEntry() {},
});
const fetchTool = tools.find(tool => tool.name === "fetch_content");
assert.ok(fetchTool);

const TRANSCRIPT = "A young man talks to the camera in front of elephants at the zoo.";
const ANSWER = "A man describes elephants at a zoo.";
let answerCalls = 0;
let answerContext;

const textModel = { api: "test-api", provider: "test", id: "answer-model", input: ["text"], contextWindow: 10_000 };
const ctx = {
	model: textModel,
	modelRegistry: {
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "synthetic-test-key" }),
		complete: async (_model, context) => {
			answerCalls++;
			answerContext = context;
			return { stopReason: "stop", content: [{ type: "text", text: ANSWER }] };
		},
	},
	scopedModels: [],
};
const visionCtx = { ...ctx, model: { ...textModel, id: "vision-model", input: ["text", "image"] } };

beforeEach(async () => {
	clearResults();
	answerCalls = 0;
	answerContext = undefined;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.includes(":generateContent")) {
			return new Response(JSON.stringify({
				candidates: [{ content: { parts: [{ text: TRANSCRIPT }] } }],
			}), { headers: { "content-type": "application/json" } });
		}
		if (url.startsWith("https://img.youtube.com/")) {
			return new Response(Buffer.from("fake-jpeg-bytes"), { headers: { "content-type": "image/jpeg" } });
		}
		throw new Error("Unexpected fetch: " + url);
	};
});

after(async () => {
	clearResults();
	globalThis.fetch = originalFetch;
	for (const [name, value] of previousEnv) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await rm(root, { recursive: true, force: true });
});

test("answer mode keeps the transcript of a video analysis that attaches a thumbnail", async () => {
	const result = await fetchTool.execute(
		"test-call",
		{ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", mode: "answer", prompt: "What happens?" },
		undefined,
		undefined,
		ctx,
	);
	assert.ok(!result.details.error, `unexpected error: ${result.details.error}`);
	const texts = result.content.filter(block => block.type === "text").map(block => block.text);
	assert.ok(texts.some(text => text.includes(ANSWER)), `answer missing from: ${texts.join("|")}`);
	assert.ok(result.content.some(block => block.type === "image"), "thumbnail should still be presented");
	// The stored source is the raw transcript, not the answer.
	const stored = getResult(result.details.responseId);
	assert.match(stored?.urls?.[0].content ?? "", /elephants at the zoo/);
});

for (const [name, params] of [["a single frame", { timestamp: "0:05" }], ["multiple frames", { frames: 2 }]]) {
	test(`answer mode sends ${name} to the answer model as images`, async () => {
		const result = await fetchTool.execute(
			"test-call",
			{ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", mode: "answer", prompt: "What happens?", ...params },
			undefined,
			undefined,
			visionCtx,
		);
		assert.ok(!result.details.error, `unexpected error: ${result.details.error}`);
		const parts = answerContext.messages[0].content;
		const images = parts.filter(part => part.type === "image");
		assert.equal(images.length, params.frames ?? 1);
		assert.ok(images.every(image => image.mimeType === "image/jpeg" && image.data === Buffer.from("fake-jpeg-bytes").toString("base64")));
		const labels = parts.filter(part => part.type === "text" && part.text.startsWith("Frame at "));
		assert.equal(labels.length, images.length);
		assert.ok(result.content.some(block => block.type === "text" && block.text.includes(ANSWER)));
		assert.ok(!result.content.some(block => block.type === "image"), "the answer replaces the frames");
	});

	test(`answer mode reports a text-only answer model for ${name}`, async () => {
		const result = await fetchTool.execute(
			"test-call",
			{ url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", mode: "answer", prompt: "What happens?", ...params },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(result.details.error, "Page answer failed: Answer model does not support image input: test/answer-model");
		assert.equal(answerCalls, 0);
	});
}
