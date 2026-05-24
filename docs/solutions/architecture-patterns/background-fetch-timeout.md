---
title: Background Fetch Timeout Pattern — preventing indefinite hangs in parallel URL fetching
date: 2026-05-24
category: architecture-patterns
module: web-search
problem_type: architecture_pattern
component: content-fetching
severity: high
applies_when:
  - "Fetching multiple URLs in parallel with async operations"
  - "Need to prevent indefinite hangs from stalled network requests"
  - "Building a background fetch system with timeout guarantees"
tags: [background-fetch, timeout, abort-signal, parallel-fetch, web-search]
---

# Background Fetch Timeout Pattern

## Context

The `web_search` tool in pi-web-access supports `includeContent: true`, which triggers a background fetch of all search result URLs. The original implementation had no timeout, causing indefinite hangs when `fetchAllContent` stalled on a URL (e.g., a slow server, a redirect loop, or a network issue).

The solution: a hard timeout using `setTimeout` + `AbortController` that aborts all pending fetches after a calculated timeout period.

## Architecture

### Timeout Calculation

```typescript
// 30 seconds per URL, minimum 30 seconds total
const backgroundTimeoutMs = Math.max(30000, urls.length * 30000);
```

| URLs | Timeout | Rationale |
|------|---------|-----------|
| 1 | 30s | Minimum timeout for any single URL |
| 2 | 60s | 30s per URL |
| 10 | 300s | 30s per URL |

### AbortController Pattern

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => {
    if (pendingFetches.has(fetchId)) {
        controller.abort();
        pendingFetches.delete(fetchId);
        const message = `Background content fetch timed out after ${backgroundTimeoutMs / 1000}s`;
        pi.sendMessage({
            customType: "web-search-error",
            content: `Content fetch failed [${fetchId}]: ${message}`,
            display: true,
        }, { triggerTurn: false });
    }
}, backgroundTimeoutMs);

pendingFetches.set(fetchId, controller);

fetchAllContent(urls, controller.signal)
    .then((fetched) => { /* ... */ })
    .finally(() => {
        clearTimeout(timeoutId);
        pendingFetches.delete(fetchId);
    });
```

### Key Design Decisions

**Why `setTimeout` + `AbortController` instead of `AbortSignal.timeout()`?**
- `AbortSignal.timeout()` applies to a single fetch operation
- We need a single timeout for ALL parallel fetches in the batch
- `AbortController` allows aborting all pending fetches simultaneously
- `setTimeout` gives us a configurable timeout for the entire batch

**Why `Math.max(30000, urls.length * 30000)`?**
- Minimum 30s: even a single URL should have a reasonable timeout
- 30s per URL: scales with the number of URLs being fetched
- Prevents both premature timeouts (single URL) and indefinite hangs (many URLs)

**Why `finally` cleanup?**
- `clearTimeout(timeoutId)` prevents the timeout from firing after the fetch completes
- `pendingFetches.delete(fetchId)` cleans up the tracking map
- Without cleanup, `pendingFetches` would grow indefinitely

**Why `triggerTurn: false` in the error message?**
- The error notification should not trigger a new AI turn
- It's a status update, not a user-facing question
- Prevents infinite loops of error messages triggering new searches

## Why This Works

1. **Predictable timeouts** — users know exactly how long they'll wait
2. **Graceful degradation** — partial results are still returned for URLs that completed before timeout
3. **No resource leaks** — `AbortController` cancels all pending HTTP requests
4. **Clean cleanup** — `finally` block ensures timeout is cancelled and map is cleaned
5. **User notification** — error message is sent via `pi.sendMessage` for visibility

## Edge Cases

### Timeout Fires During Fetch
- All pending fetches are aborted via `controller.abort()`
- Error message is sent to the user
- Partial results from completed fetches are still returned

### Fetch Completes Before Timeout
- `finally` block cancels the timeout
- No error message is sent
- Results are returned normally

### Multiple Concurrent Batches
- Each batch has its own `fetchId`, `controller`, and `timeoutId`
- No interference between batches
- `pendingFetches` map tracks all active batches

### Aborted Fetch in `fetchAllContent`
- `fetchAllContent` should handle `AbortError` gracefully
- Skip aborted URLs, continue with remaining URLs
- Don't throw — return partial results

## Related

- `index.ts` — Background fetch implementation with timeout
- `fetch_content` tool — Content extraction entry point
- `web_search` tool — Search with optional content inclusion
- `docs/solutions/architecture-patterns/github-api-direct-fallback.md` — Related fallback pattern
