import { activityMonitor } from "./activity.js";
import { getFirecrawlConfig } from "./firecrawl-config.js";
import { extractHeadingTitle, type ExtractedContent } from "./extract.js";

interface FirecrawlScrapeResponse {
	success: boolean;
	data?: {
		markdown?: string;
		title?: string;
		description?: string;
		metadata?: {
			title?: string;
			description?: string;
			url?: string;
			statusCode?: number;
			[key: string]: unknown;
		};
	};
	error?: string;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

export async function extractWithFirecrawl(
	url: string,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	const config = await getFirecrawlConfig();
	if (!config) return null;

	const activityId = activityMonitor.logStart({ type: "api", query: `firecrawl: ${url}` });

	try {
		const body = {
			url,
			formats: ["markdown"],
			onlyMainContent: true,
		};

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

		const fetchSignal = signal
			? AbortSignal.any([signal, controller.signal])
			: controller.signal;

		const res = await fetch(`${config.baseUrl}/v1/scrape`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
			},
			body: JSON.stringify(body),
			signal: fetchSignal,
		});

		clearTimeout(timeoutId);

		if (!res.ok) {
			const errorText = await res.text();
			activityMonitor.logComplete(activityId, res.status);
			return {
				url,
				title: "",
				content: "",
				error: `Firecrawl scrape error ${res.status}: ${errorText.slice(0, 200)}`,
			};
		}

		const data = (await res.json()) as FirecrawlScrapeResponse;
		activityMonitor.logComplete(activityId, res.status);

		if (!data.success || !data.data || !data.data.markdown) {
			return null;
		}

		const markdown = data.data.markdown.trim();
		if (markdown.length < 50) return null;

		// Extract title from metadata or markdown
		const metadataTitle = data.data.metadata?.title ?? data.data.title;
		const title = metadataTitle
			? extractHeadingTitle(markdown) ?? metadataTitle
			: extractHeadingTitle(markdown) ?? (new URL(url).pathname.split("/").pop() || url);

		return {
			url,
			title,
			content: markdown,
			error: null,
		};
	} catch (err) {
		const message = errorMessage(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return null;
	}
}
