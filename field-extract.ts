// fetch_content mode "extract": typed values read from a fetched page by Cloudflare's Clairic model.
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { redactCredential } from "./credential-source.ts";
import { fetchWithCredentialRedirects, isRecord } from "./utils.ts";

const MAX_FIELDS = 16;
const MAX_PAGE_CHARS = 200_000;
// Measured on the extraction fixtures: no wrong value reached 0.80, so lower confidence is shown only as a guess.
const EXTRACT_THRESHOLD = 0.8;
const TIMEOUT_MS = 30_000;
const DURATION_UNITS = ["seconds", "minutes", "hours", "days", "weeks", "months", "years"];

type ItemType = "text" | "number" | "date";
interface FieldSpec {
	type: "text" | "number" | "date" | "time" | "datetime" | "duration" | "list";
	integer?: true;
	unit?: string;
	items?: ItemType;
	instructions?: string;
}

export type FieldResult =
	| { status: "extracted"; value: unknown; confidence: number }
	| { status: "uncertain"; guess: unknown; confidence?: number }
	| { status: "null" };

export type PageExtraction =
	| { fields: Record<string, FieldResult>; cut: boolean }
	| { error: string };

export function parseExtractFields(fields: unknown): Record<string, FieldSpec> {
	if (!isRecord(fields)) throw new Error("fields must be an object mapping names to types");
	const entries = Object.entries(fields);
	if (entries.length === 0 || entries.length > MAX_FIELDS) throw new Error(`fields must list 1 to ${MAX_FIELDS} fields`);
	// No prototype, so a field named "__proto__" or "constructor" is an ordinary key.
	const specs: Record<string, FieldSpec> = Object.create(null);
	for (const [name, raw] of entries) {
		if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new Error(`field name "${name}" must be 1 to 64 letters, digits, or underscores`);
		if (typeof raw !== "string") throw new Error(`field ${name} must be a string such as "number" or "date: when it ships"`);
		const colon = raw.indexOf(":");
		const type = (colon === -1 ? raw : raw.slice(0, colon)).trim();
		const instructions = colon === -1 ? "" : raw.slice(colon + 1).trim();
		const [base, sub, extra] = type.split(".");
		let spec: FieldSpec | undefined;
		if (sub === undefined && ["text", "number", "date", "time", "datetime", "duration"].includes(base)) spec = { type: base as FieldSpec["type"] };
		else if (sub === undefined && base === "integer") spec = { type: "number", integer: true };
		else if (sub === undefined && base === "list") spec = { type: "list", items: "text" };
		else if (base === "duration" && DURATION_UNITS.includes(sub)) spec = { type: "duration", unit: sub };
		else if (base === "list" && (sub === "number" || sub === "date")) spec = { type: "list", items: sub };
		if (!spec || extra !== undefined) {
			throw new Error(`field ${name} has unknown type "${type}"; use text, number, integer, date, time, datetime, duration, duration.<${DURATION_UNITS.join("|")}>, list, list.number, or list.date`);
		}
		specs[name] = instructions ? { ...spec, instructions } : spec;
	}
	return specs;
}

function realDate(text: string): boolean {
	const [year, month, day] = text.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function realTime(text: string): boolean {
	const [hours, minutes, seconds = 0] = text.split(":").map(Number);
	return hours <= 23 && minutes <= 59 && seconds <= 59;
}

/** Whether the value has the field's type; dates and times must also exist on the calendar and clock. */
function matchesType(spec: FieldSpec, value: unknown): boolean {
	switch (spec.type) {
		case "text": return typeof value === "string" && value.trim() !== "";
		case "number": return typeof value === "number" && Number.isFinite(value) && (!spec.integer || Number.isInteger(value));
		case "duration": return typeof value === "number" && Number.isFinite(value) && value >= 0;
		case "date": return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && realDate(value);
		case "time": return typeof value === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(value) && realTime(value);
		case "datetime": {
			const match = typeof value === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-](\d{2}:\d{2}))?$/.exec(value) : null;
			return match !== null && realDate(match[1]) && realTime(match[2]) && (match[3] === undefined || realTime(match[3]));
		}
		case "list": return Array.isArray(value) && value.every((item) => matchesType({ type: spec.items! }, item));
	}
}

function fieldResult(spec: FieldSpec, answer: unknown): FieldResult {
	if (!isRecord(answer)) throw new Error("the response is invalid: a field answer is missing");
	// Clairic may send only p_null when nothing was found.
	const { value = null, confidence: rawConfidence } = answer;
	// A null value is Clairic's "not on the page" verdict; the guess it still sends then is a fallback, not evidence.
	if (value === null) return { status: "null" };
	const confidence = typeof rawConfidence === "number" && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : undefined;
	if (confidence !== undefined && confidence >= EXTRACT_THRESHOLD && matchesType(spec, value)) return { status: "extracted", value, confidence };
	return { status: "uncertain", guess: value, ...(confidence !== undefined ? { confidence } : {}) };
}

