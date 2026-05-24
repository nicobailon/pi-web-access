---
title: Code Search Race Condition — Sourcegraph vs Exa Pipeline
created: 2026-05-24
status: completed
module: code-search
tags: [sourcegraph, exa-pipeline, race-condition, code-search]
---

# Code Search Race Condition — Sourcegraph vs Exa Pipeline

## Problem Frame

The `code_search` tool needs to serve two distinct use cases:
1. **Personal codebases** — fast, indexed search via Sourcegraph
2. **Public GitHub repos** — on-demand search via Exa pipeline (Context7-style)

Currently, both run in parallel but results are merged without a clear winner. If Sourcegraph has a repo indexed, it should win. If not, Exa pipeline should take over. The current approach wastes time on both paths even when one clearly dominates.

## Scope

**In scope:**
- Implement race condition pattern for `code_search` tool
- Sourcegraph search with timeout
- Exa pipeline code search (Context7-style)
- First-to-return wins logic
- Integration tests

**Out of scope:**
- Sourcegraph repo management (already set up in Docker)
- Exa pipeline core implementation (already exists)
- Authentication setup for Sourcegraph (handled separately)

## Requirements

1. `code_search` must try Sourcegraph first with a timeout (5s)
2. If Sourcegraph returns results within timeout, use them
3. If Sourcegraph times out or returns empty, fall back to Exa pipeline
4. If both return results, prefer Sourcegraph (more relevant for personal code)
5. Exa pipeline code search must search public GitHub repos on-demand
6. All existing `code_search` behavior must be preserved (backward compatible)

## Implementation Units

### Unit 1: Sourcegraph Search with Timeout

**File:** `code-search.ts` (modify `searchSourcegraph`)
**Test:** `test/code-search-race.test.ts`

- Add timeout parameter to `searchSourcegraph` (default 5000ms)
- Return empty array on timeout (not an error)
- Handle 401 authentication gracefully

### Unit 2: Exa Pipeline Code Search (Context7-style)

**File:** `code-search.ts` (new function `searchExaCodeSearch`)
**Test:** `test/code-search-race.test.ts`

- Search GitHub repos using exa pipeline
- Extract code content from relevant repos
- Embed + semantic rerank with Nomic + Jina
- Return formatted results

### Unit 3: Race Condition Logic

**File:** `code-search.ts` (modify `executeCodeSearch`)
**Test:** `test/code-search-race.test.ts`

- Run Sourcegraph search with timeout
- If Sourcegraph returns results, return them
- If Sourcegraph times out/empty, run Exa pipeline
- Merge results if both return (prefer Sourcegraph)

### Unit 4: Integration Tests

**File:** `test/code-search-race.test.ts`

- Test Sourcegraph timeout behavior
- Test Exa pipeline fallback
- Test race condition logic
- Test backward compatibility

## Decisions

### Decision 1: Use `Promise.allSettled` for Async Race
- **Rationale:** Both searches start simultaneously — no timeout waste
- **Alternative:** `Promise.race` with timeout wrapper (sequential approach)
- **Chosen:** `Promise.allSettled` runs both in parallel, first result wins. Eliminates timeout wait latency.

### Decision 2: Exa Pipeline for GitHub Code Search
- **Rationale:** Leverages existing infrastructure (Nomic + Jina + Qwen3.6)
- **Alternative:** Build custom GitHub search from scratch
- **Chosen:** Exa pipeline already has all the pieces, just need to specialize for code

### Decision 3: 5-Second Timeout for Sourcegraph
- **Rationale:** Sourcegraph should be fast if indexed; 5s is generous for indexed search
- **Alternative:** 2s or 10s
- **Chosen:** 5s balances speed with reliability

### Decision 4: Prefer Sourcegraph When Both Return
- **Rationale:** Sourcegraph has code graph awareness and personal repo context
- **Alternative:** Merge results or prefer Exa
- **Chosen:** Sourcegraph results are more relevant for personal code search

## Test Scenarios

### Sourcegraph with Timeout
1. Sourcegraph returns results within 5s → use them
2. Sourcegraph times out after 5s → fall back to Exa
3. Sourcegraph returns empty → fall back to Exa
4. Sourcegraph returns 401 → treat as empty, fall back to Exa

### Exa Pipeline Fallback
1. Exa pipeline returns results → use them
2. Exa pipeline returns empty → return "No results found"
3. Exa pipeline errors → return error message

### Race Condition
1. Sourcegraph fast + Exa fast → prefer Sourcegraph
2. Sourcegraph slow + Exa fast → use Exa
3. Sourcegraph fast + Exa slow → use Sourcegraph
4. Both slow → use whichever returns first

### Backward Compatibility
1. Existing `code_search` calls work unchanged
2. `executeCodeSearch` signature unchanged
3. Return format unchanged

## Dependencies

- Sourcegraph Docker container (already running on localhost:3000)
- Exa pipeline infrastructure (already exists)
- Nomic Embed v1.5 (already configured)
- Jina Reranker (already configured)
- Qwen3.6 (already running on port 8082)

## Risks

1. **Sourcegraph auth:** API returns 401 without authentication. Mitigation: treat 401 as empty, fall back to Exa.
2. **Exa pipeline performance:** Could be slow for large repos. Mitigation: limit results, use batching.
3. **Race condition edge cases:** Both returning at exactly the same time. Mitigation: Sourcegraph wins by design.

## Files to Modify

- `code-search.ts` — Add race condition logic, timeout, Exa pipeline search
- `test/code-search-race.test.ts` — New test file for race condition

## Files to Create

- `test/code-search-race.test.ts` — Integration tests

## Execution Order

1. Implement Unit 1 (Sourcegraph with timeout)
2. Implement Unit 2 (Exa pipeline code search)
3. Implement Unit 3 (Race condition logic)
4. Implement Unit 4 (Integration tests)
5. Verify backward compatibility
