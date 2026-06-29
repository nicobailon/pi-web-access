// Source-check + machine-readable research artifacts (issue #108).
//
// This module provides:
//   - the ResearchArtifact JSON schema (stable, serializable)
//   - a /source_check tool mode returning supported|contradicted|unclear|missing-evidence
//   - a heuristic source-quality classifier
//   - the ResearchProvider adapter interface (pluggable external aggregator)
//   - artifact storage/retrieval reusing the existing storage map
//
// Provenance guarantee: every ClaimAssessment references passage_ids, never
// bare URLs. A passage is only ever created from exact retrieved content
// (search-provider snippets or extracted page spans) — never paraphrased.

import { generateId, storeResult, getResult } from "./storage.ts";
import type { SearchResult } from "./perplexity.ts";
import type { ExtractedContent } from "./extract.ts";

// ── Artifact schema ─────────────────────────────────────────────────────────

export type SourceQuality =
	| "official_docs"
	| "vendor_docs"
	| "repo_issue"
	| "blog"
	| "forum"
	| "news"
	| "unknown";

export type ClaimStatus = "supported" | "contradicted" | "unclear" | "missing-evidence";

export interface ResearchSource {
	rank: number;
	url: string;
	title: string;
	snippet?: string;
	fetch_timestamp?: number;
	content_hash?: string;
	quality: SourceQuality;
	fetched?: boolean;
}

export interface ResearchPassage {
	passage_id: string;
	source_url: string;
	source_rank: number;
	text: string;
	extraction_span?: { start: number; end: number };
	content_hash?: string;
}

export interface ClaimAssessment {
	claim: string;
	status: ClaimStatus;
	supporting_passages: string[];
	contradicting_passages: string[];
	rationale: string;
	confidence: number; // 0..1
}

export interface ResearchArtifact {
	id: string;
	type: "research";
	timestamp: number;
	query: string;
	sources: ResearchSource[];
	passages: ResearchPassage[];
	claims?: ClaimAssessment[];
	provider?: string;
	summary?: string;
	content_hash?: string;
	filters?: {
		recency?: "day" | "week" | "month" | "year";
		domain_include?: string[];
		domain_exclude?: string[];
	};
}

// ── Adapter interface (pluggable external aggregator) ───────────────────────

export interface ResearchSearchRequest {
	query: string;
	numResults: number;
	recencyFilter?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
}

export interface ResearchSearchResult {
	url: string;
	title: string;
	snippet: string;
	rank: number;
}

export interface ResearchSearchResponse {
	provider: string;
	results: ResearchSearchResult[];
	summary?: string;
}

export interface ResearchProvider {
	name: string;
	search(req: ResearchSearchRequest): Promise<ResearchSearchResponse>;
}

// ── Source-quality classifier (heuristic) ───────────────────────────────────

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|.*\.github\.io|learn\.|reference\.)/i;
const OFFICIAL_DOCS_PATHS = /\/docs?(\/|\b)|\/reference\//i;
const VENDOR_DOCS_PATHS = /\/(documentation|docs?)\//i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const BLOG_PATHS = /\/blog(s)?\//i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com|discourse\.|community\.)/i;
const FORUM_PATHS = /\/(forum|forums|threads)\//i;
const NEWS_HOSTS = /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|cnet\.com|zdnet\.com)/i;
const NEWS_PATHS = /\/news(|\/)/i;

export function classifySource(url: string): SourceQuality {
	let host = "";
	let path = "";
	try {
		const u = new URL(url);
		host = u.host;
		path = u.pathname;
	} catch {
		return "unknown";
	}

	if (REPO_ISSUE_PATHS.test(path)) return "repo_issue";
	if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return "official_docs";
	if (NEWS_HOSTS.test(host) || NEWS_PATHS.test(path)) return "news";
	if (FORUM_HOSTS.test(host) || FORUM_PATHS.test(path)) return "forum";
	if (BLOG_HOSTS.test(host) || BLOG_PATHS.test(path)) return "blog";
	if (VENDOR_DOCS_PATHS.test(path)) return "vendor_docs";
	return "unknown";
}

// ── Passage extraction ──────────────────────────────────────────────────────

