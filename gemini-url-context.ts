import { activityMonitor } from "./activity.js";
import { getApiKey, API_BASE, DEFAULT_MODEL } from "./gemini-api.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { extractHeadingTitle, type ExtractedContent } from "./extract.js";

const EXTRACTION_PROMPT = `Extract the complete readable content from this URL as clean markdown.
Include the page title, all text content, code blocks, and tables.
Do not summarize — extract the full content.

URL: `;

export async function extractWithUrlContext(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const apiKey = getApiKey();
	if (!apiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `url_context: ${url}` });

	try {
		const model = DEFAULT_MODEL;
		const body = {
			contents: [{ parts: [{ text: EXTRACTION_PROMPT + url }] }],
			tools: [{ url_context: {} }],
		};

		const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		const data = await res.json() as UrlContextResponse;
		activityMonitor.logComplete(activityId, res.status);

		const metadata = data.candidates?.[0]?.url_context_metadata;
		if (metadata?.url_metadata?.length) {
			const status = metadata.url_metadata[0].url_retrieval_status;
			if (status === "URL_RETRIEVAL_STATUS_UNSAFE" || status === "URL_RETRIEVAL_STATUS_ERROR") {
				return null;
			}
		}

		const content = data.candidates?.[0]?.content?.parts
			?.map(p => p.text).filter(Boolean).join("\n") ?? "";

		if (!content || content.length < 50) return null;

		const title = extractTitleFromContent(content, url);
		return { url, title, content, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

export async function extractWithGeminiWeb(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `gemini_web: ${url}` });

	try {
		const text = await queryWithCookies(EXTRACTION_PROMPT + url, cookies, {
			model: "gemini-2.5-flash",
			signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		if (!text || text.length < 50) return null;

		const title = extractTitleFromContent(text, url);
		return { url, title, content: text, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}

function extractTitleFromContent(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

interface UrlContextResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		url_context_metadata?: {
			url_metadata?: Array<{
				retrieved_url?: string;
				url_retrieval_status?: string;
			}>;
		};
	}>;
}