/**
 * Clairic is not in Pi's model catalog, so it is called directly with Pi's `cloudflare-workers-ai` credential.
 * When Pi has an AI Gateway id (`CLOUDFLARE_GATEWAY_ID`), the request goes through that gateway.
 */
async function runClairic(body: string, modelRegistry: Pick<ModelRegistry, "getProviderAuth"> | undefined, signal: AbortSignal): Promise<Record<string, unknown>> {
	if (!modelRegistry) throw new Error("extract mode runs only inside Pi");
	if (typeof modelRegistry.getProviderAuth !== "function") throw new Error("this Pi version cannot supply the Cloudflare credential; update Pi");
	const credential = await modelRegistry.getProviderAuth("cloudflare-workers-ai");
	const apiKey = credential?.auth.apiKey;
	const accountId = credential?.env?.CLOUDFLARE_ACCOUNT_ID;
	if (!apiKey || !accountId) throw new Error("Cloudflare Workers AI is not set up in Pi; set CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID");
	const gatewayId = (await modelRegistry.getProviderAuth("cloudflare-ai-gateway"))?.env?.CLOUDFLARE_GATEWAY_ID ?? process.env.CLOUDFLARE_GATEWAY_ID;
	let parsed: unknown;
	try {
		const response = await fetchWithCredentialRedirects(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/clairic`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(gatewayId ? { "cf-aig-gateway-id": gatewayId } : {}) },
			body,
			signal,
		}, ["Authorization"]);
		const text = await response.text();
		if (!response.ok) {
			// Redact before cutting, so a key straddling the cut can't leave a partial copy behind.
			const detail = redactCredential(text, apiKey).trim().slice(0, 200);
			throw new Error(`Cloudflare Workers AI returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
		}
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error("the response is invalid: it is not JSON");
		}
	} catch (err) {
		throw new Error(redactCredential(err instanceof Error ? err.message : String(err), apiKey));
	}
	if (!isRecord(parsed) || parsed.success !== true || !isRecord(parsed.result)) throw new Error("Cloudflare Workers AI reported an unsuccessful response");
	return parsed.result;
}

/** Provider failures, including Cloudflare not being set up in Pi, become `{ error }`; a caller abort is rethrown. */
export async function extractPageFields(
	page: string,
	fields: Record<string, FieldSpec>,
	context: { modelRegistry?: Pick<ModelRegistry, "getProviderAuth"> },
	signal?: AbortSignal,
	referenceDate = new Date().toISOString().slice(0, 10),
): Promise<PageExtraction> {
	const cut = page.length > MAX_PAGE_CHARS;
	const body = JSON.stringify({
		model: "clairic",
		state: cut ? page.slice(0, MAX_PAGE_CHARS) : page,
		fields,
		reference_date: referenceDate,
	});
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		const result = await runClairic(body, context.modelRegistry, signal ? AbortSignal.any([signal, timeout]) : timeout);
		const answers = result.answers;
		if (!isRecord(answers)) throw new Error("the response is invalid: answers are missing");
		const results = Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, fieldResult(spec, Object.hasOwn(answers, name) ? answers[name] : undefined)]));
		return { fields: results, cut: cut || result.truncated === true };
	} catch (err) {
		signal?.throwIfAborted();
		if (timeout.aborted) return { error: `timed out after ${TIMEOUT_MS / 1000} s` };
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

const MAX_SHOWN_VALUE_CHARS = 1_000;
// One long value must not push the other fields and pages out of the text the model sees.
const shown = (value: unknown) => {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > MAX_SHOWN_VALUE_CHARS ? `${text.slice(0, MAX_SHOWN_VALUE_CHARS)}… [${text.length} characters; the rest is in the stored page]` : text;
};

export function formatPageExtraction(extraction: PageExtraction): string {
	if ("error" in extraction) return `Extraction failed: ${extraction.error}\n`;
	const lines = Object.entries(extraction.fields).map(([name, result]) => {
		if (result.status === "extracted") return `${name}: ${shown(result.value)} (${result.confidence.toFixed(2)})`;
		if (result.status === "uncertain") return `${name}: uncertain (guess ${shown(result.guess)}${result.confidence !== undefined ? `, ${result.confidence.toFixed(2)}` : ""})`;
		return `${name}: not on the page`;
	});
	if (extraction.cut) lines.push(`(Only the first part of the page was read; it is longer than the model accepts.)`);
	return `${lines.join("\n")}\n`;
}
