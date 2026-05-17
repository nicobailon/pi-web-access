---
title: Replace Gemini API and Tavily MCP with Firecrawl and agent-browser-stealth in pi-web-access
date: 2026-05-17
category: tooling-decisions
module: pi-web-access
problem_type: tooling_decision
component: tooling
severity: medium
applies_when:
  - "Refactoring a Pi extension that depends on external API services"
  - "Replacing proprietary AI APIs with open web scraping tools"
  - "Migrating from cookie-based browser auth to stealth browser automation"
tags: [firecrawl, gemini-api, tavily, agent-browser-stealth, pi-extension, web-search, content-extraction]
---

# Replace Gemini API and Tavily MCP with Firecrawl and agent-browser-stealth in pi-web-access

## Context

The `pi-web-access` extension provided web search, URL content extraction, YouTube video understanding, and local video analysis capabilities. It depended on:

- **Gemini API** (`gemini-api.ts`) — web search grounding, URL context extraction, video analysis
- **Gemini Web** (`gemini-web.ts`) — cookie-based browser authentication for Gemini
- **Tavily MCP** — web search provider (removed entirely)

These dependencies were being replaced with:
- **Firecrawl** — web search (`firecrawl_search`) and URL scraping (`firecrawl_scrape`)
- **agent-browser-stealth** — undetectable browser automation for cookie access and anti-bot bypass

## Guidance

### Firecrawl Invocation Strategy

Firecrawl is available as a Pi MCP tool (`@benvargas/pi-firecrawl`) but the extension runs as a standalone Node.js module. The extension calls Firecrawl's REST API directly (`https://api.firecrawl.dev/v1/search` and `/v1/scrape`), requiring the user to set `FIRECRAWL_API_KEY` in `~/.pi/web-search.json`. This follows the same pattern already used by the `@benvargas/pi-firecrawl` extension itself.

### Browser Automation Strategy

`gemini-web.ts` (cookie extraction + Gemini API calls) is replaced by `browser-stealth.ts` which uses the `agent-browser-stealth` CLI to:
1. Navigate to gemini.google.com and extract session cookies (for Gemini Web fallback)
2. Scrape anti-bot protected pages that block standard HTTP

### Provider Fallback Chain (New)

**Search:** Exa → Perplexity → Firecrawl → agent-browser-stealth (Gemini Web)
**Content Extraction:** HTTP + Readability → Firecrawl scrape → Jina Reader → agent-browser-stealth → Gemini Web (cookie)

## Why This Matters

1. **Reduced vendor lock-in** — Firecrawl is a dedicated web scraping service, not a general-purpose AI API. It's purpose-built for search and content extraction, with clearer pricing and rate limits.
2. **Tavily removal** — Tavily MCP was removed entirely from the codebase and from the system MCP configuration (`~/.config/mcp/mcp.json`), reducing unnecessary dependencies.
3. **Undetectable browser access** — `agent-browser-stealth` shares the user's real Chrome session cookies and fingerprint, passing anti-bot detection that would block standard HTTP scrapers.
4. **No hardcoded API keys** — Firecrawl API key is read from `~/.pi/web-search.json` or `FIRECRAWL_API_KEY` env var, following the existing config pattern.

## When to Apply

- When refactoring a Pi extension that depends on external AI APIs for web access
- When replacing proprietary search/content extraction services with dedicated web scraping tools
- When cookie-based browser authentication needs to be replaced with stealth browser automation

## Examples

### Before (gemini-search.ts)

```typescript
// Gemini API search with grounding
const body = {
  contents: [{ parts: [{ text: query }] }],
  tools: [{ google_search: {} }],
};
const res = await fetch(`${API_BASE}/models/${model}:generateContent?key=${apiKey}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
```

### After (firecrawl-search.ts)

```typescript
// Firecrawl search via REST API
const res = await fetch(`${config.baseUrl}/search`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${config.apiKey}`,
  },
  body: JSON.stringify({
    query: firecrawlQuery,
    limit: 10,
    includeDomains: options.domainFilter?.filter(d => !d.startsWith("-")),
  }),
});
```

### Before (gemini-web.ts)

```typescript
// Cookie-based Gemini Web access
const cookies = await getGoogleCookies({
  profile: normalizeChromeProfile(chromeProfile),
  requiredCookies: REQUIRED_COOKIES,
});
const text = await queryWithCookies(prompt, cookies, { model, signal, timeoutMs });
```

### After (browser-stealth.ts)

```typescript
// Agent-browser-stealth CLI wrapper
const result = await execFilePromise("agent-browser-stealth", [
  "scrape", url, "--format", "markdown",
], { timeout: timeoutMs, signal, maxBuffer: 10 * 1024 * 1024 });
```

## Files Changed

| Action | File |
|--------|------|
| Created | `firecrawl-config.ts` — Firecrawl API key and base URL configuration |
| Created | `firecrawl-search.ts` — Web search via Firecrawl `/v1/search` |
| Created | `firecrawl-fetch.ts` — URL content extraction via Firecrawl `/v1/scrape` |
| Created | `browser-stealth.ts` — agent-browser-stealth CLI wrapper |
| Created | `browser-config.ts` — Browser stealth and cookie access configuration |
| Deleted | `gemini-search.ts` — Replaced by firecrawl-search.ts |
| Deleted | `gemini-url-context.ts` — Replaced by firecrawl-fetch.ts |
| Deleted | `gemini-web.ts` — Replaced by browser-stealth.ts |
| Deleted | `gemini-web-config.ts` — Replaced by browser-config.ts |
| Deleted | `chrome-cookies.ts` — No longer needed |
| Modified | `index.ts` — Updated imports, provider chain, tool descriptions |
| Modified | `extract.ts` — Replaced gemini fallbacks with firecrawl + browser-stealth |
| Modified | `youtube-extract.ts` — Replaced Gemini Web with browser-stealth |
| Modified | `video-extract.ts` — Removed Gemini Web fallback |
| Modified | `README.md` — Updated all references |
| Modified | `package.json` — Version bump to 0.11.0 |

## Related

- `docs/plans/pi-web-access-firecrawl-refactor.md` — Implementation plan
- `@benvargas/pi-firecrawl` — Firecrawl Pi extension
- `agent-browser-stealth` — Stealth browser automation skill
