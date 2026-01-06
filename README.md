# Pi Perplexity Web Search Extension

Web search and content fetching extension for [pi](https://github.com/badlogic/pi-mono). Uses Perplexity AI for search, extracts readable content from URLs.

```
Search for "TypeScript best practices 2025"
```

**Requires:** pi v0.37.3+

## Why This Extension

AI agents need web access. Most solutions require complex setup or external services.

This extension:

- **Single API Key** - Just Perplexity. No orchestration services, no subscriptions.
- **Async Content Fetching** - Background fetch with agent notification when ready.
- **Session-Aware Storage** - Results persist across turns, isolated per session.
- **Clean Extraction** - Readability + Turndown for markdown output, not raw HTML dumps.

## Installation

```bash
# From extension directory
npm install
```

Add your Perplexity API key (either method):

```bash
# Option 1: Environment variable
export PERPLEXITY_API_KEY="pplx-..."

# Option 2: Config file
echo '{"perplexityApiKey": "pplx-..."}' > ~/.pi/web-search.json
```

Get a key at https://perplexity.ai/settings/api

## Tools

### web_search

Search the web via Perplexity AI. Returns synthesized answer with source citations.

```typescript
// Single query
web_search({ query: "rust async programming" })

// Multiple queries (parallel)
web_search({ queries: ["query 1", "query 2"] })

// With options
web_search({
  query: "latest news",
  numResults: 10,              // Default: 5, max: 20
  recencyFilter: "week",       // day, week, month, year
  domainFilter: ["github.com"] // Prefix with - to exclude
})

// Fetch full page content (async)
web_search({ query: "...", includeContent: true })
```

When `includeContent: true`, sources are fetched in the background. Agent receives notification when ready.

### fetch_content

Fetch URL(s) and extract readable content as markdown.

```typescript
// Single URL - returns content directly
fetch_content({ url: "https://example.com/article" })

// Multiple URLs - stores content for retrieval
fetch_content({ urls: ["url1", "url2", "url3"] })
```

### get_search_content

Retrieve stored content from previous searches or fetches.

```typescript
// By response ID (from web_search or fetch_content)
get_search_content({ responseId: "abc123", urlIndex: 0 })

// By URL
get_search_content({ responseId: "abc123", url: "https://..." })

// By query (for search results)
get_search_content({ responseId: "abc123", query: "original query" })
```

## Commands

### /search

Browse stored search results interactively.

## TUI Display

Tool calls render with real-time progress and expandable details:

```
┌─ search "TypeScript best practices 2025" ─────────────────────────┐
│ [████████░░] searching                                            │
└───────────────────────────────────────────────────────────────────┘

┌─ search "TypeScript best practices 2025" ─────────────────────────┐
│ 5 sources (fetching 5 URLs)                                       │
└───────────────────────────────────────────────────────────────────┘
```

Multiple queries show each one:

```
┌─ search 3 queries ────────────────────────────────────────────────┐
│   "rust async programming"                                        │
│   "tokio vs async-std"                                            │
│   "rust futures explained"                                        │
├───────────────────────────────────────────────────────────────────┤
│ 3/3 queries, 15 sources                                           │
└───────────────────────────────────────────────────────────────────┘
```

Content fetching shows URLs:

```
┌─ fetch 4 URLs ────────────────────────────────────────────────────┐
│   https://docs.rust-lang.org/book/ch16-00-concurrency.html        │
│   https://tokio.rs/tokio/tutorial                                 │
│   https://rust-lang.github.io/async-book/                         │
│   https://blog.example.com/rust-async-deep-dive                   │
├───────────────────────────────────────────────────────────────────┤
│ 4/4 URLs (content stored)                                         │
└───────────────────────────────────────────────────────────────────┘
```

Expanded view shows content preview:

```
┌─ search "what is WebGPU" ─────────────────────────────────────────┐
│ 5 sources                                                         │
│                                                                   │
│ WebGPU is a new web standard for graphics and compute that        │
│ provides modern GPU capabilities to web applications. Unlike      │
│ WebGL, which is based on OpenGL ES, WebGPU is designed from       │
│ scratch for modern GPU architectures...                           │
│                                                                   │
│ ---                                                               │
│                                                                   │
│ **Sources:**                                                      │
│ 1. WebGPU Fundamentals                                            │
│    https://webgpufundamentals.org/                                │
│ ...                                                               │
└───────────────────────────────────────────────────────────────────┘
```

## How It Works

```
Agent Request → Perplexity API → Synthesized Answer + Citations
                                         ↓
                              [if includeContent: true]
                                         ↓
                              Background Fetch (3 concurrent)
                                         ↓
                              Readability → Turndown → Markdown
                                         ↓
                              Agent Notification (triggerTurn)
```

Content extraction uses:
- `@mozilla/readability` - Article extraction
- `linkedom` - Server-side DOM
- `turndown` - HTML to Markdown
- `p-limit` - Concurrency control

## Rate Limits

- **Perplexity API**: 10 requests/minute (enforced client-side)
- **Content Fetch**: 3 concurrent requests, 30s timeout per URL
- **Cache TTL**: 1 hour

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands |
| `perplexity.ts` | Perplexity API client, rate limiting |
| `extract.ts` | URL fetching, content extraction |
| `storage.ts` | Session-aware result storage |

## Limitations

- Content extraction works best on article-style pages
- Heavy JS sites may not extract well (no browser rendering)
- Max content length: 10,000 chars per URL (truncated)
- Requires restart after config file changes

## License

MIT
