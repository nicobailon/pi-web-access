// Measures the source_check claim judge against the claim fixtures with real provider calls.
// Usage: PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/claim-judge.mjs [--models clef,jev-1.13.0] [--repeat 1]
// Credentials come only from CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (clef) and TYPESAFE_API_KEY (jev-1.13.0).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CLAIM_JUDGE_MODELS, judgeClaim } from "../claim-judge.ts";

if (process.env.PI_WEB_ACCESS_REAL_SEMANTIC !== "1") {
	console.error("This harness sends the fixture claims to Cloudflare and TypeSafe and is billed to your accounts. Set PI_WEB_ACCESS_REAL_SEMANTIC=1 to run it.");
	process.exit(2);
}

const { values } = parseArgs({ options: { models: { type: "string", default: Object.keys(CLAIM_JUDGE_MODELS).join(",") }, repeat: { type: "string", default: "1" } } });
const models = values.models.split(",").map((model) => model.trim()).filter(Boolean);
const repeat = Number(values.repeat);
for (const model of models) {
	if (!Object.hasOwn(CLAIM_JUDGE_MODELS, model)) throw new Error(`Unknown model ${model}; use ${Object.keys(CLAIM_JUDGE_MODELS).join(" or ")}`);
	const missing = CLAIM_JUDGE_MODELS[model].provider === "cloudflare"
		? ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"].filter((name) => !process.env[name]?.trim())
		: ["TYPESAFE_API_KEY"].filter((name) => !process.env[name]?.trim());
	if (missing.length) {
		console.error(`${model} needs ${missing.join(" and ")} in the environment.`);
		process.exit(2);
	}
}
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");

const LABELS = ["supported", "contradicted", "not_addressed"];
const fixtureSets = ["calibration", "holdout"].map((name) => ({
	name,
	claims: JSON.parse(readFileSync(new URL(`./fixtures/claims-${name}.json`, import.meta.url), "utf8")),
}));

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

for (const model of models) {
	for (const { name, claims } of fixtureSets) {
		const runs = [];
		for (let round = 0; round < repeat; round++) {
			for (const fixture of claims) {
				const passages = fixture.passages.map((passage, index) => ({ passage_id: passage.id, text: passage.text, source_url: `fixture:${fixture.id}`, source_rank: index + 1 }));
				const started = performance.now();
				const { assessment, error, probabilities } = await judgeClaim(model, fixture.claim, passages, {});
				const ms = performance.now() - started;
				runs.push({ round, fixture, assessment, error, ms, probabilities });
			}
		}

		const first = runs.filter((run) => run.round === 0);
		let passed = 0, wrongSupported = 0, wrongContradicted = 0, evidenceMatched = 0, verdicts = 0;
		const highestWrong = { supported: 0, contradicted: 0 };
		const failures = [];
		for (const run of first) {
			const { fixture, assessment, error, probabilities } = run;
			const want = fixture.expected === "not_addressed" ? "unclear" : fixture.expected;
			if (assessment.status === want) passed++;
			else failures.push(`${fixture.id}: want ${want}, got ${assessment.status}${error ? ` (${error})` : probabilities ? ` (${LABELS.map((label) => `${label} ${probabilities[label].toFixed(2)}`).join(", ")})` : ""}`);
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
			const base = first.find((candidate) => candidate.fixture.id === run.fixture.id)?.probabilities;
			if (base) drift = Math.max(drift, ...LABELS.map((label) => Math.abs(base[label] - run.probabilities[label])));
		}
		const latency = runs.map((run) => run.ms).sort((a, b) => a - b);
		const errors = runs.filter((run) => run.error).length;

		console.log(`\n${model} · ${name} (${claims.length} claims × ${repeat})`);
		console.log(`  pass ${passed}/${first.length}  wrong supported ${wrongSupported}  wrong contradicted ${wrongContradicted}  errors ${errors}`);
		console.log(`  highest wrong probability: supported ${highestWrong.supported.toFixed(2)}, contradicted ${highestWrong.contradicted.toFixed(2)}`);
		console.log(`  evidence matched ${evidenceMatched}/${verdicts}${repeat > 1 ? `  largest change across repeats ${drift.toFixed(2)}` : ""}`);
		console.log(`  latency p50 ${Math.round(percentile(latency, 0.5))} ms, p95 ${Math.round(percentile(latency, 0.95))} ms`);
		for (const failure of failures) console.log(`  FAIL ${failure}`);
	}
}
