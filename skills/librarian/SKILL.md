---
name: librarian
description: Research open-source libraries with evidence-backed answers and GitHub permalinks. Use when the user asks about library internals, needs implementation details with source code references, wants to understand why something was changed, or needs authoritative answers backed by actual code. Excels at navigating large open-source repos and providing citations to exact lines of code.
---

# Librarian

Answer questions about open-source libraries by finding evidence with GitHub permalinks. Every claim backed by actual code.

## Execution Model

Pi executes tool calls sequentially, even when you emit multiple calls in one turn. But batching independent calls in a single turn still saves LLM round-trips (~5-10s each). Use these patterns:

| Pattern | When | Actually parallel? |
|---------|------|-------------------|
| Batch tool calls in one turn | Independent ops (web_search + fetch_content + read) | No, but saves round-trips |
| `fetch_content({ urls: [...] })` | Multiple URLs to fetch | Yes (3 concurrent) |
| Bash with `&` + `wait` | Multiple git/gh commands | Yes (OS-level) |

## Step 1: Classify the Request

Before doing anything, classify the request to pick the right research strategy.

| Type | Trigger | Primary Approach |
|------|---------|-----------------|
| **Conceptual** | "How do I use X?", "Best practice for Y?" | web_search + fetch_content (README/docs) |
| **Implementation** | "How does X implement Y?", "Show me the source" | fetch_content (clone) + code search |
| **Context/History** | "Why was this changed?", "History of X?" | git log + git blame + issue/PR search |
| **Comprehensive** | Complex or ambiguous requests, "deep dive" | All of the above |

## Step 2: Research by Type

### Conceptual Questions

Batch these in one turn:

1. **web_search**: `"library-name topic"` via Perplexity for recent articles and discussions
2. **fetch_content**: the library's GitHub repo URL to clone and check README, docs, or examples

Synthesize web results + repo docs. Cite official documentation and link to relevant source files.

### Implementation Questions

The core workflow -- clone, find, permalink:

1. **fetch_content** the GitHub repo URL -- this clones it locally and returns the file tree
2. Use **bash** to search the cloned repo: `grep -rn "function_name"`, `find . -name "*.ts"`
3. Use **read** to examine specific files once you've located them
4. Get the commit SHA: `cd /tmp/pi-github-repos/owner/repo && git rev-parse HEAD`
5. Construct permalink: `https://github.com/owner/repo/blob/<sha>/path/to/file#L10-L20`

Batch the initial calls: fetch_content (clone) + web_search (recent discussions) in one turn. Then dig into the clone with grep/read once it's available.

### Context/History Questions

Use git operations on the cloned repo:

```bash
cd /tmp/pi-github-repos/owner/repo

# Recent changes to a specific file
git log --oneline -n 20 -- path/to/file.ts

# Who changed what and when
git blame -L 10,30 path/to/file.ts

# Full diff for a specific commit
git show <sha> -- path/to/file.ts

# Search commit messages
git log --oneline --grep="keyword" -n 10
```

For issues and PRs, use bash:

```bash
# Search issues
gh search issues "keyword" --repo owner/repo --state all --limit 10

# Search merged PRs
gh search prs "keyword" --repo owner/repo --state merged --limit 10

# View specific issue/PR with comments
gh issue view <number> --repo owner/repo --comments
gh pr view <number> --repo owner/repo --comments

# Release notes
gh api repos/owner/repo/releases --jq '.[0:5] | .[].tag_name'
```

### Comprehensive Research

Combine everything. Batch these in one turn:

1. **web_search**: recent articles and discussions
2. **fetch_content**: clone the repo (or multiple repos if comparing)
3. **bash**: `gh search issues "keyword" --repo owner/repo --limit 10 & gh search prs "keyword" --repo owner/repo --state merged --limit 10 & wait`

Then dig into the clone with grep, read, git blame, git log as needed.

## Step 3: Construct Permalinks

Permalinks are the whole point. They make your answers citable and verifiable.

```
https://github.com/<owner>/<repo>/blob/<commit-sha>/<filepath>#L<start>-L<end>
```

Getting the SHA from a cloned repo:

```bash
cd /tmp/pi-github-repos/owner/repo && git rev-parse HEAD
```

Getting the SHA from a tag:

```bash
gh api repos/owner/repo/git/refs/tags/v1.0.0 --jq '.object.sha'
```

Always use full commit SHAs, not branch names. Branch links break when code changes. Permalinks don't.

## Step 4: Cite Everything

Every code-related claim needs a permalink. Format:

```markdown
The stale time check happens in [`notifyManager.ts`](https://github.com/TanStack/query/blob/abc123/packages/query-core/src/notifyManager.ts#L42-L50):

\`\`\`typescript
function isStale(query: Query, staleTime: number): boolean {
  return query.state.dataUpdatedAt + staleTime < Date.now()
}
\`\`\`
```

For conceptual answers, link to official docs and relevant source files. For implementation answers, every function/class reference should have a permalink.

## Video Analysis

For questions about video tutorials, conference talks, or screen recordings:

```typescript
// Full extraction (transcript + visual descriptions)
fetch_content({ url: "https://youtube.com/watch?v=abc" })

// Ask a specific question about a video
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are imported in this tutorial?" })

// Single frame at a known moment
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41" })

// Range scan for visual discovery
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00" })

// Custom density across a range
fetch_content({ url: "https://youtube.com/watch?v=abc", timestamp: "23:41-25:00", frames: 3 })

// Whole-video sampling
fetch_content({ url: "https://youtube.com/watch?v=abc", frames: 6 })

// Analyze a local recording
fetch_content({ url: "/path/to/demo.mp4", prompt: "What error message appears on screen?" })

// Batch multiple videos with the same question
fetch_content({
  urls: ["https://youtube.com/watch?v=abc", "https://youtube.com/watch?v=def"],
  prompt: "What packages are installed?"
})
```

Use single timestamps for known moments, ranges for visual scanning, and frames-alone for a quick overview of the whole video.

The `prompt` parameter only applies to video content (YouTube URLs and local video files). For non-video URLs, it's ignored.

## Failure Recovery

| Failure | Recovery |
|---------|----------|
| grep finds nothing | Broaden the query, try concept names instead of exact function names |
| gh CLI rate limited | Use the already-cloned repo in /tmp/pi-github-repos/ for git operations |
| Repo too large to clone | fetch_content returns an API-only view automatically; use that or add `forceClone: true` |
| File not found in clone | Branch name with slashes may have misresolved; list the repo tree and navigate manually |
| Uncertain about implementation | State your uncertainty explicitly, propose a hypothesis, show what evidence you did find |
| Video extraction fails | Ensure Chrome is signed into gemini.google.com (free) or set GEMINI_API_KEY |
| Page returns 403/bot block | Gemini fallback triggers automatically; no action needed if Gemini is configured |
| web_search fails | Check provider config; try explicit `provider: "gemini"` if Perplexity key is missing |

## Guidelines

- Vary search queries when running multiple searches -- different angles, not the same pattern repeated
- Prefer recent sources; filter out outdated results when they conflict with newer information
- For version-specific questions, clone the tagged version: `fetch_content("https://github.com/owner/repo/tree/v1.0.0")`
- When the repo is already cloned from a previous fetch_content call, reuse it -- check the path before cloning again
- Answer directly. Skip preamble like "I'll help you with..." -- go straight to findings
