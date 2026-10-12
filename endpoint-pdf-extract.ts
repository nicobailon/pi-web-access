import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fetchRemoteUrl, loadSsrfConfig, type Lookup } from "./ssrf-protection.ts";
import { getWebSearchConfigPath, isLoopbackHostname } from "./utils.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_POLL_INTERVAL_MS = 3_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 300;
const CONFIG_PATH = getWebSearchConfigPath();

export interface EndpointPDFExtractOptions {
	maxPages: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	lookup?: Lookup;
}

export interface EndpointPDFExtractResult {
	markdown: string;
	pages?: number;
}

function pdfSection(): Record<string, unknown> {
	if (!existsSync(CONFIG_PATH)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
	const pdf = (parsed as { pdf?: unknown } | null)?.pdf;
	return pdf && typeof pdf === "object" ? (pdf as Record<string, unknown>) : {};
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

/**
 * Null means the provider is not configured. Trailing slashes are stripped so the
 * relative `jobs/<id>` poll URL resolves beside the parse path.
 */
export function getEndpointUrl(): string | null {
	const configured =
		normalizeString(process.env.PDF_ENDPOINT_URL) ??
		normalizeString(pdfSection().endpointUrl);
	if (!configured) return null;
	const protocol = URL.parse(configured)?.protocol;
	if (protocol !== "http:" && protocol !== "https:") {
		throw new Error(
			`Failed to parse pdf.endpointUrl: expected an absolute http(s) URL, got "${configured}"`,
		);
	}
	return configured.replace(/\/+$/, "");
}

function getEndpointTimeoutMs(): number {
	const configured = pdfSection().endpointTimeoutMs;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
		return Math.min(configured, 300_000);
	}
	return DEFAULT_TIMEOUT_MS;
}

export function isEndpointApiAvailable(): boolean {
	try {
		return getEndpointUrl() !== null;
	} catch {
		// A malformed URL is surfaced as a fatal config error by the extract
		// call itself; availability only reports whether it is configured.
		return true;
	}
}

/**
 * Read at most `maxBytes`, cancelling the stream at the cap. Error previews
 * keep the prefix; JSON bodies past the cap are an error.
 */
async function readCapped(response: Response, maxBytes: number, overflowThrows: boolean): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let text = "";
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		const room = maxBytes - received;
		received += value.byteLength;
		// Stop at exactly the cap too: a full preview must not wait on a parser that stalls after it.
		if (received >= maxBytes) {
			await reader.cancel();
			if (overflowThrows && received > maxBytes) {
				throw new Error("PDF parser endpoint returned an oversized response");
			}
			return text + decoder.decode(value.subarray(0, room));
		}
		text += decoder.decode(value, { stream: true });
	}
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	const text = await readCapped(response, MAX_RESPONSE_BYTES, true);
	try {
		const parsed = JSON.parse(text) as unknown;
		if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
	} catch {
		// fall through to the shared error below
	}
	throw new Error("PDF parser endpoint returned a non-JSON response");
}

async function errorBody(response: Response): Promise<string> {
	try {
		const text = await readCapped(response, MAX_ERROR_BODY_BYTES, false);
		return text ? `: ${text}` : "";
	} catch {
		return "";
	}
}

function markdownResult(payload: Record<string, unknown>): EndpointPDFExtractResult {
	// Strip NULs (leaked by PDF text layers with broken encodings) before the emptiness
	// check: NUL-only output is an empty conversion and must fail so the chain falls back.
	const markdown = typeof payload.markdown === "string" ? payload.markdown.replaceAll("\x00", "") : "";
	if (markdown.trim().length === 0) {
		const error = normalizeString(payload.error);
		throw new Error(
			error ? `PDF parser endpoint failed: ${error}` : "PDF parser endpoint returned no markdown",
		);
	}
	return { markdown, pages: typeof payload.pages === "number" ? payload.pages : undefined };
}

/**
 * POST the PDF as multipart `file`. A `{ markdown }` answer completes at once; a
 * `{ job_id }` answer is polled at `jobs/{id}` until `done`, `error`, or the deadline.
 */
export async function extractPDFViaEndpoint(
	buffer: ArrayBuffer,
	options: EndpointPDFExtractOptions,
): Promise<EndpointPDFExtractResult> {
	options.signal?.throwIfAborted();
	const endpointUrl = getEndpointUrl();
	if (!endpointUrl) {
		throw new Error("PDF endpoint extraction requires a configured pdf.endpointUrl");
	}

	const ssrf = loadSsrfConfig();
	// The parser URL is user-configured, like firecrawlBaseUrl, so loopback is allowed;
	// LAN ranges still need ssrf.allowRanges, and every redirect hop is re-validated.
	const guard = {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		allowLoopback: isLoopbackHostname(new URL(endpointUrl).hostname),
		...(options.lookup ? { lookup: options.lookup } : {}),
	};

	const engine = normalizeString(pdfSection().endpointEngine);
	const form = new FormData();
	form.append("file", new Blob([buffer], { type: "application/pdf" }), "document.pdf");
	if (engine) form.append("engine", engine);
	form.append("max_pages", String(options.maxPages));

	const timeoutMs = options.timeoutMs ?? getEndpointTimeoutMs();
	const deadline = Date.now() + timeoutMs;
	const signal = options.signal;
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

	const response = await fetchRemoteUrl(
		endpointUrl,
		{ method: "POST", body: form, signal: combined },
		guard,
	);
	if (!response.ok) {
		throw new Error(
			`PDF parser endpoint returned HTTP ${response.status}${await errorBody(response)}`,
		);
	}

	let payload = await readJson(response);
	const jobId = normalizeString(payload.job_id);
	if (typeof payload.markdown === "string" || !jobId) {
		return markdownResult(payload);
	}

	const jobsUrl = new URL(`jobs/${encodeURIComponent(jobId)}`, endpointUrl).toString();
	for (let interval = 1_000; Date.now() < deadline; interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS)) {
		await sleep(Math.min(interval, deadline - Date.now()), undefined, { signal });

		const poll = await fetchRemoteUrl(jobsUrl, { signal: combined }, guard);
		if (!poll.ok) {
			throw new Error(
				`PDF parser job status returned HTTP ${poll.status}${await errorBody(poll)}`,
			);
		}
		payload = await readJson(poll);
		const status = normalizeString(payload.status)?.toLowerCase();
		if (status === "error" || status === "failed") {
			const error = normalizeString(payload.error) ?? "unknown parser error";
			throw new Error(`PDF parser endpoint job failed: ${error}`);
		}
		if (status === "done") {
			let result = payload.result;
			if (typeof result === "string") {
				const raw = result;
				try {
					result = JSON.parse(raw);
				} catch {
					// Only a genuinely non-JSON body is raw markdown; a malformed JSON
					// payload must fail so the chain falls back.
					return { markdown: raw.replaceAll("\x00", "") };
				}
			}
			if (result && typeof result === "object") return markdownResult(result as Record<string, unknown>);
			throw new Error("PDF parser endpoint job completed without a result");
		}
	}
	throw new Error("PDF parser endpoint job timed out");
}