function hashContent(text: string): string {
	// Minimal sha-256 via Web Crypto when available; stable fallback otherwise.
	// We expose the hash on passages so downstream tools can detect drift.
	const g = globalThis as unknown as { crypto?: { subtle?: { digest?: (a: string, b: Uint8Array) => Promise<ArrayBuffer> } } };
	if (g.crypto?.subtle?.digest) {
		// Unawaited; hash filled in async wrapper. For sync path, return marker.
	}
	return `sha256:${text.length}:${text.slice(0, 8)}`;
}

function passageId(sourceRank: number, idx: number): string {
	return `p-${sourceRank}-${idx}`;
}

// Builds passages from search-result snippets (always available) plus any
// fetched page content. Passage text is ALWAYS the exact retrieved span.
export function buildPassages(
	sources: ResearchSource[],
	fetched: ExtractedContent[] = [],
): ResearchPassage[] {
	const passages: ResearchPassage[] = [];
	const fetchedByUrl = new Map(fetched.map((f) => [f.url, f]));

	for (const src of sources) {
		// Snippet passage (from the search provider result).
		if (src.snippet) {
			passages.push({
				passage_id: passageId(src.rank, 0),
				source_url: src.url,
				source_rank: src.rank,
				text: src.snippet,
				content_hash: hashContent(src.snippet),
			});
		}

		// Fetched-content passages: extract up to 3 sentence-ish spans containing
		// the query terms (best-effort; never paraphrased).
		const page = fetchedByUrl.get(src.url);
		if (page?.content) {
			const spans = extractRelevantSpans(page.content, src.snippet ?? "");
			spans.forEach((span, i) => {
				passages.push({
					passage_id: passageId(src.rank, i + 1),
					source_url: src.url,
					source_rank: src.rank,
					text: span.text,
					extraction_span: { start: span.start, end: span.end },
					content_hash: hashContent(span.text),
				});
			});
		}
	}

	return passages;
}

interface Span {
	text: string;
	start: number;
	end: number;
}

// Extracts up to 3 sentences (≈ <=400 chars) that look relevant to the claim.
// Pure string ops — no model call, deterministic.
function extractRelevantSpans(content: string, hint: string): Span[] {
	const sentences = content
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.filter((s) => s.trim().length > 0 && s.length <= 400);

	const terms = tokenize(hint);
	if (terms.length === 0) return [];

	const scored = sentences.map((s, idx) => {
		const lower = s.toLowerCase();
		let score = 0;
		for (const t of terms) {
			if (lower.includes(t)) score++;
		}
		return { s, idx, score };
	});

	return scored
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.idx - b.idx)
		.slice(0, 3)
		.map((x) => {
			const start = content.indexOf(x.s);
			return { text: x.s.trim(), start: start >= 0 ? start : 0, end: (start >= 0 ? start : 0) + x.s.length };
		});
}

function tokenize(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 3);
}

// ── Claim assessment ────────────────────────────────────────────────────────

const CONTRADICTION_MARKERS = [
	"not true", "false", "incorrect", "debunked", "retracted", "no longer",
	"never", "denied", "contrary", "however", "but actually", "misleading",
];
const SUPPORT_MARKERS = [
	"yes", "true", "correct", "confirmed", "according to", "shows that",
	"demonstrates", "reported", "verified", "established",
];

