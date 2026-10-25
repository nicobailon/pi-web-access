// Optional claim verdicts for source_check from a small classification model (Cloudflare Clef or TypeSafe Jev).
import { redactCredential, resolveCredential } from "./credential-source.ts";
import type { ClaimAssessment } from "./source-check.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath } from "./utils.ts";

const LABELS = ["supported", "contradicted", "not_addressed"] as const;
type Label = typeof LABELS[number];

// The question texts and thresholds were measured together on claim fixtures; change one only after re-measuring.
const VERDICT_INSTRUCTIONS = "Judge only from the passages. supported: a passage clearly states the claim or something that directly implies it. contradicted: a passage clearly states the opposite or an incompatible fact. not_addressed: anything else, including passages on the topic that do not settle the claim, weaker or stronger statements, another product or version, and rumors.";
const EVIDENCE_INSTRUCTIONS = "Which passage id best justifies the verdict? Answer none if the verdict is not_addressed.";

/** Only models with both thresholds measured on the claim fixtures belong here. */
export const CLAIM_JUDGE_MODELS = {
	clef: { provider: "cloudflare", thresholds: { supported: 0.85, contradicted: 0.85 } },
	"jev-1.13.0": { provider: "typesafe", thresholds: { supported: 0.85, contradicted: 0.90 } },
} as const;
export type ClaimJudgeModel = keyof typeof CLAIM_JUDGE_MODELS;

const TIMEOUT_MS = 10_000;
const MAX_PASSAGES = 48;
const MAX_STATE_BYTES = 24 * 1024;
const PROBABILITY_SUM_TOLERANCE = 0.02;
// Confidence of an unjudged "unclear" assessment, matching assessClaim.
const UNJUDGED_CONFIDENCE = 0.3;

/** A passage as the judge sees it; `source` is the title of the page it came from. */
export interface JudgePassage {
	id: string;
	source: string;
	text: string;
}

export interface ClaimJudgeCredentialConfig {
	cloudflareAccountId?: unknown;
	cloudflareApiToken?: unknown;
	typesafeApiKey?: unknown;
}

export interface ClaimJudgment {
	assessment: ClaimAssessment;
	/** Why the judge could not give a verdict; the assessment is then "unclear". */
	error?: string;
	/** The provider's verdict probabilities and cited evidence, present whenever it gave a valid answer. */
	probabilities?: Record<Label, number>;
	evidence?: string;
}

const choice = (instructions: string, labels: readonly string[]) => ({
	type: "choice",
	instructions,
	criteria: Object.fromEntries(labels.map((label) => [label, null])),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
	if (!values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1)) invalid("verdict probabilities must be numbers from 0 to 1");
	const sum = (values as number[]).reduce((total, value) => total + value, 0);
	if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) invalid("verdict probabilities do not sum to 1");
	return probabilities as Record<Label, number>;
}

async function requestJudge(
	model: ClaimJudgeModel,
	body: string,
	config: ClaimJudgeCredentialConfig,
	signal: AbortSignal,
): Promise<unknown> {
	const cloudflare = CLAIM_JUDGE_MODELS[model].provider === "cloudflare";
	const providerName = cloudflare ? "Cloudflare Workers AI" : "TypeSafe";
	let url: string;
	let token: string | null;
	if (cloudflare) {
		const accountId = await resolveCredential({ provider: providerName, configuredValue: config.cloudflareAccountId, environmentValue: process.env.CLOUDFLARE_ACCOUNT_ID, signal });
		token = await resolveCredential({ provider: providerName, configuredValue: config.cloudflareApiToken, environmentValue: process.env.CLOUDFLARE_API_TOKEN, signal });
		if (!accountId || !token) {
			throw new Error(`Cloudflare Workers AI credentials not found; set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or cloudflareAccountId and cloudflareApiToken in ${getWebSearchConfigPath()}`);
		}
		url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`;
	} else {
		token = await resolveCredential({ provider: providerName, configuredValue: config.typesafeApiKey, environmentValue: process.env.TYPESAFE_API_KEY, signal });
		if (!token) throw new Error(`TypeSafe API key not found; set TYPESAFE_API_KEY, or typesafeApiKey in ${getWebSearchConfigPath()}`);
		url = "https://api.typesafe.ai/v1/systemone";
	}
	try {
		const response = await fetchWithCredentialRedirects(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body,
			signal,
		}, ["Authorization"]);
		const text = await response.text();
		if (!response.ok) {
			// Redact before cutting, so a token straddling the cut can't leave a partial copy behind.
			const detail = redactCredential(text, token).trim().slice(0, 200);
			throw new Error(`${providerName} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			invalid("it is not JSON");
		}
		if (!cloudflare) return isRecord(parsed) ? parsed.answers : undefined;
		if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.result)) throw new Error(`${providerName} reported an unsuccessful response`);
		return parsed.result.answers;
	} catch (err) {
		throw new Error(redactCredential(err instanceof Error ? err.message : String(err), token));
	}
}

/**
 * Asks the model whether the passages support or contradict the claim. Reports a verdict only when its
 * probability reaches the model's threshold and the model cites a sent passage; anything else, including
 * every provider failure, is "unclear". A caller abort is rethrown.
 */
export async function judgeClaim(
	model: ClaimJudgeModel,
	claim: string,
	passages: JudgePassage[],
	config: ClaimJudgeCredentialConfig,
	signal?: AbortSignal,
): Promise<ClaimJudgment> {
	const sent: JudgePassage[] = [];
	for (const passage of passages.slice(0, MAX_PASSAGES)) {
		const entry = { id: passage.id, source: passage.source, text: passage.text };
		if (Buffer.byteLength(JSON.stringify({ claim, passages: [...sent, entry] }), "utf8") > MAX_STATE_BYTES) break;
		sent.push(entry);
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

	const ids = sent.map((passage) => passage.id);
	const body = JSON.stringify({
		model,
		state: { claim, passages: sent },
		questions: {
			verdict: choice(VERDICT_INSTRUCTIONS, LABELS),
			evidence: choice(EVIDENCE_INSTRUCTIONS, [...ids, "none"]),
		},
	});
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
	let probabilities: Record<Label, number>;
	let evidenceChoice: string;
	try {
		const answers = await requestJudge(model, body, config, signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal);
		if (!isRecord(answers)) invalid("answers are missing");
		probabilities = verdictProbabilities(validChoice(answers.verdict, LABELS, "verdict"));
		evidenceChoice = validChoice(answers.evidence, [...ids, "none"], "evidence").choice as string;
	} catch (err) {
		signal?.throwIfAborted();
		if (timeout.signal.aborted) return failed(`timed out after ${TIMEOUT_MS / 1000} s`);
		return failed(err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timer);
	}

	const thresholds = CLAIM_JUDGE_MODELS[model].thresholds;
	const verdict = evidenceChoice === "none" ? undefined : (["supported", "contradicted"] as const).find((label) => probabilities[label] >= thresholds[label]);
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
