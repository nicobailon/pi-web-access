// Optional claim verdicts for source_check from a classifier model in Pi's catalog (Cloudflare Clef or TypeSafe Jev).
import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ClaimAssessment } from "./source-check.ts";
import { isRecord } from "./utils.ts";

const LABELS = ["supported", "contradicted", "not_addressed"] as const;
type Label = typeof LABELS[number];

// The question texts and thresholds were measured together on claim fixtures; change one only after re-measuring.
const VERDICT_INSTRUCTIONS = "Judge only from the passages. supported: a passage clearly states the claim or something that directly implies it. contradicted: a passage clearly states the opposite or an incompatible fact. not_addressed: anything else, including passages on the topic that do not settle the claim, weaker or stronger statements, another product or version, and rumors.";
const EVIDENCE_INSTRUCTIONS = "Which passage id best justifies the verdict? Answer none if the verdict is not_addressed.";

/** The only Pi classifier references accepted. */
export const CLAIM_JUDGE_MODELS = {
	"cloudflare-workers-ai/@cf/cloudflare/clef": { supported: 0.85, contradicted: 0.87 },
	"openrouter/cloudflare/clef": { supported: 0.85, contradicted: 0.87 },
	"typesafe/jev-latest": { supported: 0.88, contradicted: 0.85 },
	"openrouter/typesafe/jev-1.14": { supported: 0.88, contradicted: 0.85 },
	"cloudflare-workers-ai/typesafe/jev-1.14.0": { supported: 0.88, contradicted: 0.85 },
	"openrouter/typesafe/jev-1.13": { supported: 0.85, contradicted: 0.90 },
} as const;
export type ClaimJudgeModel = keyof typeof CLAIM_JUDGE_MODELS;

export type ClaimJudgeRegistry = Pick<ModelRegistry, "findOfType" | "classify">;

const TIMEOUT_MS = 10_000;
const MAX_PASSAGES = 48;
const MAX_STATE_BYTES = 24 * 1024;
const PROBABILITY_SUM_TOLERANCE = 0.02;
// Confidence of an unjudged "unclear" assessment, matching assessClaim.
const UNJUDGED_CONFIDENCE = 0.3;

/** A passage as the judge sees it; `source` is the title of the page it came from. A type alias, so it fits Pi's JSON state type. */
export type JudgePassage = { id: string; source: string; text: string };

export interface ClaimJudgment {
	assessment: ClaimAssessment;
	/** Why the judge could not give a verdict; the assessment is then "unclear". */
	error?: string;
	/** The model's verdict probabilities and cited evidence, present whenever it gave a valid answer. */
	probabilities?: Record<Label, number>;
	evidence?: string;
}

// Criteria values are null, as measured; empty strings measurably changed Clef's answers.
const choice = (instructions: string, labels: readonly string[]) => ({
	type: "choice" as const,
	instructions,
	criteria: Object.fromEntries(labels.map((label) => [label, null])) as unknown as Record<string, string>,
});

function invalid(reason: string): never {
	throw new Error(`the response is invalid: ${reason}`);
}

function validChoice(answer: unknown, labels: readonly string[], name: string): Record<string, unknown> {
	if (!isRecord(answer) || typeof answer.choice !== "string" || !labels.includes(answer.choice)) invalid(`${name} choice is not one of its labels`);
	return answer;
}

function verdictProbabilities(answer: Record<string, unknown>): Record<Label, number> {
	const probabilities = answer.probabilities;
	if (!isRecord(probabilities)) invalid("verdict probabilities are missing");
	const keys = Object.keys(probabilities);
	if (keys.length !== LABELS.length || !LABELS.every((label) => keys.includes(label))) invalid("verdict probabilities do not match the labels");
	const values = LABELS.map((label) => probabilities[label]);
	if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) invalid("verdict probabilities must be numbers from 0 to 1");
	const sum = values.reduce((total, value) => total + value, 0);
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) invalid("verdict probabilities do not sum to 1");
	return probabilities as Record<Label, number>;
}

