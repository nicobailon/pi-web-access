---
title: Code Search with Sourcegraph + Exa Pipeline Race Condition
date: 2026-05-24
category: architecture-patterns
module: code-search
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Searching for code examples or documentation across multiple repos"
  - "Need both personal codebase search and public GitHub search"
  - "Wanting to leverage pre-indexed repos when available, fall back to on-demand when not"
tags: [sourcegraph, exa-pipeline, race-condition, async, code-search, context7]
---

# Code Search with Sourcegraph + Exa Pipeline Race Condition

## Context

The `code_search` tool in pi-web-access needed to serve two distinct use cases:
1. **Search personal codebases** — fast, full-text search with code graph awareness (Sourcegraph)
2. **Search public GitHub repos** — on-demand, any public repo, no setup required (Context7-style)

Previous approaches tried to pick one:
- **Sourcegraph only**: Requires pre-indexed repos, auth setup, maintenance overhead
- **Exa pipeline only**: No code graph, no personal repo search
- **Both in parallel**: Wastes time when one path clearly wins

The solution: a race condition pattern where both search methods run concurrently, and the first to return wins. If Sourcegraph has the repo indexed, it returns instantly. If not, it times out and the Exa pipeline takes over.

## Guidance

### The Async Race Pattern (Low Latency)

```typescript
// Start BOTH simultaneously — first to return wins
const [sourcegraphResults, exaResults] = await Promise.allSettled([
  searchSourcegraph(query).catch(() => []),
  searchExaCodeSearch(query).catch(() => []),
]);

// First successful result wins
if (sourcegraphResults.status === 'fulfilled' && sourcegraphResults.value.length > 0) {
  return sourcegraphResults.value; // Sourcegraph had it indexed
}
return exaResults.value; // Fall back to Exa pipeline
```

### Why This Works (Async Benefits)

1. **True parallelism** — both searches start simultaneously, no waiting
2. **No timeout waste** — Exa starts immediately, not after Sourcegraph times out
3. **Sourcegraph is fast when indexed** — if the repo is already in the index, search returns in milliseconds
4. **Exa pipeline is reliable** — it searches any public GitHub repo on-demand, no setup needed
5. **Graceful degradation** — if Sourcegraph has nothing, Exa pipeline seamlessly takes over
6. **Latency reduction** — worst case is max(sourcegraph_time, exa_time), not sourcegraph_timeout + exa_time

### Implementation Details

#### Sourcegraph Side
- Self-hosted in Docker (`~/.local/sourcegraph/docker-compose.yaml`)
- Runs `sourcegraph/server:6.12.5040` with PostgreSQL + Redis
- Exposed on `localhost:3000`
- Repos must be added and indexed before search works
- API endpoint: `POST /.api/search` with query parameters

#### Exa Pipeline Side
- Uses existing exa pipeline infrastructure:
  - **Search**: SearXNG + Firecrawl → GitHub repos
  - **Extraction**: GitHub API + LightPanda → code content
  - **Embedding**: Nomic Embed v1.5 (256-dim)
  - **Reranking**: Jina Reranker v1 Tiny
  - **Summarization**: Qwen3.6
- No setup required — works out of the box
- Searches public GitHub repos on-demand

#### Race Condition Logic
1. Start both searches simultaneously
2. Set a timeout for Sourcegraph (e.g., 5 seconds)
3. If Sourcegraph returns results within timeout → use them
4. If Sourcegraph times out or returns empty → use Exa results
5. If both return results → prefer Sourcegraph (more relevant for personal code)

## Why This Matters

### Without This Pattern
- **Sourcegraph only**: Users must manually add and index repos. If a repo isn't indexed, search fails completely.
- **Exa only**: No code graph awareness, no personal repo search, slower for known repos.
- **Both sequential**: Wastes time waiting for Sourcegraph even when it has the answer.

### With This Pattern
- **Best of both worlds**: Leverages pre-indexed repos when available, falls back to on-demand search when not.
- **Zero user friction**: Users don't need to think about which repo is indexed — it just works.
- **Fast for common cases**: Personal repos are indexed, so most searches return instantly.
- **Reliable for rare cases**: Public repos that aren't indexed still get good results via Exa.

## When to Apply

- **Code search tool**: The primary use case for `code_search` in pi-web-access
- **Any search feature**: Where you have a fast local index AND a reliable external source
- **Fallback patterns**: Where you want the best source to win, not a predetermined source

## Examples

### Before: Sourcegraph Only
```typescript
// If repo not indexed, search fails completely
const results = await searchSourcegraph(query);
if (!results) {
  return { error: "Repo not indexed. Add it to Sourcegraph first." };
}
```

### After: Async Race (Low Latency)
```typescript
// Start BOTH simultaneously — first to return wins
const [sgResult, exaResult] = await Promise.allSettled([
  searchSourcegraph(query).catch(() => []),
  searchExaCodeSearch(query).catch(() => []),
]);

if (sgResult.status === 'fulfilled' && sgResult.value.length > 0) {
  return sgResult.value; // Sourcegraph had it
}
return exaResult.value; // Exa pipeline took over
```

### Latency Comparison

| Pattern | Latency | Notes |
|---------|---------|-------|
| Sequential (old) | 5s + exa_time | Wastes time waiting for timeout |
| True parallel (new) | min(sg_time, exa_time) | Both start simultaneously |
| Best case | ~50ms | Sourcegraph has it indexed |
| Worst case | ~10s | Both take time, first wins |

**Key insight:** The async race eliminates the timeout wait. If Sourcegraph is fast (indexed repo), it returns in ~50ms. If not, Exa is already running and returns when ready.

## Related

- `exa-pipeline.ts` — Full exa pipeline with hybrid search
- `code-search.ts` — Sourcegraph + ripgrep + semantic code search
- `github-api.ts` — GitHub API client for content extraction
- `github-extract.ts` — GitHub repo cloning and content extraction
- `embedding-nomic.ts` — Nomic Embed v1.5 (256-dim Matryoshka)
- `reranker-jina.ts` — Jina Reranker v1 Tiny
- `~/.local/sourcegraph/docker-compose.yaml` — Sourcegraph Docker setup
