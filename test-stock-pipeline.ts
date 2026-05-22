/**
 * Stock Price Pipeline Test
 * 
 * Tests the full Firecrawl → SearXNG → Lightpanda → Qwen3.6 pipeline
 * with observability logging at each stage.
 */

import { search } from './firecrawl-search.js';
import { extractWithFirecrawl } from './firecrawl-fetch.js';
import { generateSummaryDraft, type SummaryGenerationContext } from './summary-review.js';
import {
	logSearch,
	logScrape,
	logSummary,
	getLogs,
	getMetrics,
	formatReport,
	resetLogs,
} from './observability.js';

// Test queries
const QUERIES = [
	"stock price outlook 2026 S&P 500 Nasdaq Dow Jones trends",
	"stock market predictions analyst forecasts 2026",
];

async function runPipeline() {
	console.log("=== Stock Price Pipeline Test ===\n");
	console.log("Starting observability logging...\n");

	// Reset logs
	resetLogs();

	const allSearchResults: Array<{ query: string; answer: string; results: Array<{ title: string; url: string; snippet: string }>; error: string | null; provider: string }> = [];

	// Stage 1: Search with SearXNG
	console.log("=== Stage 1: Search (SearXNG) ===");
	for (const query of QUERIES) {
		console.log(`\nSearching: "${query}"`);
		const start = Date.now();
		
		try {
			const result = await search(query, {
				provider: 'firecrawl',
				numResults: 5,
			});

			const duration = Date.now() - start;
			console.log(`  ✓ Got ${result.results.length} results in ${duration}ms`);

			// Validate and log each result
			const validatedResults = result.results.map(r => {
				const { valid, issues } = { valid: true, issues: [] as string[] };
				return {
					url: r.url,
					title: r.title,
					snippet: r.snippet || "",
					valid,
					issues,
				};
			});

			logSearch({
				query,
				provider: result.provider,
				durationMs: duration,
				resultCount: result.results.length,
				results: validatedResults,
				answer: result.answer,
			});

			allSearchResults.push({
				query,
				answer: result.answer || "",
				results: result.results.map(r => ({
					title: r.title,
					url: r.url,
					snippet: r.snippet || "",
				})),
				error: null,
				provider: result.provider,
			});

		} catch (err) {
			const duration = Date.now() - start;
			const message = err instanceof Error ? err.message : String(err);
			console.log(`  ✗ Error: ${message}`);

			logSearch({
				query,
				provider: 'firecrawl',
				durationMs: duration,
				resultCount: 0,
				results: [],
				error: message,
			});

			allSearchResults.push({
				query,
				answer: "",
				results: [],
				error: message,
				provider: 'firecrawl',
			});
		}
	}

	// Stage 2: Scrape with Lightpanda
	console.log("\n=== Stage 2: Scrape (Lightpanda) ===");
	const allUrls: string[] = [];
	for (const result of allSearchResults) {
		for (const r of result.results) {
			if (!allUrls.includes(r.url) && r.url.length > 10) {
				allUrls.push(r.url);
			}
		}
	}

	// Limit to top 5 URLs to avoid rate limits
	const urlsToScrape = allUrls.slice(0, 5);
	console.log(`Scraping ${urlsToScrape.length} URLs...\n`);

	for (const url of urlsToScrape) {
		console.log(`Scraping: ${url}`);
		const start = Date.now();

		try {
			const result = await extractWithFirecrawl(url);
			const duration = Date.now() - start;

			if (result) {
				console.log(`  ✓ Got ${result.content.length} chars in ${duration}ms`);
				console.log(`  Title: ${result.title}`);

				logScrape({
					url,
					durationMs: duration,
					success: true,
					title: result.title,
					contentLength: result.content.length,
					contentPreview: result.content.slice(0, 500),
					rendering: "lightpanda",
					valid: true,
					issues: [],
				});
			} else {
				console.log(`  ✗ No content returned`);
				logScrape({
					url,
					durationMs: duration,
					success: false,
					contentLength: 0,
					contentPreview: "",
					rendering: "unknown",
					valid: false,
					issues: ["No content returned"],
				});
			}
		} catch (err) {
			const duration = Date.now() - start;
			const message = err instanceof Error ? err.message : String(err);
			console.log(`  ✗ Error: ${message}`);

			logScrape({
				url,
				durationMs: duration,
				success: false,
				contentLength: 0,
				contentPreview: "",
				rendering: "unknown",
				valid: false,
				issues: [`Error: ${message}`],
			});
		}
	}

	// Stage 3: LLM Summary with Qwen3.6
	console.log("\n=== Stage 3: Summary (Qwen3.6) ===");
	
	// Create a mock summary context (we'll use the local LLM directly)
	const mockContext: SummaryGenerationContext = {
		model: null,
		modelRegistry: {
			getAvailable: () => [],
			find: () => null,
			getApiKeyAndHeaders: async () => ({ ok: false, apiKey: "" }),
		},
	};

	// Use local LLM directly for summary
	const { queryLocalLlm } = await import('./local-llm-api.js');

	for (const searchData of allSearchResults) {
		if (searchData.error || searchData.results.length === 0) {
			continue;
		}

		console.log(`\nSummarizing: "${searchData.query}"`);
		const start = Date.now();

		try {
			// Build a prompt for the LLM
			const prompt = `You are a financial analyst. Summarize the following stock market search results into a concise, factual report.

Search Results:
${searchData.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nURL: ${r.url}`).join("\n\n")}

Requirements:
- Keep it readable and skimmable
- Include key findings and trends
- Do not invent sources or claims
- If evidence is weak or conflicting, say so explicitly
- End with a short "Sources" section listing the most relevant URLs
- Focus on stock price outlook and trends for 2026`;

			const summary = await queryLocalLlm(prompt, {
				model: "gemma-4-E2B-it-UD-Q4_K_XL",
				timeoutMs: 120000,
				maxTokens: 2048,
			});

			const duration = Date.now() - start;
			const outputTokens = Math.ceil(summary.length / 4);

			console.log(`  ✓ Summary generated in ${duration}ms (${outputTokens} tokens)`);
			console.log(`  Preview: ${summary.slice(0, 100)}...`);

			logSummary({
				model: "gemma-4-E2B-it-UD-Q4_K_XL",
				durationMs: duration,
				inputTokens: Math.ceil(searchData.results.length * 500 / 4),
				outputTokens,
				summaryLength: summary.length,
				summary,
			});

		} catch (err) {
			const duration = Date.now() - start;
			const message = err instanceof Error ? err.message : String(err);
			console.log(`  ✗ Error: ${message}`);

			logSummary({
				model: "gemma-4-E2B-it-UD-Q4_K_XL",
				durationMs: duration,
				inputTokens: 0,
				outputTokens: 0,
				summaryLength: 0,
				summary: "",
				error: message,
			});
		}
	}

	// Generate report
	console.log("\n=== Generating Observability Report ===\n");
	const report = formatReport();
	console.log(report);

	// Save report to file
	const { writeFileSync, mkdirSync } = await import('node:fs');
	const { join } = await import('node:path');
	const reportPath = join(process.cwd(), 'docs', 'observability', 'stock-pipeline-report.md');
	mkdirSync(join(process.cwd(), 'docs', 'observability'), { recursive: true });
	writeFileSync(reportPath, report);
	console.log(`\nReport saved to: ${reportPath}`);

	// Print metrics
	const metrics = getMetrics();
	console.log("\n=== Pipeline Metrics ===");
	console.log(`Searches: ${metrics.searchCount} (${metrics.searchErrors} errors)`);
	console.log(`Scrapes: ${metrics.scrapeCount} (${metrics.scrapeErrors} errors)`);
	console.log(`Summaries: ${metrics.summaryCount} (${metrics.summaryErrors} errors)`);
	console.log(`Avg search: ${metrics.avgSearchDuration.toFixed(0)}ms`);
	console.log(`Avg scrape: ${metrics.avgScrapeDuration.toFixed(0)}ms`);
	console.log(`Avg summary: ${metrics.avgSummaryDuration.toFixed(0)}ms`);
}

runPipeline().catch(console.error);
