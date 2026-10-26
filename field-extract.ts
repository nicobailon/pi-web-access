// fetch_content mode "extract": typed values read from a fetched page by Cloudflare's Clairic model.
import type { JsonValue } from "@earendil-works/pi-ai";
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
	| { status: "extracted"; value: JsonValue; confidence: number; line?: string }
	| { status: "uncertain"; guess: JsonValue; confidence?: number; line?: string; notFound?: true }
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
	// The answer was parsed from Clairic's JSON response, so its value is JSON.
	const { value = null, confidence: rawConfidence } = answer as { value?: JsonValue; confidence?: unknown };
	// A null value is Clairic's "not on the page" verdict; the guess it still sends then is a fallback, not evidence.
	if (value === null) return { status: "null" };
	const confidence = typeof rawConfidence === "number" && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : undefined;
	if (confidence !== undefined && confidence >= EXTRACT_THRESHOLD && matchesType(spec, value)) return { status: "extracted", value, confidence };
	return { status: "uncertain", guess: value, ...(confidence !== undefined ? { confidence } : {}) };
}

const MAX_LINE_CHARS = 200;
// A link target longer than this is kept as text.
const MAX_LINK_TARGET_CHARS = 2_048;
// Thousands separators seen on pages: comma, period, space, no-break and narrow no-break space, apostrophe.
const SEPARATORS = new Set([",", ".", " ", " ", " ", "'"]);
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";

/** A line reduced for comparison, with the raw index each of its UTF-16 units came from. */
interface Comparable { text: string; map: number[] }

// For each "(" on the line, the index of its ")" when it closes within the link bound. One pass with a stack.
function closingParens(line: string): Map<number, number> {
	const close = new Map<number, number>();
	const open: number[] = [];
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "(") open.push(i);
		else if (line[i] === ")" && open.length) {
			const start = open.pop()!;
			if (i - start <= MAX_LINK_TARGET_CHARS) close.set(start, i);
		}
	}
	return close;
}

/**
 * One pass over the text: NFKC, lowercase, markdown backslash escapes removed (Turndown writes `my\_package`,
 * `\[beta\]`), curly quotes and dashes made plain, `* _ \` [ ]` dropped, whitespace collapsed. With `visible`, a
 * link or image target `](…)` (nested parentheses and a quoted title included) is skipped, leaving the text a reader sees.
 * The same steps run on the value, so matching only ever gets looser on the page side.
 */
