// Structured source evidence and machine-readable research artifacts.
import { createHash } from "node:crypto";
import { generateId, getResult, storeResult } from "./storage.ts";
import type { SearchResult } from "./perplexity.ts";
import type { ExtractedContent } from "./extract.ts";

export type SourceQuality = "official_docs" | "vendor_docs" | "repo_issue" | "blog" | "forum" | "news" | "unknown";
export type ClaimStatus = "supported" | "contradicted" | "unclear" | "missing-evidence";
export type RecencyFilter = "day" | "week" | "month" | "year";

export interface ResearchSource {
	rank: number;
	url: string;
	title: string;
	snippet?: string;
	fetch_timestamp?: number;
	content_hash?: string;
	quality: SourceQuality;
	fetched?: boolean;
	fetch_error?: string;
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
	confidence: number;
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
	filters?: { recency?: RecencyFilter; domain_include?: string[]; domain_exclude?: string[] };
	errors?: Array<{ query: string; error: string }>;
}

export interface ResearchSearchRequest {
	query: string;
	numResults: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
}
export interface ResearchSearchResult { url: string; title: string; snippet: string; rank: number }
export interface ResearchSearchResponse { provider: string; results: ResearchSearchResult[]; summary?: string }
export interface ResearchProvider { name: string; search(req: ResearchSearchRequest): Promise<ResearchSearchResponse> }

const OFFICIAL_DOCS_HOSTS = /^(developers\.|docs\.|learn\.|reference\.)|\.github\.io$/i;
const OFFICIAL_DOCS_PATHS = /\/(docs?|reference)(\/|\b)/i;
const VENDOR_DOCS_PATHS = /\/(documentation|docs?)\//i;
const REPO_ISSUE_PATHS = /\/(issues|pull|pulls)\//i;
const BLOG_HOSTS = /(medium\.com|substack\.com|dev\.to|hashnode\.)/i;
const BLOG_PATHS = /\/blogs?\//i;
const FORUM_HOSTS = /(stackoverflow\.com|serverfault\.com|superuser\.com|discourse\.|community\.)/i;
const FORUM_PATHS = /\/(forum|forums|threads)\//i;
const NEWS_HOSTS = /(reuters\.com|bloomberg\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com|cnet\.com|zdnet\.com)/i;
const NEWS_PATHS = /\/news(\/|$)/i;

export function classifySource(url: string): SourceQuality {
	let host = "";
	let path = "";
	try {
		const parsed = new URL(url);
		host = parsed.hostname;
		path = parsed.pathname;
	} catch {
		return "unknown";
	}
	if (REPO_ISSUE_PATHS.test(path)) return "repo_issue";
	if (OFFICIAL_DOCS_HOSTS.test(host) || OFFICIAL_DOCS_PATHS.test(path)) return "official_docs";
	if (VENDOR_DOCS_PATHS.test(path)) return "vendor_docs";
	if (NEWS_HOSTS.test(host) || NEWS_PATHS.test(path)) return "news";
	if (FORUM_HOSTS.test(host) || FORUM_PATHS.test(path)) return "forum";
	if (BLOG_HOSTS.test(host) || BLOG_PATHS.test(path)) return "blog";
	return "unknown";
}

