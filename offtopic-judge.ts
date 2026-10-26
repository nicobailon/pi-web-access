// Asks a classifier model from Pi's catalog whether a search response addresses its query, for the
// searchRouting "off-topic" fallback (#619). eval/offtopic-judge.mjs measured the thresholds.
import type { ClassifierContext } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./utils.ts";

const LABELS = ["addresses", "off_topic"] as const;
type Label = typeof LABELS[number];

// Frozen after calibration (docs/offtopic-judge.md); change it only after re-measuring.
const INSTRUCTIONS = "A search engine returned this answer and these results for the query. addresses: the answer or at least one result is about what the query asks for, even if incomplete or outdated. off_topic: nothing is about what the query asks for, including results that only share words with it, a different meaning of the same word, or a different product.";

/** The only Pi classifier references accepted, each with its measured off_topic threshold (docs/offtopic-judge.md). */
export const OFFTOPIC_JUDGE_MODELS = {
	"cloudflare-workers-ai/@cf/cloudflare/clef": 0.85,
	"typesafe/jev-latest": 0.85,
	"cloudflare-workers-ai/typesafe/jev-1.14.0": 0.85,
} as const;
export type OffTopicJudgeModel = keyof typeof OFFTOPIC_JUDGE_MODELS;

export type OffTopicResult = { title: string; url: string; snippet: string };
export type OffTopicJudgment = { probabilities: Record<Label, number> } | { error: string };

const TIMEOUT_MS = 10_000;
const MAX_RESULTS = 10;
const MAX_ANSWER_CHARS = 4_000;
const MAX_SNIPPET_CHARS = 500;
const PROBABILITY_SUM_TOLERANCE = 0.02;

/** Returns the model's probabilities for "addresses" and "off_topic"; every model failure is an error, a caller abort is rethrown. */
export async function judgeOffTopic(
	model: OffTopicJudgeModel,
	query: string,
	response: { answer: string; results: OffTopicResult[] },
	modelRegistry: Pick<ModelRegistry, "findOfType" | "classify">,
	signal?: AbortSignal,
): Promise<OffTopicJudgment> {
	if (typeof modelRegistry.findOfType !== "function" || typeof modelRegistry.classify !== "function") return { error: "this Pi version cannot run classifier models; update Pi" };
	const slash = model.indexOf("/");
	const classifier = modelRegistry.findOfType("classifier", model.slice(0, slash), model.slice(slash + 1));
	if (!classifier) return { error: `${model} is not in this Pi's classifier catalog` };
	const context: ClassifierContext = {
		state: {
			query,
			answer: response.answer.slice(0, MAX_ANSWER_CHARS),
			results: response.results.slice(0, MAX_RESULTS).map(({ title, url, snippet }) => ({ title, url, snippet: snippet.slice(0, MAX_SNIPPET_CHARS) })),
		},
		// Null criteria: empty strings changed Clef's answers.
		questions: { relevance: { type: "choice", instructions: INSTRUCTIONS, criteria: { addresses: null, off_topic: null } as unknown as Record<string, string> } },
	};
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		const result = await modelRegistry.classify(classifier, context, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
		signal?.throwIfAborted();
		if (timeout.aborted) return { error: `timed out after ${TIMEOUT_MS / 1000} s` };
		if (result.stopReason !== "stop") return { error: result.errorMessage || `the model stopped with ${result.stopReason}` };
		const answer: unknown = result.answers?.relevance;
		const probabilities = isRecord(answer) ? answer.probabilities : undefined;
		if (!isRecord(answer) || !LABELS.includes(answer.choice as Label) || !isRecord(probabilities)) return { error: "the response is invalid: relevance choice is not one of its labels" };
		const keys = Object.keys(probabilities);
		const values = LABELS.map((label) => probabilities[label]);
		if (keys.length !== LABELS.length || !values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) {
			return { error: "the response is invalid: relevance probabilities do not match the labels" };
		}
		if (Math.abs((values as number[]).reduce((total, value) => total + value, 0) - 1) > PROBABILITY_SUM_TOLERANCE) return { error: "the response is invalid: relevance probabilities do not sum to 1" };
		return { probabilities: probabilities as Record<Label, number> };
	} catch (err) {
		signal?.throwIfAborted();
		if (timeout.aborted) return { error: `timed out after ${TIMEOUT_MS / 1000} s` };
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
