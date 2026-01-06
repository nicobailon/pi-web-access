# Pi Perplexity Web Search Extension - Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-01-06

Initial release. Designed for pi v0.37.3.

### Added

- `web_search` tool - Search via Perplexity AI with synthesized answers and citations
  - Single or batch queries (parallel execution)
  - Recency filter (day/week/month/year)
  - Domain filter (include or exclude)
  - Optional async content fetching with agent notification
- `fetch_content` tool - Fetch and extract readable content from URLs
  - Single URL returns content directly
  - Multiple URLs store for retrieval via `get_search_content`
  - Concurrent fetching (3 max) with 30s timeout
- `get_search_content` tool - Retrieve stored search results or fetched content
  - Access by response ID, URL, query, or index
- `/search` command - Interactive browser for stored results
- TUI rendering with progress bars, URL lists, and expandable previews
- Session-aware storage with 1-hour TTL
- Rate limiting (10 req/min for Perplexity API)
- Config file support (`~/.pi/web-search.json`)
- Content extraction via Readability + Turndown (max 10k chars)
- Proper session isolation - pending fetches abort on session switch
- URL validation before fetch attempts
- Defensive JSON parsing for API responses
