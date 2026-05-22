/**
 * Debug & Optimize Firecrawl Pipeline
 * 
 * Based on observability data from stock price pipeline test.
 */

import { getLogs, getMetrics, formatReport } from './observability.js';

console.log("=== Debug & Optimize Analysis ===\n");

const logs = getLogs();
const metrics = getMetrics();

// 1. Analyze search quality
console.log("## 1. Search Quality (SearXNG)");
const searchLogs = logs.filter(l => l.type === "search");
for (const log of searchLogs) {
  const s = log as any;
  console.log(`Query: "${s.query}"`);
  console.log(`  Results: ${s.resultCount}, Duration: ${s.durationMs}ms`);
  console.log(`  Answer provided: ${s.answer ? "✓" : "✗"}`);
  if (s.answer) {
    console.log(`  Answer length: ${s.answer.length} chars`);
    console.log(`  Answer preview: ${s.answer.slice(0, 100)}...`);
  }
}

// 2. Analyze scrape quality
console.log("\n## 2. Scrape Quality (Lightpanda)");
const scrapeLogs = logs.filter(l => l.type === "scrape");
for (const log of scrapeLogs) {
  const s = log as any;
  console.log(`URL: ${s.url}`);
  console.log(`  Duration: ${s.durationMs}ms, Content: ${s.contentLength} chars`);
  console.log(`  Rendering: ${s.rendering}`);
  console.log(`  Valid: ${s.valid ? "✓" : "✗"}`);
  console.log(`  Issues: ${s.issues.join(", ") || "None"}`);
  console.log(`  Quality: headings=${s.quality.hasHeadings}, links=${s.quality.hasLinks}, paragraphs=${s.quality.hasParagraphs}`);
  console.log(`  LLM Friendly: ${s.quality.llmFriendly ? "✓" : "✗"}`);
}

// 3. Analyze summary quality
console.log("\n## 3. Summary Quality (Gemma 4)");
const summaryLogs = logs.filter(l => l.type === "summary");
for (const log of summaryLogs) {
  const s = log as any;
  console.log(`Model: ${s.model}`);
  console.log(`  Duration: ${s.durationMs}ms, Output: ${s.summaryLength} chars`);
  console.log(`  Readability: ${s.quality.readability}`);
  console.log(`  Structure: ${s.quality.hasStructure ? "✓" : "✗"}`);
  console.log(`  Sources: ${s.quality.hasSources ? "✓" : "✗"}`);
  console.log(`  Findings: ${s.quality.hasFindings ? "✓" : "✗"}`);
  console.log(`  Caveats: ${s.quality.hasCaveats ? "✓" : "✗"}`);
  if (s.error) {
    console.log(`  ERROR: ${s.error}`);
  }
}

// 4. Optimization recommendations
console.log("\n## 4. Optimization Recommendations\n");

console.log("### Critical Issues:");
const issues = scrapeLogs.flatMap(l => (l as any).issues);
const uniqueIssues = [...new Set(issues)];
if (uniqueIssues.length > 0) {
  for (const issue of uniqueIssues) {
    console.log(`- ${issue}`);
  }
} else {
  console.log("- No critical issues");
}

console.log("\n### Performance Optimizations:");
if (metrics.avgSearchDuration > 2000) {
  console.log("- Search duration high (>2s) - SearXNG may be slow, consider caching");
}
if (metrics.avgScrapeDuration > 1000) {
  console.log("- Scrape duration moderate (>1s) - Lightpanda is working, consider parallel scraping");
}
if (metrics.avgSummaryDuration > 30000) {
  console.log("- Summary duration high (>30s) - Gemma 4 is slow, consider:");
  console.log("  * Using a smaller model variant");
  console.log("  * Reducing maxTokens");
  console.log("  * Implementing response streaming");
}

console.log("\n### Quality Optimizations:");
const failedScrapes = scrapeLogs.filter(l => !(l as any).valid);
if (failedScrapes.length > 0) {
  console.log(`- ${failedScrapes.length} scrape(s) failed - investigate blocked pages (Forbes)`);
}
const noHeadings = scrapeLogs.filter(l => !(l as any).quality.hasHeadings);
if (noHeadings.length > 0) {
  console.log(`- ${noHeadings.length} scrape(s) have no headings - Lightpanda heading extraction needs improvement`);
}
const noCaveats = summaryLogs.filter(l => !(l as any).quality.hasCaveats);
if (noCaveats.length > 0) {
  console.log(`- ${noCaveats.length} summary(s) lack caveats - improve LLM prompt to include risk/disclaimer requirements`);
}

console.log("\n### Code Changes Needed:");
console.log("1. Add parallel scraping for multiple URLs (concurrent Lightpanda requests)");
console.log("2. Improve Lightpanda heading extraction (check --strip-mode flags)");
console.log("3. Add retry logic for failed scrapes (Forbes, etc.)");
console.log("4. Optimize Gemma 4 prompt for better source/caveat inclusion");
console.log("5. Implement response streaming for faster perceived latency");
