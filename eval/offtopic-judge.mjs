// Measures the off-topic judge (#619) against labeled search responses with real classifier calls.
// Usage: PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/offtopic-judge.mjs [--models <Pi reference>,...] [--repeat 1] [--holdout eval/fixtures/offtopic-holdout.json]
// Calls go through Pi's model registry with your Pi credentials (env vars or /login).
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { judgeOffTopic, OFFTOPIC_JUDGE_MODELS } from "../offtopic-judge.ts";

if (process.env.PI_WEB_ACCESS_REAL_SEMANTIC !== "1") {
	console.error("This harness sends the fixture queries and results to the classifier providers and is billed to your accounts. Set PI_WEB_ACCESS_REAL_SEMANTIC=1 to run it.");
	process.exit(2);
}

const defaultHoldout = new URL("./fixtures/offtopic-holdout.json", import.meta.url);
const { values } = parseArgs({ options: {
	models: { type: "string", default: Object.keys(OFFTOPIC_JUDGE_MODELS).join(",") },
	repeat: { type: "string", default: "1" },
	holdout: { type: "string" },
} });
const models = values.models.split(",").map((model) => model.trim()).filter(Boolean);
const repeat = Number(values.repeat);
for (const model of models) {
	if (!Object.hasOwn(OFFTOPIC_JUDGE_MODELS, model)) throw new Error(`Unknown model ${model}; use one of ${Object.keys(OFFTOPIC_JUDGE_MODELS).join(", ")}`);
}
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
const modelRegistry = new ModelRegistry(await ModelRuntime.create());

const fixtureSets = [{ name: "calibration", cases: JSON.parse(readFileSync(new URL("./fixtures/offtopic-calibration.json", import.meta.url), "utf8")) }];
const holdoutPath = values.holdout ?? (existsSync(defaultHoldout) ? defaultHoldout : undefined);
if (holdoutPath) fixtureSets.push({ name: "holdout", cases: JSON.parse(readFileSync(holdoutPath, "utf8")) });

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
// A threshold sits above every probability the model gave a wrong answer, plus 0.05, and never below 0.85.
const threshold = (highestWrong) => Math.ceil(Math.max(0.85, highestWrong + 0.05) * 100) / 100;

// Only "off_topic" would ever act (a fallback), so its threshold is the one measured. Calibration sets it; the held-out set is judged at it.
for (const model of models) {
	let cut;
	for (const { name, cases } of fixtureSets) {
		const runs = [];
		for (let round = 0; round < repeat; round++) {
			for (const fixture of cases) {
				const started = performance.now();
				const judgment = await judgeOffTopic(model, fixture.query, fixture, modelRegistry);
				runs.push({ round, fixture, judgment, ms: performance.now() - started });
			}
		}
		const judged = runs.filter((run) => "probabilities" in run.judgment);
		const errors = runs.filter((run) => "error" in run.judgment);
		console.log(`\n${model} · ${name} (${cases.length} cases × ${repeat} rounds)`);
		if (errors.length) console.log(`  errors ${errors.length}: ${[...new Set(errors.map((run) => run.judgment.error))].join("; ")}`);
		if (judged.length === 0) break;
		const highestWrong = Math.max(0, ...judged.filter((run) => run.fixture.expected === "addresses").map((run) => run.judgment.probabilities.off_topic));
		cut ??= threshold(highestWrong);
		const offTopic = judged.filter((run) => run.fixture.expected === "off_topic");
		const caught = offTopic.filter((run) => run.judgment.probabilities.off_topic >= cut);
		const wrong = judged.filter((run) => run.fixture.expected === "addresses" && run.judgment.probabilities.off_topic >= cut);
		const latency = runs.map((run) => run.ms).sort((a, b) => a - b);
		console.log(`  highest off_topic on a response that addresses the query: ${highestWrong.toFixed(2)}`);
		console.log(`  at threshold ${cut.toFixed(2)}${name === "calibration" ? "" : " (from calibration)"}: off_topic caught ${caught.length}/${offTopic.length}, wrong off_topic ${wrong.length}`);
		console.log(`  majority label right ${judged.filter((run) => run.judgment.probabilities[run.fixture.expected] > 0.5).length}/${judged.length}`);
		console.log(`  latency p50 ${Math.round(percentile(latency, 0.5))} ms, p90 ${Math.round(percentile(latency, 0.9))} ms`);
		for (const { fixture, judgment, round } of judged) {
			const p = judgment.probabilities.off_topic;
			const label = fixture.expected === "addresses" ? (p >= cut ? "WRONG" : p > 0.5 ? "close" : "") : p >= cut ? "" : "miss ";
			if (label) console.log(`  ${label} ${fixture.id}${repeat > 1 ? ` round ${round + 1}` : ""}: want ${fixture.expected}, off_topic ${p.toFixed(2)} · ${fixture.query}`);
		}
	}
}