function comparable(raw: string, visible: boolean): Comparable {
	const close = visible ? closingParens(raw) : undefined;
	let text = "";
	const map: number[] = [];
	let space = false;
	const emit = (chars: string, at: number) => {
		// A character whose NFKC form is much longer (U+FDFA is 18 characters) stays as it is, on both sides.
		const folded = chars.normalize("NFKC");
		for (const char of folded.length > 4 * chars.length ? chars : folded) {
			const plain = /[‘’‚‛′]/.test(char) ? "'" : /[“”„‟″]/.test(char) ? '"' : /[‐-―]/.test(char) ? "-" : char;
			if (/[*_`[\]]/.test(plain)) continue;
			if (/\s/.test(plain)) {
				if (text && !space) { text += " "; map.push(at); space = true; }
				continue;
			}
			const lower = plain.toLowerCase();
			text += lower;
			if (lower) space = false;
			for (let unit = 0; unit < lower.length; unit++) map.push(at);
		}
	};
	for (let i = 0; i < raw.length;) {
		if (raw[i] === "\\" && i + 1 < raw.length && /[!-/:-@[-`{-~]/.test(raw[i + 1])) {
			emit(raw[i + 1], i + 1);
			i += 2;
			continue;
		}
		const target = close && raw[i] === "]" && raw[i + 1] === "(" ? close.get(i + 1) : undefined;
		if (target !== undefined) {
			i = target + 1;
			continue;
		}
		// A character with its combining marks normalizes as one unit, so "e" + U+0301 meets "é".
		let next = i + String.fromCodePoint(raw.codePointAt(i)!).length;
		while (next < raw.length && /\p{M}/u.test(String.fromCodePoint(raw.codePointAt(next)!))) next += raw.codePointAt(next)! > 0xffff ? 2 : 1;
		emit(raw.slice(i, next), i);
		i = next;
	}
	if (space) { text = text.slice(0, -1); map.pop(); }
	return { text, map };
}

interface PageLines { lines: string[]; forms: Comparable[][]; whole: string[] }

function indexLines(page: string): PageLines {
	const lines = page.split("\n");
	// Without "](" there is no link target to skip, so both forms are the same.
	const forms = lines.map((line) => { const visible = comparable(line, true); return [visible, line.includes("](") ? comparable(line, false) : visible]; });
	// Both forms of every line joined, for a value that wraps onto the next line.
	const whole = [0, 1].map((form) => forms.map((pair) => pair[form].text).filter(Boolean).join(" "));
	return { lines, forms, whole };
}

/** The line, or a window of it that holds raw[start, end), at most MAX_LINE_CHARS including ellipses. */
function cite(line: string, start: number, end: number): string {
	if (line.length <= MAX_LINE_CHARS) return line.replace(/\s+/g, " ").trim();
	const size = MAX_LINE_CHARS - 2;
	const from = Math.max(0, Math.min(line.length - size, end - start >= size ? start : start - Math.floor((size - (end - start)) / 2)));
	return `${from > 0 ? "…" : ""}${line.slice(from, from + size).replace(/\s+/g, " ").trim()}${from + size < line.length ? "…" : ""}`;
}

/** undefined: not on the page; null: on the page with no single line to cite, or nothing comparable in the value. */
function locateText(value: string, page: PageLines): string | null | undefined {
	const wanted = comparable(value, false).text;
	if (!wanted) return null;
	for (const [index, pair] of page.forms.entries()) {
		for (const form of pair) {
			const at = form.text.indexOf(wanted);
			if (at !== -1) return cite(page.lines[index], form.map[at], form.map[at + wanted.length - 1] + 1);
		}
	}
	return page.whole.some((text) => text.includes(wanted)) ? null : undefined;
}

// The values a digit run with separators can mean: "1.299" is 1.299 or 1299, "1.299,00" is 1299, "5.3.1" is nothing.
function readings(groups: string[], separators: string[]): number[] {
	const thousands = (parts: string[]) => parts.slice(1).every((part) => part.length === 3);
	const values: number[] = [];
	if (thousands(groups)) values.push(Number(groups.join("")));
	const decimal = separators.at(-1);
	if ((decimal === "." || decimal === ",") && separators.slice(0, -1).every((separator) => separator !== decimal) && thousands(groups.slice(0, -1))) {
		values.push(Number(`${groups.slice(0, -1).join("")}.${groups.at(-1)}`));
	}
	return values;
}

/** The first line holding the whole number, sign included: 299 is not in "1 299", and -42 is not "42". */
function locateNumber(value: number, lines: string[]): string | undefined {
	for (const line of lines) {
		for (let i = 0; i < line.length;) {
			if (!isDigit(line[i])) { i++; continue; }
			const groups: string[] = [];
			const separators: string[] = [];
			let end = i;
			for (;;) {
				const from = end;
				while (isDigit(line[end])) end++;
				groups.push(line.slice(from, end));
				if (!SEPARATORS.has(line[end]) || !isDigit(line[end + 1])) break;
				separators.push(line[end]);
				end++;
			}
			// A minus, optionally before a currency sign, that does not join two words or numbers ("2026-11", "a-1").
			let sign = i - 1;
			if (/[$€£¥]/.test(line[sign] ?? "")) sign--;
			const negative = (line[sign] === "-" || line[sign] === "−") && !/[\p{L}\p{N}]/u.test(line[sign - 1] ?? "");
			if (readings(groups, separators).some((reading) => (negative ? -reading : reading) === value)) return cite(line, negative ? sign : i, end);
			i = end;
		}
	}
	return undefined;
}

/**
 * Adds the page line a text or number value was found on (dates, times and durations are rewritten by Clairic, so
 * they have none). A number match only cites; it never changes the status.
 */
function withPageLine(spec: FieldSpec, result: FieldResult, page: () => PageLines): FieldResult {
	if (result.status === "null") return result;
	const value = result.status === "extracted" ? result.value : result.guess;
	if (spec.type === "number" && typeof value === "number") {
		const line = locateNumber(value, page().lines);
		return line ? { ...result, line } : result;
	}
	if (spec.type !== "text" || typeof value !== "string") return result;
	const line = locateText(value, page());
	if (line) return { ...result, line };
	// Text that is not on the page was not read from it, however confident the model is.
	if (line === undefined && result.status === "extracted") return { status: "uncertain", guess: result.value, confidence: result.confidence, notFound: true };
	return result;
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
	const state = cut ? page.slice(0, MAX_PAGE_CHARS) : page;
	const body = JSON.stringify({
		model: "clairic",
		state,
		fields,
		reference_date: referenceDate,
	});
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	try {
		const result = await runClairic(body, context.modelRegistry, signal ? AbortSignal.any([signal, timeout]) : timeout);
		const answers = result.answers;
		if (!isRecord(answers)) throw new Error("the response is invalid: answers are missing");
		let lines: PageLines | undefined;
		const page = () => lines ??= indexLines(state);
		const results = Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, withPageLine(spec, fieldResult(spec, Object.hasOwn(answers, name) ? answers[name] : undefined), page)]));
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
		const from = result.status !== "null" && result.line ? ` from "${result.line}"` : "";
		if (result.status === "extracted") return `${name}: ${shown(result.value)} (${result.confidence.toFixed(2)})${from}`;
		if (result.status === "uncertain") return `${name}: uncertain (guess ${shown(result.guess)}${result.confidence !== undefined ? `, ${result.confidence.toFixed(2)}` : ""}${result.notFound ? "; not found on the page" : ""})${from}`;
		return `${name}: not on the page`;
	});
	if (extraction.cut) lines.push(`(Only the first part of the page was read; it is longer than the model accepts.)`);
	return `${lines.join("\n")}\n`;
}
