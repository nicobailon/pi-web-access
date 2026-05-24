---
title: Direct GitHub REST API Fallback — gh CLI with HTTP API failover
date: 2026-05-24
category: architecture-patterns
module: github-api
problem_type: architecture_pattern
component: content-extraction
severity: medium
applies_when:
  - "Fetching GitHub repo content when gh CLI is unavailable"
  - "Need to access public repos without authentication"
  - "Building a fallback chain for GitHub API access"
tags: [github-api, direct-http, fallback, gh-cli, public-repos, content-extraction]
---

# Direct GitHub REST API Fallback

## Context

The `fetch_content` tool in pi-web-access needs to fetch GitHub repo content (files, trees, READMEs). The original approach used the `gh` CLI exclusively, which requires the GitHub CLI to be installed and authenticated. When `gh` was unavailable, the entire fetch failed.

The solution: a dual-path approach where `gh` CLI is tried first, then falls back to direct HTTP REST API calls to `https://api.github.com/`. This works for public repos without any authentication.

## Architecture

### Dual-Path Strategy

```typescript
// Path 1: gh CLI (preferred — handles auth, rate limits, etc.)
let content = await fetchFileViaCli(owner, repo, path, ref);

// Path 2: Direct HTTP REST API (fallback — works for public repos)
if (!content) {
    content = await fetchFileViaDirectApi(owner, repo, path, ref);
}
```

### Three API Endpoints

Each content type has both a CLI and direct API implementation:

**File Content:**
- CLI: `gh api repos/{owner}/{repo}/contents/{path}?ref={ref}`
- Direct: `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}`
- Response: `{ content: "base64-encoded", ... }`
- Decoding: `Buffer.from(data.content, "base64").toString("utf-8")`

**Repo Tree:**
- CLI: `gh api repos/{owner}/{repo}/git/trees/{ref}?recursive=1`
- Direct: `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{ref}?recursive=1`
- Response: `{ tree: [{ path, type }] }`
- Filtering: Only blobs (files), max `MAX_TREE_ENTRIES` (1000)

**README:**
- CLI: `gh api repos/{owner}/{repo}/readme`
- Direct: `GET https://api.github.com/repos/{owner}/{repo}/readme?ref={ref}`
- Response: `{ content: "base64-encoded" }`
- Truncation: READMEs > 8192 chars are truncated with a note

### Implementation Pattern

```typescript
async function fetchFileViaDirectApi(
    owner: string,
    repo: string,
    path: string,
    ref: string
): Promise<string | null> {
    try {
        const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
        const res = await fetch(url, {
            headers: { "Accept": "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const data = await res.json() as { content?: string };
        if (!data.content) return null;
        return Buffer.from(data.content, "base64").toString("utf-8");
    } catch {
        return null;
    }
}
```

### Fallback Chain for Tree + README

```typescript
// Try gh CLI first for both tree and README
let [tree, readme] = await Promise.all([
    fetchTreeViaCli(owner, repo, ref),
    fetchReadmeViaCli(owner, repo, ref),
]);

// If either failed, try direct API fallback
if (!tree || !readme) {
    const [treeFallback, readmeFallback] = await Promise.all([
        fetchTreeViaDirectApi(owner, repo, ref),
        fetchReadmeViaDirectApi(owner, repo, ref),
    ]);
    tree = tree ?? treeFallback;
    readme = readme ?? readmeFallback;
}
```

## Why This Works

1. **gh CLI first** — handles authentication, rate limits, and private repos when available
2. **Direct API fallback** — works for public repos without any setup
3. **Abort signals** — both paths have timeouts to prevent indefinite hangs
4. **Graceful degradation** — if both paths fail, returns null (caller handles)
5. **No breaking changes** — existing callers see the same interface

## Limitations

### Public Repos Only
- Direct API only works for public repos
- Private repos require `gh` CLI with authentication
- If `gh` is unavailable AND the repo is private, the fetch will fail

### Rate Limits
- Direct API is subject to GitHub's unauthenticated rate limit (60 requests/hour)
- `gh` CLI with auth gets 5,000 requests/hour
- For high-volume use, always use `gh` CLI when available

### No Webhook/Event Support
- Direct API is read-only
- Cannot create issues, PRs, or other write operations

## Related

- `github-api.ts` — GitHub API client with dual-path fallback
- `github-extract.ts` — GitHub repo cloning and content extraction
- `fetch_content` tool — Content extraction entry point
- `docs/solutions/architecture-patterns/code-search-race-condition.md` — Related code search pattern
