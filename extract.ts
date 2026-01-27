import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { activityMonitor } from "./activity.js";
import { extractRSCContent } from "./rsc-extract.js";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.js";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; pi-agent/1.0)",
				Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
		});

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		// Check content length to avoid memory issues with huge responses
		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const isPDFContent = isPDF(url, contentType);
		const maxResponseSize = isPDFContent ? 20 * 1024 * 1024 : 5 * 1024 * 1024; // 20MB for PDFs, 5MB otherwise
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseSize) {
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: "",
					content: "",
					error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
				};
			}
		}

		// Handle PDFs - extract and save to markdown file
		if (isPDFContent) {
			try {
				const buffer = await response.arrayBuffer();
				const result = await extractPDFToMarkdown(buffer, url);
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}
		
		// Reject binary/non-text content types
		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}
		
		// Return plain text directly without Readability
		const urlHostname = new URL(url).hostname;
		const isPlainText = contentType.includes("text/plain") || 
			urlHostname === "raw.githubusercontent.com" ||
			urlHostname === "gist.githubusercontent.com";

		const text = await response.text();

		if (isPlainText) {
			activityMonitor.logComplete(activityId, response.status);
			const content = text;
			// Extract filename from URL as title
			const urlPath = new URL(url).pathname;
			const title = urlPath.split("/").pop() || url;
			return { url, title, content, error: null };
		}

		const html = text;
		const { document } = parseHTML(html);

		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article) {
			// Fallback: Try extracting from RSC flight data (Next.js App Router)
			const rscResult = extractRSCContent(html);
			if (rscResult) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}
			
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: "Could not extract readable content",
			};
		}

		const markdown = turndown.turndown(article.content);

		activityMonitor.logComplete(activityId, response.status);
		return {
			url,
			title: article.title || "",
			content: markdown,
			error: null,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(() => extractContent(url, signal, timeoutMs))));
}