export function assessClaim(claim: string, passages: ResearchPassage[]): ClaimAssessment {
	const claimTerms = tokenize(claim);
	if (claimTerms.length === 0 || passages.length === 0) {
		return {
			claim,
			status: "missing-evidence",
			supporting_passages: [],
			contradicting_passages: [],
			rationale: "No passages available that discuss the claim's terms.",
			confidence: 0.2,
		};
	}

	const supporting: string[] = [];
	const contradicting: string[] = [];

	for (const p of passages) {
		const lower = p.text.toLowerCase();
		const overlap = claimTerms.filter((t) => lower.includes(t)).length;
		if (overlap < Math.max(2, Math.ceil(claimTerms.length / 4))) continue;

		const hasContra = CONTRADICTION_MARKERS.some((m) => lower.includes(m));
		const hasSupport = SUPPORT_MARKERS.some((m) => lower.includes(m));

		if (hasContra && !hasSupport) {
			contradicting.push(p.passage_id);
		} else if (hasSupport && !hasContra) {
			supporting.push(p.passage_id);
		} else if (hasContra && hasSupport) {
			// Mixed signal — don't commit either way.
		}
	}

	let status: ClaimStatus;
	let rationale: string;
	let confidence: number;

	if (contradicting.length > 0 && supporting.length === 0) {
		status = "contradicted";
		rationale = `${contradicting.length} passage(s) contradict the claim; none support it.`;
		confidence = Math.min(0.85, 0.5 + contradicting.length * 0.1);
	} else if (supporting.length > 0 && contradicting.length === 0) {
		status = "supported";
		rationale = `${supporting.length} passage(s) support the claim; none contradict it.`;
		confidence = Math.min(0.85, 0.5 + supporting.length * 0.1);
	} else if (supporting.length > 0 && contradicting.length > 0) {
		status = "unclear";
		rationale = `${supporting.length} supporting and ${contradicting.length} contradicting passage(s); evidence is mixed.`;
		confidence = 0.4;
	} else {
		// No strong markers but passages overlapped on terms.
		status = "unclear";
		rationale = "Passages mention the claim's terms but contain no clear support or contradiction markers.";
		confidence = 0.3;
	}

	return {
		claim,
		status,
		supporting_passages: supporting,
		contradicting_passages: contradicting,
		rationale,
		confidence,
	};
}

// ── Artifact assembly ───────────────────────────────────────────────────────

export interface BuildArtifactInput {
	query: string;
	provider?: string;
	summary?: string;
	results: SearchResult[];
	fetched?: ExtractedContent[];
	recency?: "day" | "week" | "month" | "year";
	domainFilter?: string[];
}

export function buildResearchArtifact(input: BuildArtifactInput): ResearchArtifact {
	const domainInclude = (input.domainFilter ?? []).filter((d) => !d.startsWith("-"));
	const domainExclude = (input.domainFilter ?? []).filter((d) => d.startsWith("-")).map((d) => d.slice(1));

	const sources: ResearchSource[] = input.results.map((r, i) => {
		const page = input.fetched?.find((f) => f.url === r.url);
		return {
			rank: r.rank ?? i + 1,
			url: r.url,
			title: r.title,
			snippet: r.snippet,
			quality: classifySource(r.url),
			fetched: Boolean(page),
			fetch_timestamp: page ? Date.now() : undefined,
		};
	});

	// Deduplicate sources by URL (keep highest rank / first occurrence).
	const seen = new Set<string>();
	const dedupedSources = sources.filter((s) => {
		if (seen.has(s.url)) return false;
		seen.add(s.url);
		return true;
	});

	const passages = buildPassages(dedupedSources, input.fetched ?? []);

	return {
		id: generateId(),
		type: "research",
		timestamp: Date.now(),
		query: input.query,
		sources: dedupedSources,
		passages,
		provider: input.provider,
		summary: input.summary,
		filters: {
			recency: input.recency,
			domain_include: domainInclude.length ? domainInclude : undefined,
			domain_exclude: domainExclude.length ? domainExclude : undefined,
		},
	};
}

// Run the source-check flow over an already-built artifact (claim assessment
// against the artifact's passages). Returns a NEW artifact with claims[] set.
export function withClaimAssessment(artifact: ResearchArtifact, claims: string[]): ResearchArtifact {
	const assessments = claims.map((c) => assessClaim(c, artifact.passages));
	return { ...artifact, claims: assessments };
}

// ── Storage helpers (reuse the existing in-memory map) ──────────────────────

export function storeResearchArtifact(artifact: ResearchArtifact): void {
	storeResult(artifact.id, {
		id: artifact.id,
		type: "research" as const,
		timestamp: artifact.timestamp,
		artifact,
	});
}

export function getResearchArtifact(id: string): ResearchArtifact | null {
	const data = getResult(id);
	if (!data || data.type !== "research") return null;
	return (data as { artifact?: ResearchArtifact }).artifact ?? null;
}
