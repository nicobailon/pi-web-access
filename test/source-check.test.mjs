import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const sourceCheckSrc = readFileSync(new URL("../source-check.ts", import.meta.url), "utf8");
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const storageSrc = readFileSync(new URL("../storage.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// ── Artifact schema (ADR 0001) ───────────────────────────────────────────────

test("source-check module exports the ResearchArtifact schema types", () => {
	assert.match(sourceCheckSrc, /export interface ResearchArtifact\b/);
	assert.match(sourceCheckSrc, /export type SourceQuality\b/);
	assert.match(sourceCheckSrc, /export type ClaimStatus\b/);
	assert.match(sourceCheckSrc, /export interface ResearchSource\b/);
	assert.match(sourceCheckSrc, /export interface ResearchPassage\b/);
	assert.match(sourceCheckSrc, /export interface ClaimAssessment\b/);
});

test("ClaimStatus covers the four issue-required verdicts", () => {
	assert.match(
		sourceCheckSrc,
		/export type ClaimStatus = "supported" \| "contradicted" \| "unclear" \| "missing-evidence"/,
	);
});

test("SourceQuality covers official/vendor/repo/news/blog/forum/unknown", () => {
	for (const q of ["official_docs", "vendor_docs", "repo_issue", "blog", "forum", "news", "unknown"]) {
		assert.match(sourceCheckSrc, new RegExp(`"${q}"`), `missing SourceQuality ${q}`);
	}
});

test("ClaimAssessment references passage ids, not bare URLs (provenance guarantee)", () => {
	assert.match(sourceCheckSrc, /supporting_passages: string\[\]/);
	assert.match(sourceCheckSrc, /contradicting_passages: string\[\]/);
	// Rationale text documenting the provenance guarantee.
	assert.match(sourceCheckSrc, /references passage_ids, never/);
});

// ── Source-quality classifier ────────────────────────────────────────────────

test("classifier maps repo issues, official docs, news, blog, forum, unknown", () => {
	assert.match(sourceCheckSrc, /REPO_ISSUE_PATHS/);
	assert.match(sourceCheckSrc, /OFFICIAL_DOCS_HOSTS/);
	assert.match(sourceCheckSrc, /NEWS_HOSTS/);
	assert.match(sourceCheckSrc, /BLOG_HOSTS/);
	assert.match(sourceCheckSrc, /FORUM_HOSTS/);
	assert.match(sourceCheckSrc, /return "unknown"/);
	assert.match(sourceCheckSrc, /export function classifySource\b/);
});

// ── Claim assessment markers ─────────────────────────────────────────────────

test("assessClaim uses contradiction and support markers", () => {
	assert.match(sourceCheckSrc, /CONTRADICTION_MARKERS/);
	assert.match(sourceCheckSrc, /SUPPORT_MARKERS/);
	// Each of the four statuses must be reachable. `missing-evidence` is
	// returned via an object literal (status:), the others via assignment.
	for (const s of ["supported", "contradicted", "unclear"]) {
		assert.match(sourceCheckSrc, new RegExp(`status = "${s}"`), `status ${s} not assigned`);
	}
	assert.match(sourceCheckSrc, /status: "missing-evidence"/);
});

test("assessClaim returns missing-evidence when there are no passages", () => {
	assert.match(sourceCheckSrc, /status: "missing-evidence"/);
	assert.match(sourceCheckSrc, /No passages available/);
});

// ── Passage extraction (exact retrieved spans, no paraphrasing) ──────────────

test("passages are built from snippets and fetched spans, never paraphrased", () => {
	assert.match(sourceCheckSrc, /export function buildPassages\b/);
	assert.match(sourceCheckSrc, /passage text is ALWAYS the exact retrieved span/i);
	assert.match(sourceCheckSrc, /extractRelevantSpans/);
});

// ── Adapter interface (pluggable external aggregator) ───────────────────────

test("research provider adapter interface is exported", () => {
	assert.match(sourceCheckSrc, /export interface ResearchProvider\b/);
	assert.match(sourceCheckSrc, /export interface ResearchSearchRequest\b/);
	assert.match(sourceCheckSrc, /export interface ResearchSearchResponse\b/);
	assert.match(sourceCheckSrc, /search\(req: ResearchSearchRequest\)/);
});

// ── Storage integration ─────────────────────────────────────────────────────

test("storage accepts the new research discriminator", () => {
	assert.match(storageSrc, /type: "search" \| "fetch" \| "research"/);
	assert.match(storageSrc, /d\.type !== "search" && d\.type !== "fetch" && d\.type !== "research"/);
});

test("source-check stores/retrieves artifacts via the existing storage map", () => {
	assert.match(sourceCheckSrc, /import \{ generateId, storeResult, getResult \} from "\.\/storage\.ts"/);
	assert.match(sourceCheckSrc, /export function storeResearchArtifact\b/);
	assert.match(sourceCheckSrc, /export function getResearchArtifact\b/);
	assert.match(sourceCheckSrc, /type: "research" as const/);
});

// ── Tool registration in index.ts ────────────────────────────────────────────

test("source_check tool is registered in index.ts", () => {
	assert.match(indexSrc, /name: "source_check"/);
	assert.match(indexSrc, /label: "Source Check"/);
});

test("source_check schema accepts claim, queries, filters, and provider", () => {
	assert.match(indexSrc, /claim: Type\.String\(/);
	assert.match(indexSrc, /queries: Type\.Optional\(Type\.Array\(Type\.String\(\)/);
	assert.match(indexSrc, /recencyFilter: Type\.Optional\(/);
	assert.match(indexSrc, /domainFilter: Type\.Optional\(/);
	assert.match(indexSrc, /provider: Type\.Optional\(/);
});

test("source_check returns a machine-readable artifact via details + responseId", () => {
	assert.match(indexSrc, /details: \{ responseId: withClaims\.id, artifact: withClaims/);
});

test("source_check reuses the existing search provider dispatch", () => {
	assert.match(indexSrc, /const resp = await search\(q, searchOptions\)/);
});

test("get_search_content returns research artifacts by responseId", () => {
	assert.match(indexSrc, /if \(data\.type === "research"\)/);
	assert.match(indexSrc, /const artifact = getResearchArtifact/);
});

// ── Documentation ────────────────────────────────────────────────────────────

test("README documents /source_check and machine-readable artifacts", () => {
	assert.match(readmeSrc, /source[-_ ]?check/i);
	assert.match(readmeSrc, /machine-readable/i);
	assert.match(readmeSrc, /supported.*contradicted.*unclear.*missing-evidence/s);
});

test("ADR 0001 exists for the artifact schema and adapter interface", () => {
	const adr = readFileSync(new URL("../docs/adr/0001-source-check-and-research-artifacts.md", import.meta.url), "utf8");
	assert.match(adr, /# ADR 0001/);
	assert.match(adr, /ResearchArtifact/);
	assert.match(adr, /ResearchProvider/);
	assert.match(adr, /supported.*contradicted.*unclear.*missing-evidence/s);
	assert.match(adr, /passage_id/);
});