export function hashContent(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

interface Span { text: string; start: number; end: number }

function tokenize(value: string): string[] {
	// Short words are mostly noise ("the", "for"), but short acronyms and numbers ("API", "TLS", "429") carry meaning.
	return [...new Set(value.split(/[^A-Za-z0-9]+/)
		.filter((term) => term.length > 3 || (term.length > 1 && /^[A-Z0-9]+$/.test(term)))
		.map((term) => term.length > 3 ? term.toLowerCase() : term))];
}

/** Long terms match inside words in any case ("stream" in "Streaming"); short acronyms only as whole words in the same case, so "API" skips "rapid" and "US" skips "us". */
function countMatches(terms: string[], text: string): number {
	const lower = text.toLowerCase();
	const words = new Set(text.split(/[^A-Za-z0-9]+/));
	return terms.filter((term) => term.length > 3 ? lower.includes(term) : words.has(term)).length;
}

function extractRelevantSpans(content: string, claim: string, snippet: string): Span[] {
	const sentences: Span[] = [];
	// A sentence ends at punctuation (plus closing quotes, brackets, emphasis or a [n] citation) followed by
	// whitespace or the end, so "example.com" stays inside its sentence. The lookbehind starts each attempt only at
	// the beginning of a punctuation run, which keeps the scan linear on long runs such as "!!!…x".
	const boundary = /(?<![.!?])[.!?]+(?:["'”’)\]*_]|\[\d+\])*(?=\s|$)/g;
	let segmentStart = 0;
	const addSentence = (end: number) => {
		const raw = content.slice(segmentStart, end);
		const text = raw.trim();
		if (text.length > 0 && text.length <= 400) {
			const start = segmentStart + raw.indexOf(text);
			sentences.push({ text, start, end: start + text.length });
		}
		segmentStart = end;
	};
	for (const match of content.matchAll(boundary)) addSentence(match.index + match[0].length);
	addSentence(content.length);
	const claimTerms = tokenize(claim);
	const snippetTerms = tokenize(snippet);
	return sentences
		.map((sentence, index) => ({ sentence, index, claim: countMatches(claimTerms, sentence.text), snippet: countMatches(snippetTerms, sentence.text) }))
		.filter((item) => item.claim + item.snippet > 0)
		.sort((a, b) => b.claim - a.claim || b.snippet - a.snippet || a.index - b.index)
		.slice(0, 3)
		.map(({ sentence }) => sentence);
}

function passageId(sourceRank: number, index: number): string {
	return `p-${sourceRank}-${index}`;
}

export function buildPassages(sources: ResearchSource[], fetched: ExtractedContent[] = [], claim = ""): ResearchPassage[] {
	const passages: ResearchPassage[] = [];
	const fetchedByUrl = new Map(fetched.map((item) => [item.url, item]));
	for (const source of sources) {
		if (source.snippet) {
			passages.push({
				passage_id: passageId(source.rank, 0),
				source_url: source.url,
				source_rank: source.rank,
				text: source.snippet,
				content_hash: hashContent(source.snippet),
			});
		}
		const page = fetchedByUrl.get(source.url);
		if (page && !page.error && page.content) {
			for (const [index, span] of extractRelevantSpans(page.content, claim, source.snippet ?? "").entries()) {
				passages.push({
					passage_id: passageId(source.rank, index + 1),
					source_url: source.url,
					source_rank: source.rank,
					text: span.text,
					extraction_span: { start: span.start, end: span.end },
					content_hash: hashContent(span.text),
				});
			}
		}
	}
	return passages;
}

export function assessClaim(claim: string, passages: ResearchPassage[]): ClaimAssessment {
	if (passages.length === 0) {
		return { claim, status: "missing-evidence", supporting_passages: [], contradicting_passages: [], rationale: "No passages were retrieved for the claim.", confidence: 0.2 };
	}
	return {
		claim,
		status: "unclear",
		supporting_passages: [],
		contradicting_passages: [],
		rationale: "Passages were retrieved, but automated semantic support or contradiction assessment is unavailable; review the cited passages manually.",
		confidence: 0.3,
	};
}

interface RankedSearchResult extends SearchResult {
	rank?: number;
}

export interface BuildArtifactInput {
	query: string;
	provider?: string;
	summary?: string;
	results: RankedSearchResult[];
	fetched?: ExtractedContent[];
	recency?: RecencyFilter;
	domainFilter?: string[];
}

export function buildResearchArtifact(input: BuildArtifactInput): ResearchArtifact {
	const filters = input.domainFilter ?? [];
	const fetchedByUrl = new Map((input.fetched ?? []).map((page) => [page.url, page]));
	const sources: ResearchSource[] = [];
	const seen = new Set<string>();
	for (const [index, result] of input.results.entries()) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		const page = fetchedByUrl.get(result.url);
		const fetched = Boolean(page && !page.error);
		sources.push({
			rank: result.rank ?? index + 1,
			url: result.url,
			title: result.title,
			snippet: result.snippet,
			quality: classifySource(result.url),
			fetched,
			...(page ? { fetch_timestamp: Date.now() } : {}),
			...(page && !page.error ? { content_hash: hashContent(page.content) } : {}),
			...(page?.error ? { fetch_error: page.error } : {}),
		});
	}
	const passages = buildPassages(sources, input.fetched, input.query);
	const domainInclude = filters.filter((domain) => !domain.startsWith("-"));
	const domainExclude = filters.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1));
	return {
		id: generateId(),
		type: "research",
		timestamp: Date.now(),
		query: input.query,
		sources,
		passages,
		...(input.provider !== undefined ? { provider: input.provider } : {}),
		...(input.summary !== undefined ? { summary: input.summary } : {}),
		...(passages.length > 0 ? { content_hash: hashContent(passages.map((passage) => passage.text).join("\n")) } : {}),
		filters: {
			...(input.recency !== undefined ? { recency: input.recency } : {}),
			domain_include: domainInclude,
			domain_exclude: domainExclude,
		},
	};
}

export function withClaimAssessment(artifact: ResearchArtifact, claims: string[]): ResearchArtifact {
	return { ...artifact, claims: claims.map((claim) => assessClaim(claim, artifact.passages)) };
}

export function storeResearchArtifact(artifact: ResearchArtifact): void {
	if (!artifact.id) throw new Error("Research artifact id must not be empty");
	storeResult(artifact.id, { id: artifact.id, type: "research", timestamp: artifact.timestamp, artifact });
}

export function getResearchArtifact(id: string): ResearchArtifact | null {
	const data = getResult(id);
	if (!data || data.type !== "research" || !data.artifact || typeof data.artifact !== "object") return null;
	return data.artifact as ResearchArtifact;
}
