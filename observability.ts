/**
 * Observability & Logging System for Firecrawl Pipeline
 * 
 * Tracks three stages:
 * 1. Search results (SearXNG validation)
 * 2. Scraping results (Lightpanda rendering validation)
 * 3. LLM summary results (Gemma 4 quality validation)
 */

export interface SearchLogEntry {
	type: "search";
	timestamp: number;
	query: string;
	provider: string;
	durationMs: number;
	resultCount: number;
	results: Array<{
		url: string;
		title: string;
		snippet: string;
		valid: boolean;
		issues: string[];
	}>;
	answer?: string;
	error?: string;
}

export interface ScrapeLogEntry {
	type: "scrape";
	timestamp: number;
	url: string;
	durationMs: number;
	success: boolean;
	title?: string;
	contentLength: number;
	contentPreview: string;
	rendering: "non-js" | "lightpanda" | "unknown";
	valid: boolean;
	issues: string[];
	quality: {
		hasHeadings: boolean;
		hasLinks: boolean;
		hasParagraphs: boolean;
		hasCode: boolean;
		hasTables: boolean;
		textDensity: number; // chars per 1000 chars
		llmFriendly: boolean;
	};
}

export interface SummaryLogEntry {
	type: "summary";
	timestamp: number;
	model: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	summaryLength: number;
	quality: {
		hasStructure: boolean;
		hasSources: boolean;
		hasFindings: boolean;
		hasCaveats: boolean;
		readability: "excellent" | "good" | "fair" | "poor";
		factual: boolean;
	};
	summary: string;
	error?: string;
}

export type PipelineLogEntry = SearchLogEntry | ScrapeLogEntry | SummaryLogEntry;

interface PipelineMetrics {
	searchCount: number;
	scrapeCount: number;
	summaryCount: number;
	searchErrors: number;
	scrapeErrors: number;
	summaryErrors: number;
	avgSearchDuration: number;
	avgScrapeDuration: number;
	avgSummaryDuration: number;
	totalSearchResults: number;
	totalScrapedContent: number;
}

const logs: PipelineLogEntry[] = [];
const metrics: PipelineMetrics = {
	searchCount: 0,
	scrapeCount: 0,
	summaryCount: 0,
	searchErrors: 0,
	scrapeErrors: 0,
	summaryErrors: 0,
	avgSearchDuration: 0,
	avgScrapeDuration: 0,
	avgSummaryDuration: 0,
	totalSearchResults: 0,
	totalScrapedContent: 0,
};

let searchDurations: number[] = [];
let scrapeDurations: number[] = [];
let summaryDurations: number[] = [];

/**
 * Validate SearXNG search results
 */
function validateSearchResult(result: { url: string; title: string; snippet: string }): { valid: boolean; issues: string[] } {
	const issues: string[] = [];
	let valid = true;

	// URL validation
	try {
		new URL(result.url);
	} catch {
		issues.push("Invalid URL format");
		valid = false;
	}

	// Title validation
	if (!result.title || result.title.length < 3) {
		issues.push("Title too short or missing");
		valid = false;
	}

	// Snippet validation
	if (!result.snippet || result.snippet.length < 10) {
		issues.push("Snippet too short or missing");
		// Not critical, just a warning
	}

	// Domain validation
	const domain = new URL(result.url).hostname;
	if (domain.includes("example.com") || domain.includes("localhost")) {
		issues.push("Test domain in results");
	}

	return { valid, issues };
}

/**
 * Validate Lightpanda scraping results
 */