/**
 * Asks the model whether the passages support or contradict the claim. Reports a verdict only when its
 * probability reaches the model's threshold and the model cites a sent passage; anything else, including
 * every model failure, is "unclear". A caller abort is rethrown.
 */
export async function judgeClaim(
	model: ClaimJudgeModel,
	claim: string,
	passages: JudgePassage[],
	modelRegistry: ClaimJudgeRegistry,
	signal?: AbortSignal,
): Promise<ClaimJudgment> {
	const sent: JudgePassage[] = [];
	for (const passage of passages.slice(0, MAX_PASSAGES)) {
		if (Buffer.byteLength(JSON.stringify({ claim, passages: [...sent, passage] }), "utf8") > MAX_STATE_BYTES) break;
		sent.push(passage);
	}
	const omitted = passages.length - sent.length;
	const failed = (reason: string): ClaimJudgment => ({
		assessment: {
			claim,
			status: "unclear",
			supporting_passages: [],
			contradicting_passages: [],
			rationale: `Claim judge ${model} failed: ${reason}; review the passages.`,
			confidence: UNJUDGED_CONFIDENCE,
		},
		error: reason,
	});
	if (sent.length === 0) return failed(`the claim and its first passage exceed the ${MAX_STATE_BYTES / 1024} KB request limit`);
	if (typeof modelRegistry.findOfType !== "function" || typeof modelRegistry.classify !== "function") {
		return failed("this Pi version cannot run classifier models; update Pi");
	}
	const slash = model.indexOf("/");
	const classifier = modelRegistry.findOfType("classifier", model.slice(0, slash), model.slice(slash + 1));
	if (!classifier) return failed(`${model} is not in this Pi's classifier catalog`);

	const ids = sent.map((passage) => passage.id);
	const context: ClassifierContext = {
		state: { claim, passages: sent },
		questions: {
			verdict: choice(VERDICT_INSTRUCTIONS, LABELS),
			evidence: choice(EVIDENCE_INSTRUCTIONS, [...ids, "none"]),
		},
	};
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
	let probabilities: Record<Label, number>;
	let evidenceChoice: string;
	try {
		const result = await modelRegistry.classify(classifier, context, { signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal });
		signal?.throwIfAborted();
		if (timeout.signal.aborted) return failed(`timed out after ${TIMEOUT_MS / 1000} s`);
		if (result.stopReason !== "stop") return failed(result.errorMessage || `the model stopped with ${result.stopReason}`);
		const answers: unknown = result.answers;
		if (!isRecord(answers)) invalid("answers are missing");
		probabilities = verdictProbabilities(validChoice(answers.verdict, LABELS, "verdict"));
		evidenceChoice = validChoice(answers.evidence, [...ids, "none"], "evidence").choice as string;
	} catch (err) {
		signal?.throwIfAborted();
		return failed(err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timer);
	}

	const verdict = evidenceChoice === "none" ? undefined : (["supported", "contradicted"] as const).find((label) => probabilities[label] >= CLAIM_JUDGE_MODELS[model][label]);
	const scores = LABELS.map((label) => `${label} ${probabilities[label].toFixed(2)}`).join(", ");
	const leftOut = omitted > 0 ? ` ${omitted} passage${omitted === 1 ? " was" : "s were"} left out to fit the request limit.` : "";
	return {
		assessment: {
			claim,
			status: verdict ?? "unclear",
			supporting_passages: verdict === "supported" ? [evidenceChoice] : [],
			contradicting_passages: verdict === "contradicted" ? [evidenceChoice] : [],
			rationale: `Claim judge ${model}: ${scores}; evidence ${evidenceChoice}.${verdict ? "" : " No verdict reached its threshold with a cited passage; review the passages."}${leftOut}`,
			confidence: verdict ? probabilities[verdict] : Math.max(...LABELS.map((label) => probabilities[label])),
		},
		probabilities,
		evidence: evidenceChoice,
	};
}
