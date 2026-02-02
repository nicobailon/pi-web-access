<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

An extension for [Pi coding agent](https://github.com/badlogic/pi-mono/) that gives Pi web capabilities: search via Perplexity AI, fetch and extract content from URLs, clone GitHub repos for local exploration, and read PDFs.

```typescript
web_search({ query: "TypeScript best practices 2025" })
fetch_content({ url: "https://docs.example.com/guide" })
```

## Install

```bash
pi install npm:pi-web-access
```

Add your Perplexity API key:

```bash
# Option 1: Environment variable
export PERPLEXITY_API_KEY="pplx-..."

# Option 2: Config file
echo '{"perplexityApiKey": "pplx-..."}' > ~/.pi/web-search.json
```

Get a key at https://perplexity.ai/settings/api

**Requires:** Pi v0.37.3+

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
// Single URL - returns content directly (also stored for retrieval)
fetch_content({ url: "https://example.com/article" })

// Multiple URLs - returns summary (content stored for retrieval)
fetch_content({ urls: ["url1", "url2", "url3"] })

// PDFs - extracted and saved to ~/Downloads/
fetch_content({ url: "https://arxiv.org/pdf/1706.03762" })
// → "PDF extracted and saved to: ~/Downloads/arxiv-170603762.md"
```

**GitHub repos:** GitHub code URLs are automatically detected and cloned locally instead of scraping HTML. The agent gets actual file contents and a local path to explore with `read` and `bash`.

```typescript
// Clone a repo - returns structure + README
fetch_content({ url: "https://github.com/owner/repo" })
// → "Repository cloned to: /tmp/pi-github-repos/owner/repo"

// Specific file - returns file contents
fetch_content({ url: "https://github.com/owner/repo/blob/main/src/index.ts" })

// Directory - returns listing
fetch_content({ url: "https://github.com/owner/repo/tree/main/src" })

// Force-clone a large repo that exceeds the size threshold
fetch_content({ url: "https://github.com/big/repo", forceClone: true })
```

Repos over 350MB get a lightweight API-based view instead of a full clone. Commit SHA URLs are also handled via the API. Clones are cached for the session -- multiple files from the same repo share one clone, but clones are wiped on session change/shutdown and re-cloned as needed.

**PDF handling:** When fetching a PDF URL, the extension extracts text and saves it as a markdown file in `~/Downloads/`. The agent can then use `read` to access specific sections without loading 200K+ chars into context.

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

## Features

### Activity Monitor (Ctrl+Shift+W)

Toggle live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
  GET  news.example.com/latest         ...    1.2s ⋯
────────────────────────────────────────────────────────────
Rate: 3/10 (resets in 42s)
```

### RSC Content Extraction

Next.js App Router pages embed content as RSC (React Server Components) flight data in script tags. When Readability fails, the extension parses these JSON payloads directly, reconstructing markdown with headings, tables, code blocks, and links.

### TUI Rendering

Tool calls render with real-time progress:

```
┌─ search "TypeScript best practices 2025" ─────────────────────────┐
│ [████████░░] searching                                            │
└───────────────────────────────────────────────────────────────────┘
```

## Skills

Skills are bundled with the extension and available automatically after install -- no extra setup needed.

### librarian

Structured research workflow for open-source libraries with evidence-backed answers and GitHub permalinks. Loaded automatically when the task involves understanding library internals, finding implementation details, or tracing code history.

Combines `fetch_content` (GitHub cloning), `web_search` (recent info), and git operations (blame, log, show). Pi auto-detects when to load it based on your prompt. If you have [pi-skill-palette](https://github.com/nicobailon/pi-skill-palette) installed, you can also load it explicitly via `/skill:librarian`.

## Commands

### /search

Browse stored search results interactively.

## How It Works

### fetch_content routing

```
fetch_content(url)
       │
       ├── github.com code URL? ──→ Clone repo (gh/git --depth 1)
       │                                    │
       │                            ┌───────┼───────┐
       │                            ↓       ↓       ↓
       │                          root    tree     blob
       │                            ↓       ↓       ↓
       │                         tree +   dir     file
       │                         README  listing  contents
       │                            │       │       │
       │                            └───────┼───────┘
       │                                    ↓
       │                           Return content + local
       │                           path for read/bash
       │
       ├── PDF? ──→ unpdf → Save to ~/Downloads/
       │
       ├── Plain text? ──→ Return directly
       │
       └── HTML ──→ Readability → Markdown
                         │
                    [if fails]
                         ↓
                    RSC Parser → Markdown
```

### web_search with includeContent

```
Agent Request → Perplexity API → Synthesized Answer + Citations
                                         ↓
                              [if includeContent: true]
                                         ↓
                              Background Fetch (3 concurrent)
                              (uses same routing as above)
                                         ↓
                              Agent Notification (triggerTurn)
```

## Configuration

All config lives in `~/.pi/web-search.json`:

```json
{
  "perplexityApiKey": "pplx-...",
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  }
}
```

All `githubClone` fields are optional with the defaults shown above. Set `"enabled": false` to disable GitHub cloning entirely and fall through to normal HTML extraction.

## Rate Limits

- **Perplexity API**: 10 requests/minute (enforced client-side)
- **Content Fetch**: 3 concurrent requests, 30s timeout per URL
- **Cache TTL**: 1 hour

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `perplexity.ts` | Perplexity API client, rate limiting |
| `extract.ts` | URL fetching, content extraction routing |
| `github-extract.ts` | GitHub URL parser, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for oversized repos and commit SHAs |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for observability widget |
| `skills/librarian/` | Bundled skill for library research with permalinks |

## Limitations

- Content extraction works best on article-style pages
- Heavy JS sites may not extract well (no browser rendering), though Next.js App Router pages with RSC flight data are supported
- PDFs are extracted as text (no OCR for scanned documents)
- Max response size: 20MB for PDFs, 5MB for HTML
- Max inline content: 30,000 chars per URL (larger content stored for retrieval via get_search_content)
- GitHub cloning requires `gh` CLI for private repos (public repos fall back to `git clone`)
- GitHub branch names with slashes (e.g. `feature/foo`) may resolve the wrong file path; the clone still succeeds and the agent can navigate manually
- Non-code GitHub URLs (issues, PRs, wiki, etc.) fall through to normal Readability extraction
- Requires Pi restart after config file changes