function validateScrapeResult(content: string, title?: string): {
	valid: boolean;
	issues: string[];
	quality: ScrapeLogEntry["quality"];
	rendering: "non-js" | "lightpanda" | "unknown";
} {
	const issues: string[] = [];
	let valid = true;

	const quality = {
		hasHeadings: content.match(/^#{1,6}\s/m) !== null,
		hasLinks: content.match(/\[.*?\]\(.*?\)/) !== null,
		hasParagraphs: (content.match(/\n\n/g) || []).length >= 2,
		hasCode: content.match(/```/) !== null || content.match(/`[^`]+`/) !== null,
		hasTables: content.match(/\|.*\|.*\|/) !== null,
		textDensity: content.replace(/\s/g, "").length / Math.max(content.length, 1),
		llmFriendly: true,
	};

	// Content length validation
	if (content.length < 100) {
		issues.push("Content too short (< 100 chars)");
		valid = false;
	}

	// Title validation
	if (!title || title.length < 3) {
		issues.push("Title too short or missing");
	}

	// LLM friendliness checks
	if (!quality.hasHeadings) {
		issues.push("No headings found - structure may be poor");
	}
	if (!quality.hasParagraphs) {
		issues.push("No paragraph breaks - may be hard to parse");
	}
	if (quality.textDensity < 0.3) {
		issues.push("Low text density - may be mostly whitespace or markup");
		quality.llmFriendly = false;
	}

	// Check for common rendering issues
	if (content.includes("403") || content.includes("blocked") || content.includes("captcha")) {
		issues.push("Page appears blocked or requires authentication");
		valid = false;
	}

	// Detect rendering method from content patterns
	let rendering: "non-js" | "lightpanda" | "unknown" = "unknown";
	if (content.includes("data-turbo") || content.includes("__NEXT_DATA__") || content.includes("data-react")) {
		rendering = "lightpanda";
	} else {
		rendering = "non-js";
	}

	return { valid, issues, quality, rendering };
}

/**
 * Validate LLM summary quality
 */
function validateSummary(summary: string, model: string): {
	quality: SummaryLogEntry["quality"];
	issues: string[];
} {
	const issues: string[] = [];
	const quality = {
		hasStructure: summary.match(/^#{1,6}\s/m) !== null || summary.includes("\n\n"),
		hasSources: /\bSources?\s*:/i.test(summary),
		hasFindings: /\b(findings?|conclusion|summary|overview)\b/i.test(summary),
		hasCaveats: /\b(caveat|limitation|uncertain|conflict|disclaimer)\b/i.test(summary),
		readability: "good" as const,
		factual: true,
	};

	// Length validation
	if (summary.length < 50) {
		quality.readability = "poor";
	} else if (summary.length < 200) {
		quality.readability = "fair";
	} else if (summary.length > 2000) {
		quality.readability = "good";
	} else {
		quality.readability = "excellent";
	}

	// Structure validation
	if (!quality.hasStructure) {
		issues.push("No document structure found");
	}
	if (!quality.hasSources) {
		issues.push("No sources section");
	}

	return { quality, issues };
}

/**
 * Log a search result
 */
export function logSearch(entry: Omit<SearchLogEntry, "type" | "timestamp">): void {
	const logEntry: SearchLogEntry = {
		...entry,
		type: "search",
		timestamp: Date.now(),
	};

	logs.push(logEntry);
	metrics.searchCount++;
	metrics.totalSearchResults += entry.resultCount;
	if (entry.error) metrics.searchErrors++;

	searchDurations.push(entry.durationMs);
	metrics.avgSearchDuration = searchDurations.reduce((a, b) => a + b, 0) / searchDurations.length;
}

/**
 * Log a scrape result
 */
export function logScrape(entry: Omit<ScrapeLogEntry, "type" | "timestamp">): void {
	const validation = validateScrapeResult(entry.contentPreview, entry.title);
	
	const logEntry: ScrapeLogEntry = {
		...entry,
		type: "scrape",
		timestamp: Date.now(),
		rendering: entry.rendering || validation.rendering,
		valid: entry.valid && validation.valid,
		issues: [...entry.issues, ...validation.issues],
		quality: validation.quality,
	};

	logs.push(logEntry);
	metrics.scrapeCount++;
	if (!logEntry.valid) metrics.scrapeErrors++;

	metrics.totalScrapedContent += entry.contentLength;
	scrapeDurations.push(entry.durationMs);
	metrics.avgScrapeDuration = scrapeDurations.reduce((a, b) => a + b, 0) / scrapeDurations.length;
}

/**
 * Log a summary result
 */
export function logSummary(entry: Omit<SummaryLogEntry, "type" | "timestamp">): void {
	const validation = validateSummary(entry.summary, entry.model);

	const logEntry: SummaryLogEntry = {
		...entry,
		type: "summary",
		timestamp: Date.now(),
		quality: validation.quality,
	};

	logs.push(logEntry);
	metrics.summaryCount++;
	if (entry.error) metrics.summaryErrors++;

	summaryDurations.push(entry.durationMs);
	metrics.avgSummaryDuration = summaryDurations.reduce((a, b) => a + b, 0) / summaryDurations.length;
}

/**
 * Get all logs
 */
export function getLogs(): PipelineLogEntry[] {
	return [...logs];
}

/**
 * Get metrics summary
 */
export function getMetrics(): PipelineMetrics {
	return { ...metrics };
}

/**
 * Format logs as markdown report
 */
export function formatReport(): string {
	const lines: string[] = [];

	lines.push("# Firecrawl Pipeline Observability Report\n");
	lines.push(`Generated: ${new Date().toISOString()}\n`);

	// Metrics summary
	lines.push("## Metrics Summary\n");
	lines.push(`- Search queries: ${metrics.searchCount} (${metrics.searchErrors} errors)`);
	lines.push(`- Scrapes: ${metrics.scrapeCount} (${metrics.scrapeErrors} errors)`);
	lines.push(`- Summaries: ${metrics.summaryCount} (${metrics.summaryErrors} errors)`);
	lines.push(`- Avg search duration: ${metrics.avgSearchDuration.toFixed(0)}ms`);
	lines.push(`- Avg scrape duration: ${metrics.avgScrapeDuration.toFixed(0)}ms`);
	lines.push(`- Avg summary duration: ${metrics.avgSummaryDuration.toFixed(0)}ms`);
	lines.push(`- Total search results: ${metrics.totalSearchResults}`);
	lines.push(`- Total scraped content: ${metrics.totalScrapedContent.toLocaleString()} chars\n`);

	// Search logs
	if (logs.some(l => l.type === "search")) {
		lines.push("## Search Results (SearXNG)\n");
		const searchLogs = logs.filter(l => l.type === "search") as SearchLogEntry[];
		for (const log of searchLogs) {
			lines.push(`### Query: "${log.query}"`);
			lines.push(`- Provider: ${log.provider}`);
			lines.push(`- Duration: ${log.durationMs}ms`);
			lines.push(`- Results: ${log.resultCount}`);
			if (log.error) lines.push(`- **ERROR**: ${log.error}`);
			if (log.answer) lines.push(`- Answer: ${log.answer.slice(0, 200)}...`);
			lines.push("");
			for (const result of log.results) {
				const status = result.valid ? "✓" : "✗";
				lines.push(`- ${status} [${result.title}](${result.url})`);
				if (result.snippet) lines.push(`  Snippet: ${result.snippet.slice(0, 100)}`);
				if (result.issues.length > 0) {
					lines.push(`  Issues: ${result.issues.join(", ")}`);
				}
			}
			lines.push("");
		}
	}

	// Scrape logs
	if (logs.some(l => l.type === "scrape")) {
		lines.push("## Scraping Results (Lightpanda)\n");
		const scrapeLogs = logs.filter(l => l.type === "scrape") as ScrapeLogEntry[];
		for (const log of scrapeLogs) {
			const status = log.valid ? "✓" : "✗";
			lines.push(`### ${log.url}`);
			lines.push(`- Title: ${log.title || "N/A"}`);
			lines.push(`- Duration: ${log.durationMs}ms`);
			lines.push(`- Content: ${log.contentLength.toLocaleString()} chars`);
			lines.push(`- Rendering: ${log.rendering}`);
			lines.push(`- Quality: headings=${log.quality.hasHeadings}, links=${log.quality.hasLinks}, paragraphs=${log.quality.hasParagraphs}, code=${log.quality.hasCode}, tables=${log.quality.hasTables}`);
			lines.push(`- LLM Friendly: ${log.quality.llmFriendly ? "✓" : "✗"}`);
			if (log.issues.length > 0) {
				lines.push(`- **Issues**: ${log.issues.join(", ")}`);
			}
			lines.push(`- Preview: ${log.contentPreview.slice(0, 200)}`);
			lines.push("");
		}
	}

	// Summary logs
	if (logs.some(l => l.type === "summary")) {
		lines.push("## Summary Results (Gemma 4)\n");
		const summaryLogs = logs.filter(l => l.type === "summary") as SummaryLogEntry[];
		for (const log of summaryLogs) {
			const status = log.error ? "✗" : "✓";
			lines.push(`### Summary`);
			lines.push(`- Model: ${log.model}`);
			lines.push(`- Duration: ${log.durationMs}ms`);
			lines.push(`- Output: ${log.summaryLength.toLocaleString()} chars`);
			lines.push(`- Readability: ${log.quality.readability}`);
			lines.push(`- Structure: ${log.quality.hasStructure ? "✓" : "✗"}, Sources: ${log.quality.hasSources ? "✓" : "✗"}`);
			lines.push(`- Findings: ${log.quality.hasFindings ? "✓" : "✗"}, Caveats: ${log.quality.hasCaveats ? "✓" : "✗"}`);
			if (log.error) {
				lines.push(`- **ERROR**: ${log.error}`);
			} else {
				lines.push(`- Summary:\n\`\`\`\n${log.summary}\n\`\`\``);
			}
			lines.push("");
		}
	}

	// Debug recommendations
	lines.push("## Debug & Optimization Recommendations\n");
	const issues = logs.flatMap(l => l.type === "search" ? (l as SearchLogEntry).results.flatMap(r => r.issues) : l.type === "scrape" ? (l as ScrapeLogEntry).issues : []);
	const uniqueIssues = [...new Set(issues)];
	
	if (uniqueIssues.length > 0) {
		lines.push("### Common Issues Found:\n");
		for (const issue of uniqueIssues.slice(0, 10)) {
			lines.push(`- ${issue}`);
		}
	} else {
		lines.push("No critical issues found. Pipeline is healthy.\n");
	}

	lines.push("### Optimization Opportunities:\n");
	if (metrics.avgSearchDuration > 5000) {
		lines.push("- Search duration high (>5s) - consider caching or reducing result count");
	}
	if (metrics.avgScrapeDuration > 10000) {
		lines.push("- Scrape duration high (>10s) - verify Lightpanda is being used, not Playwright");
	}
	if (metrics.scrapeErrors > 0) {
		lines.push("- Scrape errors detected - check for blocked pages or authentication requirements");
	}
	if (metrics.summaryErrors > 0) {
		lines.push("- Summary generation failed - verify LLM endpoint is reachable");
	}

	return lines.join("\n");
}

/**
 * Reset logs
 */
export function resetLogs(): void {
	logs.length = 0;
	searchDurations = [];
	scrapeDurations = [];
	summaryDurations = [];
	Object.assign(metrics, {
		searchCount: 0,
		scrapeCount: 0,
		summaryCount: 0,
		searchErrors: 0,
		scrapeErrors: 0,
		summaryErrors: 0,
		avgSearchDuration: 0,
		avgScrapeDuration: 0,
		avgSummaryDuration: 0,
		totalSearchResults: 0,
		totalScrapedContent: 0,
	});
}
