<p>
  <img src="banner.png" alt="pi-web-access" width="1100">
</p>

# Pi Web Access

**Web search, content extraction, and video understanding for Pi agent. OpenAI/Codex search, zero-config Exa search, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, Jina, SERPdive, Kagi, Ollama, AnySearch, xAI/Grok, Bright Data SERP, SerpBase, self-hosted SearXNG, optional browser-cookie Gemini Web, or bring your own API keys.**

[![npm version](https://img.shields.io/npm/v/pi-web-access?style=for-the-badge)](https://www.npmjs.com/package/pi-web-access)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows*-blue?style=for-the-badge)]()

<https://github.com/user-attachments/assets/cac6a17a-1eeb-4dde-9818-cdf85d8ea98f>

## Why Pi Web Access

**Zero Config** — Works out of the box with Exa MCP (no API key needed). If you're signed into Pi with a Codex subscription, OpenAI web search can reuse that auth. Add API keys for OpenAI, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, Jina, SERPdive, Kagi, Ollama, SerpBase, Exa, Perplexity, or Gemini API for more control; configure a self-hosted SearXNG endpoint for private search; or opt into browser-cookie access for Gemini Web.

**Video Understanding** — Point it at a YouTube video or local screen recording and ask questions about what's on screen. Full transcripts, visual descriptions, and frame extraction at exact timestamps.

**Smart Fallbacks** — Every capability has a fallback chain. Search tries configured SearXNG first for local/private search, then OpenAI when suitable and available, Exa, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, Jina, SERPdive, Kagi, Ollama, Perplexity, Gemini API, and Gemini Web when browser cookies are enabled. With no SearXNG configured, the existing zero-config order is unchanged. YouTube tries Gemini Web when enabled, then API, then Perplexity. Blocked pages try configured self-hosted Firecrawl first. Third-party hosted page fetchers require explicit `fetchRouting.allowRemoteHostedProviders` opt-in for remote HTTP(S) targets.

**GitHub Cloning** — GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore, not rendered HTML.

## Install

```bash
pi install npm:pi-web-access
```

Works immediately with no API keys — Exa MCP provides zero-config search. If Pi has Codex auth from `/login`, OpenAI search can also work without a separate key. For more providers or direct API access, add keys to `~/.pi/web-search.json`:

```json
{
  "openaiApiKey": "sk-...",
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "tinyfishApiKey": "sk-tinyfish-...",
  "search1apiApiKey": "...",
  "searchinfinityApiKey": "...",
  "queritApiKey": "...",
  "jinaApiKey": "jina_...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

In `auto` mode (default), `web_search` tries a configured SearXNG endpoint first for local/private search, then OpenAI when suitable and available, Exa (direct API if keyed, MCP if not), Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, Jina, SERPdive, Perplexity, Gemini API, and Gemini Web when browser-cookie access is enabled. With no SearXNG configured, the existing zero-config order is unchanged. Exa handles search; curator summary drafts are generated separately by the configured Pi summary model. Slow summary drafts fall back to a deterministic result summary after a bounded deadline.

If your OpenAI key belongs to a third-party Responses-compatible gateway, set `openaiResponsesUrl` to that gateway's full Responses endpoint. The default remains `https://api.openai.com/v1/responses`.

For sandboxed networks that provide outbound proxy transport through environment variables, set `ssrf.trustEnvProxy` to `true` to skip local DNS preflight for proxied hostnames:

```json
{
  "ssrf": {
    "trustEnvProxy": true
  }
}
```

This is an opt-in DNS-preflight adjustment, not proxy transport configuration. `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` are recognized; `NO_PROXY` hosts still undergo DNS validation, and localhost or literal private IP targets remain blocked.

Optional dependencies for video frame extraction:

```bash
brew install ffmpeg   # frame extraction, video thumbnails, local video duration
brew install yt-dlp   # YouTube stream URLs for frame extraction
```

Without these, video content analysis (transcripts, visual descriptions via Gemini) still works. The binaries are only needed for extracting individual frames as images.

Requires Pi v0.37.3+.

## Quick Start

```typescript
// Search the web
web_search({ query: "TypeScript best practices 2025" })

// Fetch a page
fetch_content({ url: "https://docs.example.com/guide" })

// Clone a GitHub repo
fetch_content({ url: "https://github.com/owner/repo" })

// Understand a YouTube video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })

// Analyze a screen recording
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Tools

### web_search

Search the web via OpenAI, Brave, Parallel, TinyFish, Search1API, Searchinfinity, Querit, Tavily, Jina, SERPdive, Kagi, Ollama, AnySearch, xAI, Bright Data SERP, SerpBase, self-hosted SearXNG, Exa, Perplexity AI, or Gemini. Returns a synthesized answer with source citations.

```typescript
web_search({ query: "rust async programming" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", provider: "openai" })
web_search({ query: "...", provider: "all" })
web_search({ query: "...", includeContent: true })
web_search({ queries: ["query 1", "query 2"], workflow: "none" })
web_search({ queries: ["query 1", "query 2"], workflow: "summary-review" })
web_search({ queries: ["query 1", "query 2"], workflow: "auto-summary" })
```

| Parameter | Description |
| ----------- | ------------- |
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `provider` | Configured provider when omitted or set to `auto`; `all` searches every eligible provider except AnySearch, xAI, Bright Data, and SerpBase simultaneously; otherwise `openai`, `brave`, `parallel`, `tinyfish`, `search1api`, `searchinfinity`, `querit`, `tavily`, `jina`, `serpdive`, `kagi`, `ollama`, `anysearch`, `xai`, `brightdata`, `serpbase`, `searxng`, `exa`, `perplexity`, or `gemini` (auto-selects when no provider or routing is configured; AnySearch, xAI, Bright Data, and SerpBase are explicit-only) |
| `includeContent` | Fetch full page content from sources in background |
| `workflow` | `none` (skip curator), `summary-review` (open curator and auto-generate a summary draft, default), or `auto-summary` (generate a summary without opening the curator) |

### fetch_content

Fetch URL(s) as readable markdown, exact textual HTTP bodies, direct images, or page-grounded answers. Automatically detects and handles GitHub repos, YouTube videos, PDFs, local video files, images, and regular web pages.

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 4 })
fetch_content({ url: "https://example.com/api", mode: "raw" })
fetch_content({ url: "https://example.com/guide", mode: "answer", prompt: "What are the installation steps?" })
fetch_content({ url: "https://example.com/diagram.png" })
```

| Parameter | Description |
| ----------- | ------------- |
| `url` / `urls` | Single URL/path or multiple URLs |
| `prompt` | Question for video analysis, or the page-local question required by `mode: "answer"` |
| `mode` | `readable` (default), `raw` for exact textual HTTP bodies, or `answer` for a grounded answer from fetched content |
| `answerModel` | Optional `provider/model-id` override for answer mode; defaults to the current enabled Pi model |
| `timestamp` | Extract frame(s) — single (`"23:41"`), range (`"23:41-25:00"`), or seconds (`"85"`) |
| `frames` | Number of frames to extract (max 12) |
| `forceClone` | Clone GitHub repos that exceed the 350MB size threshold |

### get_search_content

Retrieve stored content from previous searches or fetches. Fetched URL content is stored in full, including when `fetch_content` uses answer mode. Use `findText` to locate bounded matching passages without paging through a large page, or use `offset` and `limit` to retrieve slices intentionally.

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://...", offset: 30000 })
get_search_content({ responseId: "abc123", query: "original query" })
get_search_content({ responseId: "abc123", urlIndex: 0, findText: "installation" })
get_search_content({ responseId: "abc123", urlIndex: 0, findText: ["timeout", "retry"], findMode: "fuzzy" })
```

`findMode` supports `exact`, `case-insensitive` (default), and `fuzzy`. Finder output is capped at 20,000 characters with match counts and nearby context. `findText` cannot be combined with `offset` or `limit`.

### source_check

Check a claim and return a machine-readable artifact with exact passage citations. Search results are deduplicated and capped at 20 sources; `fetchContent` fetches at most 5 pages, while stored and retrieved content remains subject to the existing 30,000-character `offset`/`limit` bounds.

```typescript
source_check({ claim: "The API supports streaming responses" })
source_check({
  claim: "The API supports streaming responses",
  queries: ["API streaming responses documentation", "API streaming limitations"],
  fetchContent: true,
  domainFilter: ["docs.example.com", "-old.example.com"]
})
```

The artifact includes `supported`, `contradicted`, `unclear`, or `missing-evidence` claim status, source quality hints, SHA-256 content hashes, and passage IDs with exact source offsets. Search and fetch errors remain in the artifact instead of being silently discarded. Artifacts are stored with the session and retrieved through `get_search_content` using the returned `responseId`; paged artifact responses are JSON slices, so request the next `offset` when needed.

## Capabilities

### GitHub repos

GitHub URLs are cloned locally instead of scraped. The agent gets real file contents and a local path to explore with `read` and `bash`. Root URLs return the repo tree + README, `/tree/` paths return directory listings, `/blob/` paths return file contents.

Repos over 350MB get a lightweight API-based view instead of a full clone (override with `forceClone: true`). Commit SHA URLs are handled via the API. Clones are cached for the session and wiped on session change. Private repos require the `gh` CLI. Set `githubClone.enabled` to `false` to skip this GitHub-specific clone/API handling; `fetch_content` remains available, so the URL can continue through the normal HTTP extraction path.

### YouTube videos

YouTube URLs are processed via Gemini for full video understanding — visual descriptions, transcripts with timestamps, and chapter markers. Pass a `prompt` to ask specific questions about the video. Results include the video thumbnail so the agent gets visual context alongside the transcript.

Fallback: Gemini Web when browser cookies are enabled → Gemini API → Perplexity (text summary only). Handles all URL formats: `/watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/`, `/v/`.

### Local video files

Pass a file path (`/`, `./`, `../`, or `file://` prefix) to analyze video content via Gemini. Supports MP4, MOV, WebM, AVI, and other common formats up to 50MB for Gemini analysis. Pass a `prompt` to ask about specific content. If ffmpeg is installed, a thumbnail frame is included alongside the analysis. Timestamp/frame extraction uses ffmpeg directly and can still operate on larger local files.

Fallback: Gemini API (Files API upload) → Gemini Web when browser cookies are enabled.

### Video frame extraction

Use `timestamp` and/or `frames` on any YouTube URL or local video file to extract visual frames as images.

```typescript
fetch_content({ url: "...", timestamp: "23:41" })                       // single frame
fetch_content({ url: "...", timestamp: "23:41-25:00" })                 // range, 6 frames
fetch_content({ url: "...", timestamp: "23:41-25:00", frames: 3 })      // range, custom count
fetch_content({ url: "...", timestamp: "23:41", frames: 5 })            // 5 frames at 5s intervals
fetch_content({ url: "...", frames: 6 })                                // sample whole video
```

Requires `ffmpeg` (and `yt-dlp` for YouTube). Timestamps accept `H:MM:SS`, `MM:SS`, or bare seconds.

### PDFs

PDF URLs are converted to Markdown and saved under the temporary `pi-web-pdf` directory by default so the agent can `read` specific sections without loading the full document into context. Three engines are available, selected with `pdf.provider` (`"auto"` is the default):

| Provider | Engine | Trade-offs |
| --- | --- | --- |
| `datalab` | Datalab hosted conversion (Marker) | Deterministic layout-aware output — tables, multi-column reading order, headings, math; `accurate` mode handles scanned pages; may return a `parse_quality_score`; requires a Datalab key, billed per page with a free monthly credit |
| `gemini` | Gemini API (vision LLM) | Best on scanned/complex pages; LLM transcription can occasionally drift or truncate; requires a Gemini key |
| `unpdf` | Local pdf.js text extraction | Free, offline, no key; flattened text only — no layout, no tables, no OCR |

`auto` order: Datalab (when a key is configured) → Gemini (when a key is configured) → local `unpdf`. Datalab runs first for layout-aware conversion. If its request fails — including after free-tier credit is exhausted — the chain continues to Gemini, then `unpdf`, automatically. Setting `pdf.provider` to `gemini`, `datalab`, or `unpdf` pins that engine and skips the other remote tiers (an explicit engine still falls back to `unpdf` when it errors, except for credential/config errors and caller cancellation). No Datalab key means the `datalab` tier is simply skipped — behavior is unchanged for existing users.

**Why Datalab.** The hosted converter uses a dedicated extraction engine (Marker) intended to retain document structure such as tables, multi-column reading order, headings, links, and math, where local `unpdf` extraction only yields flattened text. It is deterministic rather than LLM-based. Completed responses may include a `parse_quality_score` (0–5) for optional quality gating. Pricing is per processed page: **fast / balanced** $4 / 1,000 pages; **accurate** $10 / 1,000 pages. The free tier gives a **$10 monthly credit** (personal email; $20 with a work email) at **25 requests/minute** — roughly **2,500 pages/month free in `fast` mode** or 1,000 in `accurate` mode. Processing defaults to the **US region**. EU data residency uses **1.25× usage**; opt in with `DATALAB_PROCESSING_LOCATION=eu`.

Configure Datalab via the web-search config:

```jsonc
{
  "datalabApiKey": "$DATALAB_API_KEY",
  "pdf": {
    "maxSizeMB": 20,
    "provider": "auto",      // "auto" | "gemini" | "datalab" | "unpdf"
    "datalabMode": "balanced", // "fast" | "balanced" | "accurate"
    "datalabTimeoutMs": 120000
  }
}
```

Env vars: `DATALAB_API_KEY` (or `datalabApiKey` in config), `DATALAB_PROCESSING_LOCATION` (`us` default; `eu` enables EU data residency at 1.25× usage), `DATALAB_MODE` (`fast` / `balanced` / `accurate`), and `DATALAB_API_BASE` (custom gateway). `pdf.datalabMode` overrides `DATALAB_MODE`. The default `datalabTimeoutMs` is 120s and is capped at 300s.

> Privacy note: like the Gemini tier, the PDF bytes are sent to the Datalab cloud for conversion. Files are uploaded to the selected region's storage and deleted best-effort after conversion.

### Blocked pages

Raw and direct-image HTTP requests use the same SSRF validation, hostname domain policy, redirect checks, timeout, and 5MB streamed response bound as normal extraction. Raw mode returns textual bodies even for non-2xx responses and exposes the HTTP status in tool details; it does not run readability or hosted extraction fallbacks.

When Readability fails or returns only a cookie notice, the extension can retry configured Firecrawl extraction, Jina Reader (handles JS rendering server-side, no API key needed), TinyFish, Search1API, Querit, Kagi Extract, Ollama Web Fetch, Parallel, Bright Data Web Unlocker, Gemini URL Context API, and Gemini Web extraction when browser cookies are enabled. Configure `fetchRouting.providers` to change the order or set of `fetch_content` providers. Supported values are `http`, `firecrawl`, `jina`, `tinyfish`, `search1api`, `querit`, `kagi`, `ollama`, `parallel`, `brightdata`, and `gemini`; when absent, the default order is unchanged. For remote HTTP(S) targets, third-party hosted providers are disabled unless `fetchRouting.allowRemoteHostedProviders` is `true`, because hosted services perform their own fetch and can see a different redirect chain than the local safety gate. Firecrawl stays available as a configured extraction service. Firecrawl requests are cache-only by default and require an explicit fresh-scrape opt-in before the Firecrawl server can fetch target URLs. Bright Data Web Unlocker runs last of the remote scraping providers, ahead of only the Gemini fallbacks, because it is billed per request against a paid account; it is skipped unless both a key and an `unblocker` zone are configured. It applies no minimum-length check, so any non-empty body it returns — including a short consent or paywall stub — is the final answer for that URL and the Gemini fallbacks are not tried. Handles SPAs, JS-heavy pages, and anti-bot protections transparently. Also parses Next.js RSC flight data when present. HTML extraction also surfaces registered discovery relations (`service-desc`, `service-doc`, `service-meta`, `api-catalog`, `describedby`) from the HTTP `Link` header and matching `link`/`a[rel]` markup. Readable or rendered content remains primary; on an empty shell, the normal extraction fallbacks run before declared links are returned on their own.

## How It Works

```
web_search(query)
  → SearXNG (if configured) → OpenAI (when suitable) → Exa → Brave → Parallel → TinyFish → Search1API → Searchinfinity → Querit → Tavily → Jina → SERPdive → Perplexity → Gemini

fetch_content(url)
  → Video file?  Gemini API (Files API) → Gemini Web (if browser cookies enabled)
  → GitHub URL?  Clone repo, return file contents + local path
  → YouTube URL? Gemini Web (if browser cookies enabled) → Gemini API → Perplexity
  → HTTP fetch → PDF? Datalab → Gemini API → local text extraction, save to temp pi-web-pdf
               → HTML? Readability (+ declared Link/rel discovery) → RSC parser → Firecrawl (if configured) → third-party hosted fallbacks only when fetchRouting.allowRemoteHostedProviders is enabled
               → Text/JSON/Markdown? Return directly
```

## Commands

### /websearch

Open the search curator directly. Runs searches and lets you review, add, select results, and approve a summary before it is sent back to the agent — no LLM round-trip needed.

```
/websearch                                               # empty page, type your own searches
/websearch react hooks, next.js caching                  # pre-fill with comma-separated queries
```

Results get injected into the conversation when you approve the summary or click "Send selected results without summary". On timeout, the curator auto-submits and falls back to a deterministic summary if no approved draft is present.

### /curator

Toggle or configure the curator workflow at runtime.

```
/curator                    # toggle on/off
/curator on                 # enable curator (summary-review)
/curator off                # disable curator (raw results only)
/curator summary-review     # explicit workflow
```

Persists to `~/.pi/web-search.json` and takes effect on the next `web_search` call. When disabled, `web_search` returns raw results without opening the curator window.

### /search

Browse stored search results interactively. Lists all results from the current session with their response IDs for easy retrieval.

### /google-account

Show the active Google account currently authenticated for Gemini Web. Useful when multiple Chromium profiles exist or `chromeProfile` is set in config.

## Activity Monitor

Toggle with **Ctrl+Shift+W** to see live request/response activity:

```
─── Web Search Activity ────────────────────────────────────
  API  "typescript best practices"     200    2.1s ✓
  GET  docs.example.com/article        200    0.8s ✓
  GET  blog.example.com/post           404    0.3s ✗
────────────────────────────────────────────────────────────
```

## Configuration

Config defaults to `~/.pi/web-search.json`, or `web-search.json` under `PI_CODING_AGENT_DIR` / `XDG_CONFIG_HOME/pi` when set. Every field is optional.

```json
{
  "openaiApiKey": "sk-...",
  "openaiResponsesUrl": "https://gateway.example.com/v1/responses",
  "braveApiKey": "BSA_...",
  "exaApiKey": "exa-...",
  "parallelApiKey": "...",
  "tinyfishApiKey": "sk-tinyfish-...",
  "search1apiApiKey": "...",
  "tavilyApiKey": "tvly-...",
  "jinaApiKey": "$JINA_API_KEY",
  "serpdiveApiKey": "sd_live_...",
  "serpdiveModel": "krill",
  "kagiApiKey": "$KAGI_API_KEY",
  "ollamaApiKey": "$OLLAMA_API_KEY",
  "serpbaseApiKey": "$SERPBASE_API_KEY",
  "brightdataApiKey": "$BRIGHTDATA_API_KEY",
  "brightdataSerpZone": "pi_serp",
  "searxngBaseUrl": "https://search.example.com",
  "searxngHeaders": {
    "CF-Access-Client-Id": "xxxxxxxx.access",
    "CF-Access-Client-Secret": "xxxxxxxx"
  },
  "firecrawlBaseUrl": "https://crawl.example.com",
  "firecrawlApiKey": "fc-...",
  "firecrawlApiVersion": "v2",
  "firecrawlFreshScrape": false,
  "brightdataUnlockerZone": "pi_unlocker",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza...",
  "geminiBaseUrl": "https://my-gateway.example.com/gemini",
  "cloudflareApiKey": "...",
  "provider": "openai",
  "searchRouting": {
    "providers": ["openai", "brave", "exa"],
    "fallbackOn": ["transient", "quota", "network"]
  },
  "fetchRouting": {
    "providers": ["http", "firecrawl", "jina", "tinyfish", "search1api", "querit", "kagi", "ollama", "parallel", "brightdata", "gemini"],
    "allowRemoteHostedProviders": false
  },
  "webSearch": {
    "enabled": true
  },
  "chromeProfile": "Profile 2",
  "allowBrowserCookies": false,
  "searchModel": "gemini-3.6-flash",
  "summaryModel": "anthropic/claude-haiku-4-5",
  "workflow": "summary-review",
  "curatorTimeoutSeconds": 20,
  "curatorRemote": {
    "host": "my-box.tailnet.ts.net",
    "bind": "100.101.102.103"
  },
  "autoOpenBrowser": true,
  "githubClone": {
    "enabled": true,
    "maxRepoSizeMB": 350,
    "cloneTimeoutSeconds": 30,
    "clonePath": "/tmp/pi-github-repos"
  },
  "youtube": {
    "enabled": true,
    "preferredModel": "gemini-3.6-flash"
  },
  "video": {
    "enabled": true,
    "preferredModel": "gemini-3.6-flash",
    "maxSizeMB": 50
  },
  "pdf": {
    "maxSizeMB": 20,
    "provider": "auto"
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": ["example.com"],
      "deny": ["blocked.example.com"]
    }
  },
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  },
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"],
    "trustEnvProxy": false
  }
}
```

All provider API-key fields (`openaiApiKey`, `braveApiKey`, `parallelApiKey`, `tinyfishApiKey`, `search1apiApiKey`, `searchinfinityApiKey`, `queritApiKey`, `tavilyApiKey`, `jinaApiKey`, `serpdiveApiKey`, `kagiApiKey`, `ollamaApiKey`, `serpbaseApiKey`, `anysearchApiKey`, `xaiApiKey`, `brightdataApiKey`, `firecrawlApiKey`, `exaApiKey`, `perplexityApiKey`, `geminiApiKey`, `datalabApiKey`, and `cloudflareApiKey`) accept explicit credential sources. Use `$NAME` or `${NAME}` to read one named environment variable, or prefix a trusted local shell command with `!` to resolve one value at provider request time. Escape `$$` as a literal leading `$` and `$!` as a literal leading `!`:

```json
{
  "openaiApiKey": "!/absolute/path/to/secret-manager read openai",
  "braveApiKey": "${SCOPED_BRAVE_API_KEY}",
  "exaApiKey": "$$literal-key",
  "geminiApiKey": "$!literal-command"
}
```

This syntax applies to provider credentials only; other configuration fields are not interpolated. `firecrawlApiKey`, `kagiApiKey`, `ollamaApiKey`, `serpbaseApiKey`, and `brightdataApiKey` use the same credential-source rules, while `firecrawlBaseUrl`, `firecrawlApiVersion`, `firecrawlFreshScrape`, `brightdataSerpZone`, and `brightdataUnlockerZone` are literal config values.

A command source is not run while the extension loads or registers tools. Each selected provider request runs it again with a five-second timeout, a 16 KiB output limit, a minimized environment, and a one-line non-empty stdout requirement. Command text and stderr are omitted from errors. These commands are trusted local configuration, not a same-user process isolation boundary; use absolute executable paths and protect the config file. `OP_SESSION_*` variables are forwarded to trusted resolver commands so shell-local 1Password sessions can be reused without storing them in config. An explicit source overrides legacy provider environment variables and fails that provider locally rather than falling back with a stale credential. Direct Google Gemini API requests send the resolved key only in the `x-goog-api-key` header, never in the URL.

`fetchContent.domainPolicy` is an optional hostname allow/deny policy for `fetch_content` target URLs. It is off when omitted. Each bare hostname matches itself and its subdomains; `deny` wins when a hostname matches both lists. The policy is checked before HTTP(S) target handling and before each redirect followed by this extension's own fetch path. Local file paths and non-HTTP sources are not subject to this policy. It is an additional restriction: the existing SSRF guard still blocks private and internal destinations. Remote extraction services can still perform their own DNS, redirects, and egress after this extension preflights the submitted target URL, so third-party hosted HTTP(S) fallbacks stay disabled unless `fetchRouting.allowRemoteHostedProviders` is enabled for separately isolated provider deployments.

Set `searxngBaseUrl` or `SEARXNG_BASE_URL` to use a self-hosted SearXNG JSON API. A configured endpoint is preferred first in `auto` mode for local/private search. Its base URL and redirects remain subject to the SSRF guard; add only the narrowest self-hosted range to `ssrf.allowRanges` when it resolves to a private or synthetic range. Optional `searxngHeaders` merges extra HTTP headers into each SearXNG request (string values only; invalid header names are ignored), which is useful for reverse-proxy or Zero Trust auth such as Cloudflare Access service tokens (`CF-Access-Client-Id` / `CF-Access-Client-Secret`). Configured headers override the default `Accept: application/json` when the same name is supplied. Thanks to Marcos A. Núñez (@marnunez) for PR #107 and Avinash Kanaujiya (@avinashkanaujiya) for issue #105.

Set `firecrawlBaseUrl` or `FIRECRAWL_BASE_URL` to use Firecrawl as an extraction-only fallback for `fetch_content`. It calls `/v2/scrape` by default; set `firecrawlApiVersion` or `FIRECRAWL_API_VERSION` to `v1` for older self-hosted images. Firecrawl requests are cache-only by default (`lockdown: true`), so the Firecrawl server does not make fresh outbound target requests unless you explicitly set `firecrawlFreshScrape: true` or `FIRECRAWL_FRESH_SCRAPE=1`. Enable fresh scraping only for a Firecrawl deployment whose own egress, redirects, DNS rebinding behavior, and internal-network access are isolated or allowlisted; this extension can preflight the submitted URL but cannot control network requests made by the Firecrawl server. The configured Firecrawl API base URL and redirects are still validated by the same SSRF guard as other remote requests, and Firecrawl credentials are stripped from cross-origin API redirects.

**Bright Data.** Set `brightdataApiKey` or `BRIGHTDATA_API_KEY` to use Bright Data-backed features. The SERP search provider also requires `brightdataSerpZone` or `BRIGHTDATA_SERP_ZONE`, and the Web Unlocker extraction fallback also requires `brightdataUnlockerZone` or `BRIGHTDATA_UNLOCKER_ZONE`. These zone settings are separate and are never substituted for each other: SERP requires a Bright Data zone of type `serp`, while Web Unlocker requires a zone of type `unblocker`. Leaving either zone unset keeps that product unavailable, so enabling one Bright Data feature does not opt into the other.

Bright Data search is explicit-only. Select it with `provider: "brightdata"` or place it in `searchRouting`; it is never chosen by `auto` and never participates in `provider: "all"`. The SERP path maps domain filters to Google `site:` clauses and recency filters to Google `tbs` parameters, validates the returned SERP envelope, and surfaces provider errors instead of converting them to empty results.

Bright Data Web Unlocker is a paid `fetch_content` fallback after Parallel and before Gemini. It validates the target URL with the local SSRF guard before resolving credentials or sending any request to Bright Data, validates redirects from the Bright Data API endpoint, and strips authorization across cross-origin API redirects. As with any remote extraction service, Bright Data fetches the submitted target from its own infrastructure; keep `brightdataUnlockerZone` unset for URLs that must not be disclosed to a third party. Successful Unlocker responses are returned as Markdown, including short pages or consent stubs, because the request has already been billed and discarding the body would hide what Bright Data saw.

**Kagi.** Set `kagiApiKey` or `KAGI_API_KEY` to use Kagi Search API as a normal configured search provider. It maps `numResults` to Kagi's `limit` parameter and returns Kagi result snippets; when Kagi includes extracted Markdown in the search response, `includeContent` exposes it as inline content. Kagi Extract is also available as a `fetch_content` fallback after Querit and before Ollama/Parallel. The target URL is validated locally before the API request and Kagi authorization is stripped across cross-origin API redirects.

**Ollama.** Set `ollamaApiKey` or `OLLAMA_API_KEY` to use Ollama Cloud Web Search without running a local daemon. The same account key used for Ollama Cloud inference authenticates `POST https://ollama.com/api/web_search`, with `numResults` capped to Ollama's documented max of 10. Ollama Web Fetch is available as a `fetch_content` fallback after Kagi and before Parallel, with local target validation before the Cloud request.

**SerpBase.** Set `serpbaseApiKey` or `SERPBASE_API_KEY` and select `provider: "serpbase"` to query SerpBase's Google Search Results API. SerpBase is explicit-only: it is never chosen by `auto` and never participates in `provider: "all"`, because each request can consume paid Google SERP credits. Domain filters are sent as Google `site:` clauses and reapplied locally; recency maps to Google's `tbs` time filter.

Without an explicit `$` or `!` source, `OPENAI_API_KEY`, `BRAVE_API_KEY`, `PARALLEL_API_KEY`, `TINYFISH_API_KEY`, `SEARCH1API_KEY`, `SEARCHINFINITY_API_KEY`, `QUERIT_API_KEY`, `TAVILY_API_KEY`, `JINA_API_KEY`, `SERPDIVE_API_KEY`, `KAGI_API_KEY`, `OLLAMA_API_KEY`, `SERPBASE_API_KEY`, `ANYSEARCH_API_KEY`, `XAI_API_KEY`, `BRIGHTDATA_API_KEY`, `FIRECRAWL_API_KEY`, `EXA_API_KEY`, `GEMINI_API_KEY`, `DATALAB_API_KEY`, `DATALAB_PROCESSING_LOCATION`, `DATALAB_MODE`, `DATALAB_API_BASE`, `PERPLEXITY_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, and `CLOUDFLARE_API_KEY` env vars retain their existing precedence over literal config file values. `openaiResponsesUrl` can point OpenAI `web_search` and `source_check` at a third-party gateway that supports the OpenAI Responses API and web search tool; it is an explicit endpoint override, not derived from Pi model provider settings, and defaults to `https://api.openai.com/v1/responses`. `openaiSearchModel` pins the model id used for OpenAI `web_search`, bypassing automatic selection (newest terra-tier model); the id is sent verbatim with whichever OpenAI auth resolves, so gateway-only model ids work too. `xaiSearchModel` similarly pins the xAI search model. Configured Exa API keys use Exa's own account limits directly; any legacy local `exa-usage.json` file is ignored. `GOOGLE_GEMINI_BASE_URL` overrides the Gemini API host for Gemini generate-content calls such as search, URL context, YouTube, and local video analysis. Set it to a bare host with no trailing slash and no version segment, for example `https://my-gateway.example.com/gemini`; `geminiBaseUrl` is the config-file equivalent. When the configured host contains `gateway.ai.cloudflare.com`, authentication uses `cf-aig-authorization: Bearer <token>` from `CLOUDFLARE_API_KEY` or `cloudflareApiKey`, and `GEMINI_API_KEY` is not required for generate-content calls. Local video file upload still uses Google's Files API directly, so gateway-only video extraction falls back to Gemini Web unless a `GEMINI_API_KEY` is also configured. `provider` or `searchProvider` sets the default search provider and is used when a tool call omits `provider` or sends `"auto"`: `"all"`, `"openai"`, `"brave"`, `"parallel"`, `"tinyfish"`, `"search1api"`, `"searchinfinity"`, `"querit"`, `"tavily"`, `"jina"`, `"serpdive"`, `"kagi"`, `"ollama"`, `"anysearch"`, `"xai"`, `"brightdata"`, `"serpbase"`, `"searxng"`, `"exa"`, `"perplexity"`, or `"gemini"`. AnySearch, xAI, Bright Data, and SerpBase are never selected by `auto`; choose them explicitly or place them in `searchRouting`. If either single-provider field is configured, it takes precedence over `searchRouting`. Otherwise, `searchRouting` can opt into an ordered `providers` list and an explicit `fallbackOn` list containing `"transient"`, `"quota"`, and/or `"network"`; only those typed failures continue to the next available candidate. `"all"` is not valid inside `searchRouting.providers`, because that list defines sequential fallback rather than multi-provider aggregation. Named providers remain strict, and exhausted routes return per-provider diagnostics. `provider` can also be a non-empty array of named providers such as `["brave", "exa"]`; those providers run concurrently using the same aggregation path as `"all"`, while `"auto"` and `"all"` are invalid inside arrays. Random, weighted, sticky, and cooldown routing are not enabled. This is also updated automatically when you change the provider in the curator UI. Set `webSearch.enabled` to `false` to unregister the configured search and source-check tools while leaving fetch/content tools available. `toolNames` can opt into alternate public tool names for environments where another extension or model reserves the defaults, without changing behavior: `webSearch`, `sourceCheck`, `fetchContent`, and `getSearchContent` default to `web_search`, `source_check`, `fetch_content`, and `get_search_content`. `workflow` sets the default search workflow: `"summary-review"` (default, opens curator with auto-generated summary draft), `"auto-summary"` (returns a model-generated summary without opening the curator), or `"none"` (raw results, no curator). Overridden per-call via the `workflow` parameter on the configured search tool, or toggled at runtime with `/curator`. `chromeProfile` pins Gemini Web cookie lookup to a specific Chromium profile. When omitted, detected Chromium profiles are scanned in stable order and the first profile containing the required Gemini cookies is used. `allowBrowserCookies` enables Chromium cookie extraction for Gemini Web; it defaults to `false` to avoid browser data access and surprise macOS Keychain prompts. You can also set `PI_ALLOW_BROWSER_COOKIES=1`. Cookie databases are copied to a temporary read-only working copy; the reader uses `node:sqlite` when available and otherwise tries the `sqlite3` CLI or Python's standard-library SQLite module. `searchModel` overrides the Gemini API model used by the configured search tool without changing URL, YouTube, or video extraction defaults. Gemini API grounded search uses `gemini-3.6-flash` by default; set `searchModel` to choose another model. Gemini Web browser-cookie fallback uses its separate `gemini-3.1-pro` default because Gemini Web relies on private header values; explicitly configured unsupported Web models fail instead of silently falling back to 2.5 Flash. `summaryModel` sets the default model used for generating summary drafts in the curator UI and `auto-summary` mode (e.g. `"anthropic/claude-haiku-4-5"`, `"openai-codex/gpt-5.3-codex-spark"`, or `"openrouter/nvidia/nemotron-3-super-120b-a12b:free"`). Preferred summary and query-rewrite models also resolve through routed provider registrations such as OpenRouter when the native provider is unavailable. When Pi `enabledModels` is configured, summaries are limited to that allowlist; if no enabled summary model is available, the tool returns a deterministic summary instead of calling an unrelated model. `curatorTimeoutSeconds` controls the initial curator idle timeout (default `20`, max `600`); users can still adjust the timer in the curator UI. `ssrf.allowRanges` lists CIDR ranges (e.g. `"198.18.0.0/15"`, `"fd00::/8"`) exempted from the SSRF guard that otherwise blocks private/reserved IP ranges. This unblocks `fetch_content`/`web_search` on hosts whose network proxy runs in TUN + fake-IP mode (Surge, Clash, Mihomo, Stash, ...), where public domains resolve into a synthetic reserved range. It is **off by default** — the guard stays fully enabled unless you list ranges here. Use the narrowest range that covers your proxy's fake-IP pool. All-address CIDRs such as `0.0.0.0/0` and `::/0` are rejected. `ssrf.trustEnvProxy` is a separate opt-in for sandboxed environments with valid HTTP(S) proxy env vars; it skips local DNS preflight only for proxied hostnames and still blocks localhost, literal private IPs, and `NO_PROXY` matches. It does not configure proxy transport.

### All providers

Set `provider: "all"` on `web_search` or `source_check`, or configure `"provider": "all"` as the default, to run the same query against every eligible search provider simultaneously. AnySearch, xAI, Bright Data, and SerpBase are always excluded because they are explicit-only; Bright Data and SerpBase are paid Google SERP providers, so `all` never spends on them. Exa remains eligible through its zero-config MCP path, OpenAI can use Pi auth, and other API-backed search providers participate when their API key, local endpoint, or gateway makes them available. Browser-cookie access alone does not opt Gemini into `all`; select Gemini explicitly or configure its API/gateway. Firecrawl is an extraction backend, not a search provider, so it is not part of `all`.

Successful provider answers are preserved separately while source URLs and inline content are deduplicated, and one provider failure does not discard the other results. If every participating provider fails, the tool returns per-provider diagnostics. In the Curator, **All** can also be selected like the other provider buttons. Each participating provider gets its own result card, including a provider badge and independent selection checkbox; failed providers get their own disabled error card. The final summary is generated from the selected provider cards and is what Pi receives. Outside the Curator, the same provider answers remain available as labeled sections in one tool response.

### Jina Search

`jinaApiKey` enables [Jina Search](https://s.jina.ai); alternatively, set `JINA_API_KEY`. The key may be a literal, an environment-variable reference, or a trusted command credential source:

```json
{
  "jinaApiKey": "$JINA_API_KEY",
  "provider": "jina"
}
```

Setting `provider` is optional. In `auto` mode, Jina is tried after Tavily and before SERPdive. It can also be selected per request with `provider: "jina"`, included in provider arrays or `provider: "all"`, or placed in `searchRouting.providers`.

Jina Search maps `numResults` to its bounded `count` parameter, sends included domains as `site` filters, and adds excluded domains and recency constraints to the search query. Without `includeContent`, it requests SERP metadata only. With `includeContent: true`, Jina visits matching pages and returns their Markdown inline, so requests can take longer and consume more Jina tokens. The fixed hosted endpoint is `https://s.jina.ai`; no custom endpoint is configured by this extension.

### TinyFish

`tinyfishApiKey` enables the TinyFish Search and Fetch APIs; alternatively, set `TINYFISH_API_KEY`. Get an API key from the [TinyFish API Keys](https://agent.tinyfish.ai/api-keys) page. Like the other provider keys, `tinyfishApiKey` can contain a literal key, an environment-variable reference, or a trusted command credential source:

```json
{
  "tinyfishApiKey": "$TINYFISH_API_KEY",
  "provider": "tinyfish"
}
```

Setting `provider` is optional. In `auto` mode, an available TinyFish provider is tried after Parallel and before Search1API. You can also select it per request with `provider: "tinyfish"` or place `"tinyfish"` in `searchRouting.providers`.

TinyFish Search supports the shared `numResults`, `recencyFilter`, and include/exclude `domainFilter` options. Requests above 10 results use TinyFish pagination. When `includeContent` is true, result URLs are sent to TinyFish Fetch in batches of up to 10 and returned as inline Markdown content. TinyFish Fetch is also used as a hosted `fetch_content` fallback after Jina Reader and before Search1API.

The stable Search (`https://api.search.tinyfish.ai`) and Fetch (`https://api.fetch.tinyfish.ai`) endpoints are built in, so no base URL setting is required. TinyFish currently documents both APIs as credit-free, with Free-plan limits of 30 search requests per minute and 150 fetched URLs per minute; an API key is still required. See the [TinyFish Search reference](https://docs.tinyfish.ai/search-api/reference) and [TinyFish Fetch reference](https://docs.tinyfish.ai/fetch-api/reference).

### Search1API

`search1apiApiKey` enables [Search1API](https://www.search1api.com) Search and Crawl; alternatively, set `SEARCH1API_KEY`. Create a key in the [Search1API dashboard](https://dashboard.search1api.com). Like the other provider keys, `search1apiApiKey` can contain a literal key, an environment-variable reference, or a trusted command credential source:

```json
{
  "search1apiApiKey": "$SEARCH1API_KEY",
  "provider": "search1api"
}
```

Setting `provider` is optional. In `auto` mode, an available Search1API provider is tried after TinyFish and before Searchinfinity. You can also select it per request with `provider: "search1api"`, include it in provider arrays or `provider: "all"`, or place `"search1api"` in `searchRouting.providers`.

Search1API Search supports the shared `numResults`, `recencyFilter`, and include/exclude `domainFilter` options. When `includeContent` is true, it maps to Search1API Deep Search and returns successfully crawled result content inline. The Search1API Crawl endpoint is also used as a hosted `fetch_content` fallback after Jina Reader and TinyFish, before Parallel.

Search1API is credit-based. A basic search costs 1 credit; Deep Search adds 1 credit for each result page crawled successfully, and a Crawl request costs 1 credit. The extension never enables Deep Search unless `includeContent` is true. See the [Search API guide](https://www.search1api.com/docs/basic/search), [Crawl API guide](https://www.search1api.com/docs/basic/crawl), and [credit rules](https://www.search1api.com/docs/essentials/credits-and-limits).

### Searchinfinity

`searchinfinityApiKey` enables [Byteplus Searchinfinity](https://docs.byteplus.com/en/docs/searchinfinity/) web search (the Global edition of Volcengine 豆包搜索); alternatively, set `SEARCHINFINITY_API_KEY`. Create a key in the [Searchinfinity console](https://console.byteplus.com/search-infinity/api-key). Like the other provider keys, `searchinfinityApiKey` can contain a literal key, an environment-variable reference, or a trusted command credential source:

```json
{
  "searchinfinityApiKey": "$SEARCHINFINITY_API_KEY",
  "provider": "searchinfinity"
}
```

Setting `provider` is optional. In `auto` mode, an available Searchinfinity provider is tried after Search1API and before Querit. You can also select it per request with `provider: "searchinfinity"`, include it in provider arrays or `provider: "all"`, or place `"searchinfinity"` in `searchRouting.providers`.

Searchinfinity Search supports the shared `numResults` (max 20 per request), `recencyFilter`, and include/exclude `domainFilter` options (up to 5 domains each). Answers are assembled from the model-generated per-result summaries when present, falling back to plain snippets. Accounts include a monthly free search quota shared with the Custom edition; API Key requests are limited to 5 QPS and a 30-second server-side timeout. See the [Searchinfinity API reference](https://docs.byteplus.com/api/docs/searchinfinity/Searchinfinity_API_Reference).

### Querit

`queritApiKey` enables Querit Search and Contents; alternatively, set `QUERIT_API_KEY`. Create a key in the [Querit dashboard](https://www.querit.ai/en/dashboard/api-keys). Like the other provider keys, `queritApiKey` can contain a literal key, an environment-variable reference, or a trusted command credential source:

```json
{
  "queritApiKey": "$QUERIT_API_KEY",
  "provider": "querit"
}
```

Setting `provider` is optional. In `auto` mode, an available Querit provider is tried after Searchinfinity and before Tavily. You can also select it per request with `provider: "querit"`, include it in provider arrays or `provider: "all"`, or place `"querit"` in `searchRouting.providers`.

Search requests follow the official [`querit-python`](https://github.com/querit-ai/querit-python) models: `numResults` maps to `count`, include/exclude `domainFilter` values map to `filters.sites`, and recency maps to `filters.timeRange.date` (`d1`, `w1`, `m1`, or `y1`). When `includeContent` is true, result URLs are sent to `POST /v1/contents` in batches of up to 10 and returned as inline Markdown. The same Contents endpoint is used as a hosted `fetch_content` fallback after Search1API and before Parallel. Querit Search and Contents subscriptions are independent; an API key can search successfully while `/v1/contents` returns `403 No active contents subscription`.

### AnySearch

AnySearch is an explicit-only provider: it is never included in zero-config `auto` fallback or in `provider: "all"`, but it can be selected with `provider: "anysearch"`, configured as the named provider, or placed in `searchRouting`. It supports anonymous requests and optional `anysearchApiKey` / `ANYSEARCH_API_KEY` credentials. Requests intentionally send only `{ query, max_results }`; `recencyFilter`, `domainFilter`, and `includeContent` do not add API request parameters. When `includeContent` is true, returned `content` fields are exposed as inline content.

### xAI (Grok)

xAI is an explicit-only provider: it is never included in zero-config `auto` fallback or in `provider: "all"`, but it can be selected with `provider: "xai"`, configured as the named provider, or placed in `searchRouting`.

It calls xAI's Agent Tools API — the hosted `web_search` tool on `https://api.x.ai/v1/responses` — so the search runs inside Grok's own inference rather than here. Auth resolves through Pi's model registry first, which means a **SuperGrok or X Premium subscription pays for its own searches** and no `xaiApiKey` has to be configured at all; `xaiApiKey` / `XAI_API_KEY` are the fallback for pay-as-you-go API keys.

Explicit-only is deliberate. A single question typically fans out to roughly a dozen `web_search` tool calls, billed at xAI's per-call tool rate on top of tokens and drawn from the same allowance the account uses for chatting. Letting `auto` or `all` reach for it would spend a subscription the user only meant to talk to.

The model is chosen for you: the registry path walks a best-first candidate list and uses the first id Pi actually knows, so a retired model is skipped rather than sent. The API-key path has no registry to consult and starts at `grok-4.5`. `xaiSearchModel` pins the id explicitly on either path, which is the escape hatch if xAI retires a model before a release ships.

Requests send only `{ model, input, tools }`, the shape verified against a live subscription account. `recencyFilter`, `domainFilter`, and `numResults` are folded into the prompt text rather than sent as tool parameters, so an unrecognized field can never turn a search into a 400. Sources are read from `url_citation` annotations on the answer and from each `web_search_call`'s own sources; there is no top-level `citations` array on this API.

xAI's older Live Search (`search_parameters` on `/v1/chat/completions`) is deprecated and now answers HTTP 410.

### Bright Data

Bright Data SERP is a **paid, third-party search proxy**: your query, its filters, and the result URLs
it turns up all pass through Bright Data's network. It is explicit-only — never included in zero-config
`auto` fallback and never in `provider: "all"` — so adding a token never starts spending on your
behalf, and one `all` search can never bill you for a Bright Data request. Select it with
`provider: "brightdata"`, set it as the named `provider`, or place `"brightdata"` in
`searchRouting.providers`. Naming it as the provider is never quietly redirected: if the Bright Data
settings are incomplete, the search reports that rather than curating through a different provider
under Bright Data's name. A `searchRouting` list is the exception, and it behaves there exactly as it
does for every other provider in the list: an unavailable entry is skipped and the next candidate
answers the query.

It needs two settings, and it reports itself unavailable until both are present — as does a zone name
it cannot use, so a typo makes Bright Data unavailable rather than breaking `web_search` for the
providers that are configured correctly:

```json
{
  "brightdataApiKey": "$BRIGHTDATA_API_KEY",
  "brightdataSerpZone": "pi_serp",
  "provider": "brightdata"
}
```

`brightdataApiKey` (or `BRIGHTDATA_API_KEY`) is your account API token from
[Bright Data → API tokens](https://brightdata.com/cp/setting/users). This extension uses one name per
field, matching every other provider here, so if you already export that token under a different
variable name, point at it explicitly rather than expecting an alias:
`"brightdataApiKey": "$BRIGHTDATA_API_TOKEN"`. Like the other provider keys it also accepts a
`!command` credential source, resolved once per request.

**Zones.** A Bright Data zone is a named, per-product configuration on your account; requests are made
against a zone and billed to it. `brightdataSerpZone` (or `BRIGHTDATA_SERP_ZONE`) must name a zone of
type **`serp`**, created at
[Bright Data → proxies and scraping infrastructure](https://brightdata.com/cp/zones). A Web Unlocker
zone (type `unblocker`) is a different Bright Data product, priced differently, and it does not return
SERP JSON: point this setting at one and the request is still made and billed, and whatever comes back
is reported as an error rather than as zero results — an envelope with no `organic` array names the
wrong zone type as the likely cause. The two zone types are never substituted for one another. There
is deliberately no default, and no fallback to any other Bright Data zone setting you may have
configured: guessing a zone name would bill the wrong product. Every request carries the zone, and
every error about a request that was billed names it, because "which zone did I pay on" is the first
question a paid failure has to answer. The messages that name no zone are the ones with nothing to
attribute — a missing token, a rejected zone value, a config file that could not be read, or a
connection that never returned a response.

**Getting a token and a zone.** Sign up at [brightdata.com](https://brightdata.com); no credit card is
required, and adding one is a verification step only. Connecting Bright Data's MCP server to your agent
is the shortest path to a working setup: it provisions the zones for you and they draw on the same
monthly free credits. Then put the SERP zone's name in `brightdataSerpZone`. This extension does not
know or guess those names — a zone must be configured explicitly, so a stray `BRIGHTDATA_API_KEY` in
your environment cannot make Bright Data available, and nothing can be billed against a zone that may
not exist on your account.

**Cost.** One search is one billable Bright Data request against that zone, charged whether or not the
results are useful. `numResults` does not change that: one query is one request no matter how many
results come back, so a slightly larger page size is requested to leave room for local filtering.
Bright Data's free tier is 5,000 credits per month with no credit card required, and it covers the SERP
API this provider uses; credits reset to 5,000 on the first of each month and unused credits are
forfeited. Billing is a pre-paid wallet model — you are only ever charged for funds you have
explicitly deposited, and when the free credits are exhausted requests return an error rather than
incurring a charge — so accidental spend is not possible without a deliberate deposit. Two caveats:
the free credits do not cover proxy products (Datacenter / ISP / Residential) or the Browser API, none
of which this provider uses; and accounts already on custom pay-as-you-go pricing or a pre-commit plan
are not eligible for the monthly credits. An account that has never deposited funds is also capped at
1,000 requests per minute. See
[free tier](https://docs.brightdata.com/general/account/billing-and-pricing/free-tier) and
[brightdata.com/pricing](https://brightdata.com/pricing).

**Privacy.** Your query text, your `domainFilter` and `recencyFilter` values, and the ranked URLs the
search turns up are all visible to Bright Data, which runs the Google search from its own network on
your behalf. Use SearXNG instead if queries must not leave infrastructure you control. Bright Data
holds ISO/IEC 27001, 27017 and 27018 certification, SOC 2 Type II and SOC 3, states that it does not
sell or license customer data to any third party, and will delete customer data on request; traffic is
TLS 1.3 in transit and AES-256 at rest. Its published security documentation does not state a retention
period for request data itself — the queries and URLs sent — and nothing here claims one:
[security and privacy overview](https://docs.brightdata.com/general/security/security-overview#privacy-&-regulatory-compliance).

**What the request looks like.** A Google search URL — carrying your query, `site:` operators, Google's
`tbs` time filter, and `brd_json=1` — is submitted to `https://api.brightdata.com/request` with
`{ zone, format: "raw", data_format: "parsed_light" }`. Bright Data returns the SERP as JSON and this
extension reads its `organic` array.

**Filters reach the engine.** Unlike providers with no filter parameters, both shared filters are
expressed to Google itself:

- **Recency is a real filter.** `recencyFilter` maps to Google's `tbs=qdr:d|w|m|y`, so pages outside the
  window are not returned at all — not a ranking hint.
- **Domain filters are `site:` operators.** Includes become `site:example.com` (multiple includes are
  OR-ed), excludes become `-site:example.com`. Google honours these loosely, so the same filter is
  applied again to the results that come back; a host you excluded never reaches the caller.

**Output contract.** A SERP zone returns ranked links, so results are `{ title, url, snippet }` mapped
from `organic[].{title, link, description}` and the `answer` is assembled from those sources, the same
way Brave and SearXNG answers are assembled. There is no API-side answer synthesis. `includeContent` is
accepted and has no effect: `parsed_light` carries no page bodies, so `inlineContent` is never returned
and no second billable request is made behind your back. Entries with no link, and hosts your filters
exclude, are skipped.

**Failures are never silent.** A non-2xx response throws
`Bright Data API error <status> for zone <zone>` with the response body redacted of your token, so
`402`/`429` classify as `quota` and `401`/`403` as `auth` for `searchRouting.fallbackOn`. Every billed
`200` this extension cannot read throws as well, because the request was paid for and an empty result
list would report it as "the web had no answer":

- **not JSON at all** — Google's "unusual traffic" interstitial reaches you as the raw proxied body,
  quoted to the first 300 characters rather than reduced to `Unexpected token <`;
- **JSON, but Bright Data's own error envelope** — `format: "raw"` means failures like
  `{"error":"zone not found","code":"zone_missing"}` arrive with HTTP 200, and the reported message
  repeats what Bright Data said and the code it said it with;
- **JSON, but not a SERP** — an envelope with no `organic` array is reported as such, naming the
  likeliest cause (a zone that is not of type `serp`), rather than as zero results.

Quoted upstream text cannot impersonate this extension's own diagnostics, in either of the two ways
routing reads them. It cannot impersonate a status: a proxied page mentioning "Error 503" is quoted as
`upstream 503`, and because the quoted text is truncated before it is rewritten, a body engineered so
that the length cut turns a longer number into a three-digit one cannot manufacture a status either.
It cannot impersonate a rate-limit phrase: those are quoted as `upstream rate-limit notice`, so a page
saying "you have exceeded your rate limit" cannot make a billed request look like a quota failure. The
number and the wording still reach you; only this extension's own text decides how the failure is
classified. A billed `200` therefore always surfaces as an unreadable-response error, and can never be
reclassified as retryable and swallowed by `searchRouting.fallbackOn`.

Your token is removed from every quoted response body, error message and activity log line before it
is shown, and no prefix of it survives either: the parser's own message, which quotes the first
characters of a body back inside itself, is dropped rather than filtered. `web-search.json` gets the
same treatment from the other direction: if the file is not valid JSON, the error names the file, and
the parse position where the parser reports one, but repeats none of the file's own text, since that
text is where your credentials live.

A missing or malformed zone, and a missing token, all fail before any request is made. A malformed
zone is a request-path error only — it makes Bright Data report itself unavailable, and never
propagates out of provider availability into an unrelated provider's search.

Searches use a 60-second timeout and honour cancellation: aborting a `web_search` aborts the in-flight
Bright Data request rather than waiting for it.

### SERPdive

`serpdiveApiKey` enables the SERPdive provider; get a key at [serpdive.com](https://serpdive.com/dashboard/keys). `serpdiveModel` (or `SERPDIVE_MODEL`) picks the retrieval depth:

| Model | Cost | What comes back |
| --- | --- | --- |
| `krill` (default) | free, fair use | Extracted page content. No API-side answer synthesis — the answer is assembled from the sources, as for Brave and SearXNG. |
| `mako` | 1 credit | The fact-carrying sentences of each page, plus a synthesized answer. |
| `moby` | 1.5 credits | The full readable content of every page, plus a cited answer. |

The model is the only thing that decides retrieval depth: `includeContent` controls whether that content is also returned inline, it never changes the model. For full page text, set `serpdiveModel` to `moby` yourself. The default is the free tier on purpose: installing this provider never starts spending on your behalf. An unrecognised value falls back to `krill` rather than failing, so a typo cannot cost money. Current pricing: [serpdive.com/pricing](https://serpdive.com/pricing).

Two behaviours worth knowing, both consequences of the API surface:

- **Recency is a hint, not a filter.** SERPdive exposes no time-range parameter. `recencyFilter` is appended to the question ("past week"), which biases ranking toward recent pages; results outside the window can still come back.
- **Domain filters are applied locally.** SERPdive has no include/exclude domain parameter, so `domainFilter` is applied to the results that come back. It can narrow a page of results, not ask the engine for more from a given domain.

`numResults` maps to `max_results`, which the API treats as a cap between 1 and 10 — never a minimum. Values above 10 are clamped; the engine returns what it judges relevant, which is often fewer.

### Remote curator access

By default the curator HTTP server binds to `127.0.0.1` and hands out a `http://localhost:<port>/?session=<token>` URL, so it is reachable only from the machine running Pi. That is the right default and nothing below changes it unless you opt in.

Opt in when Pi runs somewhere other than where your browser is — a dev box you SSH into, a container, a remote workstation on a Tailscale/WireGuard network:

```json
{
  "curatorRemote": true
}
```

`true` derives both values: the URL host becomes `os.hostname()` and the server binds `0.0.0.0`. Either can be overridden, and you should usually override `bind`:

```json
{
  "curatorRemote": {
    "host": "my-box.tailnet.ts.net",
    "bind": "100.101.102.103"
  }
}
```

| Value | URL host | Bind address |
| --- | --- | --- |
| omitted or `false` | `localhost` | `127.0.0.1` |
| `true` | `os.hostname()` | `0.0.0.0` |
| `{ "host": "h" }` | `h` | `0.0.0.0` |
| `{ "bind": "b" }` | `os.hostname()` | `b` |
| `{ "host": "h", "bind": "b" }` | `h` | `b` |

Anything else — a string, `null`, an array — is treated as not configured and stays local.

`host` only changes the URL that gets printed; `bind` is what actually determines who can reach the server. Set them to a matching pair — a `host` that does not resolve to the interface you bound produces a link that looks right and does not load.

**Security.** Enabling this exposes the curator beyond the local machine, and `bind: "0.0.0.0"` exposes it on every interface, including untrusted networks. The only access control is the unguessable session token in the URL, carried over plain HTTP with no TLS — so the token and everything you curate are readable by anyone able to observe that traffic. Anyone who reaches the port with the token can run searches against your configured providers (spending your API credits) and edit the summary that gets returned into the agent's context. Prefer binding to one private-network interface, as in the example above, over `0.0.0.0`, and treat the curator URL as a secret. The server is short-lived — it exists only for the duration of a curation session — but it is unauthenticated apart from that token.

Remote curator sessions print the URL instead of trying to open a browser by default. Turning remote access on also raises the default curator idle timeout from 20 to 60 seconds, giving you time to notice and click that link; set `curatorTimeoutSeconds` explicitly to override. If you do want Pi to launch a browser on the remote host anyway, set `autoOpenBrowser: true` explicitly.

#### Disabling browser auto-open

`autoOpenBrowser` is also useful on its own for local sessions:

```json
{
  "autoOpenBrowser": false
}
```

When `false`, the extension never tries to open a Glimpse window or a browser and always prints the URL for you to open manually. For local-only sessions it defaults to `true`; remote curator sessions print the URL unless you set `autoOpenBrowser: true` explicitly. This is worth setting locally when you would rather paste the link into a specific browser than have one launched for you. It changes nothing about where the server binds; that is `curatorRemote`'s job alone.

### Shortcuts

Both shortcuts are configurable via `~/.pi/web-search.json`:

```json
{
  "shortcuts": {
    "curate": "ctrl+shift+s",
    "activity": "ctrl+shift+w"
  }
}
```

Values use the same format as pi keybindings (e.g. `ctrl+s`, `ctrl+shift+s`, `alt+r`). Changes take effect on next pi restart.

Set `"enabled": false` under any feature to disable it. For GitHub specifically, `githubClone.enabled: false` only skips clone/API specialization; it does not unregister `fetch_content` or block generic URL extraction. Config changes require a Pi restart.

Rate limits: Perplexity is capped at 10 requests/minute (client-side). Jina Search, TinyFish, Search1API, and Searchinfinity apply the plan limits documented by their APIs. Querit Search and Contents subscriptions are independent. Content fetches run 3 concurrent with a 30s timeout for the direct HTTP fetch of each URL. Remote extraction fallbacks carry their own budgets and are not covered by that number: Jina Reader 30s, Firecrawl 60s, Kagi Extract 60s, Ollama Web Fetch 60s, Bright Data Web Unlocker 60s, TinyFish up to 150s, Gemini 120s, Datalab 120s (capped at 300s, rate-limited to 25 requests/minute on the free tier). `pdf.maxSizeMB` defaults to 20 and is capped at 50.

## Limitations

- If the curator cannot open a browser automatically, such as in Docker, WSL, SSH, or headless environments, the running curator URL is shown in the tool output. Copy it into a browser that can reach the Pi host, or use a tunnel/port-forward when needed.
- Chromium cookie extraction for Gemini Web is opt-in via `allowBrowserCookies: true` or `PI_ALLOW_BROWSER_COOKIES=1`; no browser data or password store is touched while it is disabled. On macOS, enabling it may trigger a Keychain dialog. Required cookie names are checked before password-store access, and browser encryption passwords are cached only in-process. If `node:sqlite` is unavailable, the reader falls back to the `sqlite3` CLI or Python stdlib; `/google-account` reports a sanitized SQLite/profile/password diagnostic when extraction fails.
- YouTube private/age-restricted videos may fail on all extraction paths.
- Gemini can process videos up to ~1 hour; longer videos may be truncated.
- PDFs are text-extracted only (no OCR for scanned documents).
- GitHub branch names with slashes may misresolve file paths; the clone still works and the agent can navigate manually.
- Non-code GitHub URLs (issues, PRs, wiki) fall through to normal web extraction.

<details>
<summary>Files</summary>

| File | Purpose |
| ------ | --------- |
| `index.ts` | Extension entry, tool definitions, commands, widget |
| `curator-page.ts` | HTML/CSS/JS generation for the curator UI with markdown rendering |
| `curator-server.ts` | Ephemeral HTTP server with SSE streaming and state machine |
| `summary-review.ts` | Summary prompt construction, model-based draft generation, and deterministic fallback summary |
| `openai-search.ts` | OpenAI Responses API web search provider with Codex/API-key auth |
| `brave.ts` | Brave Search API provider |
| `parallel.ts` | Parallel search provider and extraction fallback |
| `brightdata-unlocker.ts` | Bright Data Web Unlocker extraction fallback |
| `tinyfish.ts` | TinyFish Search and Fetch API provider |
| `search1api.ts` | Search1API Search and Crawl API provider |
| `searchinfinity.ts` | Byteplus Searchinfinity search provider |
| `querit.ts` | Querit Search and Contents API provider |
| `tavily.ts` | Tavily Search API provider |
| `jina-search.ts` | Jina Search API provider |
| `serpdive.ts` | SERPdive Search API provider |
| `kagi.ts` | Kagi Search API provider and Extract API fallback |
| `ollama.ts` | Ollama Cloud Web Search provider and Web Fetch fallback |
| `brightdata.ts` | Explicit-only Bright Data SERP search provider |
| `serpbase.ts` | Explicit-only SerpBase Google SERP provider |
| `anysearch.ts` | Explicit-only AnySearch search provider |
| `xai-search.ts` | Explicit-only xAI (Grok) hosted web_search provider |
| `searxng.ts` | Self-hosted SearXNG JSON API search provider |
| `exa.ts` | Exa.ai search provider — direct API and MCP proxy |
| `extract.ts` | URL/file path routing, HTTP extraction, fallback orchestration |
| `content-find.ts` | Bounded exact, case-insensitive, and fuzzy passage lookup |
| `page-query.ts` | Grounded page-local answer generation with model context budgeting |
| `gemini-search.ts` | Single-provider, ordered-fallback, and simultaneous all-provider search aggregation |
| `gemini-url-context.ts` | Gemini URL Context + Web extraction fallbacks |
| `gemini-web.ts` | Gemini Web client (cookie auth, StreamGenerate) |
| `gemini-web-config.ts` | Gemini Web profile and browser-cookie opt-in config |
| `gemini-api.ts` | Gemini REST API client (generateContent) |
| `chrome-cookies.ts` | macOS/Linux Chromium-based cookie extraction (Keychain/secret-tool + SQLite) |
| `youtube-extract.ts` | YouTube detection, three-tier extraction, frame extraction |
| `video-extract.ts` | Local video detection, Files API upload, Gemini analysis |
| `github-extract.ts` | GitHub URL parsing, clone cache, content generation |
| `github-api.ts` | GitHub API fallback for large repos and commit SHAs |
| `perplexity.ts` | Perplexity API client with rate limiting |
| `datalab-pdf-extract.ts` | Datalab hosted PDF-to-Markdown conversion client (upload → convert → poll) |
| `pdf-extract.ts` | PDF text extraction, saves to markdown |
| `rsc-extract.ts` | RSC flight data parser for Next.js pages |
| `utils.ts` | Shared formatting and error helpers |
| `storage.ts` | Session-aware result storage |
| `activity.ts` | Activity tracking for the observability widget |

</details>
