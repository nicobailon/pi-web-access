# ADR 0001: Source-check and machine-readable research artifacts

- **Status**: Accepted
- **Date**: 2026-06-28
- **Issue**: [nicobailon/pi-web-access#108](https://github.com/nicobailon/pi-web-access/issues/108)

## Context

Pi already has `pi-web-access` for web search and URL fetching. Issue #108 asks
for a repeatable **research surface** that preserves source provenance, supports
**source checking** (claims against fetched sources), and hands **structured
artifacts** to workflows and accountability tools — without scraping terminal
text and without a net-new Pi search package.

Today:

- `web_search` returns an AI-synthesized answer plus a `responseId`. The
  underlying results live in an in-memory `StoredSearchData` map keyed by id.
- `fetch_content` returns markdown content plus a `responseId`.
- `get_search_content` retrieves stored results by id.

What's missing:

- A machine-readable artifact schema that a workflow can consume directly
  (citations tied to **exact retrieved content**, not only top-level URLs).
- A `/source-check` tool mode that returns `supported` / `contradicted` /
  `unclear` / `missing-evidence` for a claim against fetched sources.
- Source-quality flags (official docs, vendor docs, repo issue, blog, forum,
  news, unknown).
- Domain include/exclude and recency filters in the structured request.
- An adapter point so an external search-aggregation service can sit behind
  `pi-web-access` without a separate Pi package.

## Decision

### 1. Artifact schema (`ResearchArtifact`)

A stable, serializable JSON object emitted by `web_search` (when structured
output is requested) and `source_check`, retrievable by `responseId` through
the existing `get_search_content` path (the stored entry gains a new
`type: "research"` discriminator).

```ts
interface ResearchArtifact {
  id: string;                       // responseId (existing storage key)
  type: "research";                 // new StoredSearchData discriminator
  timestamp: number;                // fetch time (ms epoch)
  query: string;                    // the search query or claim text
  sources: ResearchSource[];        // ordered, deduplicated
  passages: ResearchPassage[];      // extracted snippets tied to a source
  claims?: ClaimAssessment[];       // present for source-check runs
  provider?: string;                // search adapter used
  summary?: string;                 // optional synthesized answer
  content_hash?: string;            // sha-256 of fetched passage content
}

interface ResearchSource {
  rank: number;
  url: string;
  title: string;
  snippet?: string;
  fetch_timestamp?: number;
  content_hash?: string;
  quality: SourceQuality;            // official_docs | vendor_docs | repo_issue | blog | forum | news | unknown
  fetched?: boolean;                // whether full content was retrieved
}

interface ResearchPassage {
  passage_id: string;               // stable within the artifact
  source_url: string;
  source_rank: number;
  text: string;                     // exact retrieved span (never paraphrased)
  extraction_span?: { start: number; end: number }; // char offsets in source content
  content_hash?: string;
}

type SourceQuality =
  | "official_docs" | "vendor_docs" | "repo_issue"
  | "blog" | "forum" | "news" | "unknown";

interface ClaimAssessment {
  claim: string;
  status: "supported" | "contradicted" | "unclear" | "missing-evidence";
  supporting_passages: string[];    // passage_ids
  contradicting_passages: string[]; // passage_ids
  rationale: string;
  confidence: number;               // 0..1
}
```

**Provenance guarantee**: every `ClaimAssessment` references `passage_id`s,
never bare URLs. A passage is only created from **exact retrieved content**
(snippets returned by the search provider or text spans extracted from a
fetched page). This keeps citations tied to retrieved content, satisfying the
issue's hardest acceptance criterion.

### 2. `/source_check` tool mode

`POST source_check` (MCP tool `source_check`):

```ts
{
  claim: string;                    // the assertion to check
  queries?: string[];               // searches to run (default: [claim])
  numResults?: number;              // default 5, max 20
  recencyFilter?: "day"|"week"|"month"|"year";
  domainFilter?: string[];          // prefix with - to exclude
  provider?: "auto"|"openai"|"brave"|"parallel"|"tavily"|"exa"|"perplexity"|"gemini";
  fetchContent?: boolean;            // fetch full pages for passage extraction
}
```

Returns a `ResearchArtifact` with `claims[]` populated. The tool reuses the
existing search provider machinery (so it stays provider-agnostic) and the
existing `storage` for retrieval.

### 3. Source-quality classifier

Heuristic, domain/URL-based:

| Quality | Signal |
|---|---|
| `official_docs` | path under `developers.*`, `docs.*`, `*.github.io`, `/docs/`, RTD-style |
| `vendor_docs` | `*.com/docs`, vendor-hosted product docs |
| `repo_issue` | `github.com/<o>/<r>/issues` (or `/pull/`) |
| `news` | known news domains / `/news/` path |
| `blog` | `*.medium.com`, `*.substack.com`, `/blog/` path |
| `forum` | `*.stackoverflow.com`, `discourse`, `/forum/` |
| `unknown` | fallback |

Classifications are best-effort; the artifact always carries the raw URL + title
so a consumer can override.

### 4. Domain/recency filters

Already present in `web_search`; the artifact schema records which filters were
applied via the upstream provider's behavior. The adapter interface exposes
them (see #5) so an external aggregator receives them too.

### 5. Backend/provider adapter interface

A minimal seam so an external search-aggregation service can be plugged in
behind `pi-web-access` without a new package:

```ts
interface ResearchProvider {
  name: string;
  search(req: ResearchSearchRequest): Promise<ResearchSearchResponse>;
}

interface ResearchSearchRequest {
  query: string;
  numResults: number;
  recencyFilter?: "day"|"week"|"month"|"year";
  domainFilter?: string[];
}

interface ResearchSearchResponse {
  provider: string;
  results: { url: string; title: string; snippet: string; rank: number }[];
  summary?: string;
}
```

The default adapter wraps the existing in-repo providers (Brave/Exa/Tavily/etc.).
A future external aggregator implements `ResearchProvider` and is registered via
the package config; `source_check` and `web_search` route through it when
configured. **No Pi-core change is required** to add an aggregator.

### 6. Retrieval

`ResearchArtifact`s are stored under the existing `responseId` key with the new
`type: "research"` discriminator. `get_search_content` returns them unchanged
when the id matches a research artifact, so workflows and accountability tools
retrieve structured artifacts through the **same content-retrieval pattern**
already documented for `web_search`/`fetch_content`.

## Consequences

- **Positive**: workflows get a stable JSON contract; citations are tied to
  exact retrieved content (not only top-level URLs); an external aggregator is
  pluggable without a new package; existing interactive search behavior is
  unchanged.
- **Positive**: backward-compatible — `web_search` default behavior is
  unchanged; structured artifacts are opt-in via `source_check` or a future
  `structured: true` flag.
- **Negative**: passage extraction adds a fetch cost when `fetchContent` is
  true; classified `quality` is heuristic and may mislabel edge cases (mitigated
  by always surfacing the raw URL + title).
- **Risk**: claim assessment relies on the search provider's synthesized
  answer + passage matching, not a separate LLM verifier. Confidence is
  calibrated conservatively; `unclear` / `missing-evidence` are preferred over
  false-positive `supported` when passages are thin.

## Non-goals (per #108)

- No Pi-core change is required.
- Existing interactive search behavior continues to work.
