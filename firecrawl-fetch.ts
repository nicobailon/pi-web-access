import { activityMonitor } from "./activity.js";
import { getFirecrawlConfig } from "./firecrawl-config.js";
import { extractHeadingTitle, type ExtractedContent } from "./extract.js";

export async function extractWithFirecrawl(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const config = getFirecrawlConfig();
	if (!config) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `firecrawl: ${url}` });

	try {
		const res = await fetch(`${config.baseUrl}/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				url,
				formats: ["markdown"],
				onlyMainContent: true,
			}),
			signal: AbortSignal.any([
				AbortSignal.timeout(60000),
				...(signal ? [signal] : []),
			]),
		});

		if (!res.ok) {
			const errorText = await res.text();
			throw new Error(`Firecrawl scrape error ${res.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await res.json() as FirecrawlScrapeResponse;

		if (data.error) {
			throw new Error(`Firecrawl scrape error: ${data.error}`);
		}

		const markdown = data.markdown || data.content || "";
		if (!markdown || markdown.length < 50) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}

		activityMonitor.logComplete(activityId, res.status);

		const title = data.title ?? extractHeadingTitle(markdown) ?? (new URL(url).pathname.split("/").pop() || url);
		return { url, title, content: markdown, error: null };
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

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: {
		markdown?: string;
		content?: string;
		title?: string;
		metadata?: {
			title?: string;
			description?: string;
			keywords?: string[];
			robots?: string;
			fontFamily?: string;
			fontWeight?: string;
		};
	};
	markdown?: string;
	content?: string;
	title?: string;
	error?: string;
}
