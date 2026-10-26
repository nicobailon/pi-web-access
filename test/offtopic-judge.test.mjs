import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeOffTopic } from "../offtopic-judge.ts";

const CLEF = "cloudflare-workers-ai/@cf/cloudflare/clef";
const response = { answer: "", results: [{ title: "Rust removal", url: "https://example.com/rust", snippet: "Soak tools in vinegar." }] };

function registry(result, model = { id: "classifier" }) {
	const calls = [];
	return { calls, findOfType: () => model, async classify(found, context) { calls.push(context); return typeof result === "function" ? result() : result; } };
}
const relevance = (answer) => ({ stopReason: "stop", answers: { relevance: answer } });

test("the judge sends the query and response and returns the model's probabilities", async () => {
	const fake = registry(relevance({ type: "choice", choice: "off_topic", probabilities: { addresses: 0.1, off_topic: 0.9 }, confidence: 0.9 }));
	assert.deepEqual(await judgeOffTopic(CLEF, "rust borrow checker", response, fake), { probabilities: { addresses: 0.1, off_topic: 0.9 } });
	assert.deepEqual(fake.calls[0].state, { query: "rust borrow checker", ...response });
	assert.deepEqual(Object.keys(fake.calls[0].questions.relevance.criteria), ["addresses", "off_topic"]);
});

test("invalid answers, failures and a missing model become errors, never probabilities", async () => {
	const cases = [
		[relevance({ choice: "maybe", probabilities: { addresses: 0.5, off_topic: 0.5 } }), /not one of its labels/],
		[relevance({ choice: "off_topic", probabilities: { off_topic: 1 } }), /do not match the labels/],
		[relevance({ choice: "off_topic", probabilities: { addresses: 0.5, off_topic: 0.9 } }), /do not sum to 1/],
		[{ stopReason: "error", errorMessage: "quota exceeded", answers: {} }, /quota exceeded/],
		[() => { throw new Error("network down"); }, /network down/],
	];
	for (const [result, pattern] of cases) assert.match((await judgeOffTopic(CLEF, "q", response, registry(result))).error, pattern);
	assert.match((await judgeOffTopic(CLEF, "q", response, registry(relevance({}), null))).error, /not in this Pi's classifier catalog/);
});

test("a caller abort is rethrown", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(judgeOffTopic(CLEF, "q", response, registry(() => { throw new Error("aborted"); }), controller.signal), { name: "AbortError" });
});
