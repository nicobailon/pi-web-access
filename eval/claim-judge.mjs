// Measures the source_check claim judge against the claim fixtures with real classifier calls.
// Usage: PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/claim-judge.mjs [--models <Pi reference>,...] [--repeat 1]
// Calls go through Pi's model registry with your Pi credentials (env vars or /login).
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CLAIM_JUDGE_MODELS, judgeClaim } from "../claim-judge.ts";

if (process.env.PI_WEB_ACCESS_REAL_SEMANTIC !== "1") {
	console.error("This harness sends the fixture claims to the classifier providers and is billed to your accounts. Set PI_WEB_ACCESS_REAL_SEMANTIC=1 to run it.");
	process.exit(2);
}

const { values } = parseArgs({ options: { models: { type: "string", default: Object.keys(CLAIM_JUDGE_MODELS).join(",") }, repeat: { type: "string", default: "1" } } });
const models = values.models.split(",").map((model) => model.trim()).filter(Boolean);
const repeat = Number(values.repeat);
for (const model of models) {
	if (!Object.hasOwn(CLAIM_JUDGE_MODELS, model)) throw new Error(`Unknown model ${model}; use one of ${Object.keys(CLAIM_JUDGE_MODELS).join(", ")}`);
}
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
const modelRegistry = new ModelRegistry(await ModelRuntime.create());

const LABELS = ["supported", "contradicted", "not_addressed"];
// Fixtures marked with a known limit are reported on their own and never count toward the pass or wrong numbers.
// sibling-holdout: sibling-product traps and controls written blind, after the other-subject question was frozen.
const fixtureSets = ["calibration", "holdout", "sibling-holdout"].map((name) => ({
	name,
	claims: JSON.parse(readFileSync(new URL(`./fixtures/claims-${name}.json`, import.meta.url), "utf8")),
}));

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const describe = ({ fixture, round, assessment, error, probabilities, otherSubject }, want) =>
	`${fixture.id}${repeat > 1 ? ` round ${round + 1}` : ""}: want ${want}, got ${assessment.status}${error ? ` (${error})` : probabilities ? ` (${LABELS.map((label) => `${label} ${probabilities[label].toFixed(2)}`).join(", ")}${otherSubject === undefined ? "" : `, other subject ${otherSubject.toFixed(2)}`})` : ""}`;
const wanted = (fixture) => fixture.expected === "not_addressed" ? "unclear" : fixture.expected;

for (const model of models) {
	for (const { name, claims } of fixtureSets) {
		const runs = [];
		for (let round = 0; round < repeat; round++) {
			for (const fixture of claims) {
				const started = performance.now();
				const { assessment, error, probabilities, evidence, otherSubject } = await judgeClaim(model, fixture.claim, fixture.passages, modelRegistry);
				const ms = performance.now() - started;
				runs.push({ round, fixture, assessment, error, ms, probabilities, evidence, otherSubject });
			}
		}

		const scored = runs.filter((run) => !run.fixture.limit);
		let passed = 0, wrongSupported = 0, wrongContradicted = 0, evidenceMatched = 0, verdicts = 0;
		const highestWrong = { supported: 0, contradicted: 0 };
		const failures = [];
		for (const run of scored) {
			const { fixture, assessment, probabilities } = run;
			const want = wanted(fixture);
			if (assessment.status === want) passed++;
			else failures.push(describe(run, want));
			if (assessment.status === "supported" && want !== "supported") wrongSupported++;
			if (assessment.status === "contradicted" && want !== "contradicted") wrongContradicted++;
			if (assessment.status === want && want !== "unclear") {
				verdicts++;
				const cited = [...assessment.supporting_passages, ...assessment.contradicting_passages];
				if (cited.some((id) => fixture.evidence.includes(id))) evidenceMatched++;
			}
			if (probabilities) {
				for (const label of ["supported", "contradicted"]) {
					if (fixture.expected !== label) highestWrong[label] = Math.max(highestWrong[label], probabilities[label]);
				}
			}
		}
		let drift = 0;
		for (const run of runs.filter((candidate) => candidate.round > 0 && candidate.probabilities)) {
			const base = runs.find((candidate) => candidate.round === 0 && candidate.fixture.id === run.fixture.id)?.probabilities;
			if (base) drift = Math.max(drift, ...LABELS.map((label) => Math.abs(base[label] - run.probabilities[label])));
		}
		const latency = runs.map((run) => run.ms).sort((a, b) => a - b);
		const verdictLatency = runs.filter((run) => run.otherSubject !== undefined || ["supported", "contradicted"].includes(run.assessment.status)).map((run) => run.ms).sort((a, b) => a - b);
		const errors = runs.filter((run) => run.error).length;
		// The other-subject threshold sits above the highest value on a page that backs a correct verdict: the verdict
		// before the check matched the fixture and cited one of its evidence passages, even if the check removed it.
		const asked = runs.filter((run) => run.otherSubject !== undefined);
		const correct = (run) => run.fixture.expected !== "not_addressed" && run.fixture.evidence.includes(run.evidence) && run.probabilities[run.fixture.expected] >= CLAIM_JUDGE_MODELS[model][run.fixture.expected];
		const highestOnCorrect = Math.max(0, ...asked.filter(correct).map((run) => run.otherSubject));

		console.log(`\n${model} · ${name} (${scored.length / repeat} scored claims × ${repeat} rounds)`);
		console.log(`  pass ${passed}/${scored.length}  wrong supported ${wrongSupported}  wrong contradicted ${wrongContradicted}  errors ${errors}`);
		console.log(`  highest wrong probability: supported ${highestWrong.supported.toFixed(2)}, contradicted ${highestWrong.contradicted.toFixed(2)}`);
		console.log(`  other subject asked ${asked.length} times, highest on a correct verdict's page ${highestOnCorrect.toFixed(2)}`);
		console.log(`  evidence matched ${evidenceMatched}/${verdicts}${repeat > 1 ? `  largest change across repeats ${drift.toFixed(2)}` : ""}`);
		console.log(`  latency p50 ${Math.round(percentile(latency, 0.5))} ms, p95 ${Math.round(percentile(latency, 0.95))} ms; claims that reached a verdict p50 ${Math.round(percentile(verdictLatency, 0.5) ?? 0)} ms`);
		for (const failure of failures) console.log(`  FAIL ${failure}`);
		for (const limit of new Set(runs.map((run) => run.fixture.limit).filter(Boolean))) {
			const limited = runs.filter((run) => run.fixture.limit === limit);
			console.log(`  KNOWN LIMIT: ${limit} (${limited.length} results, not counted above)`);
			for (const run of limited) {
				const want = wanted(run.fixture);
				console.log(`    ${run.assessment.status === want ? "ok  " : "MISS"} ${describe(run, want)}`);
			}
		}
	}
}
