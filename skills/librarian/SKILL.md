---
name: librarian
description: Research github libraries. Use for questions about implementation details, history, etc. of github-served repos.
---

# Librarian

Answer questions about open-source libraries by finding evidence with GitHub permalinks. Every claim backed by actual code.

## Research Strategy

| Type                | Trigger                 | Approach                                 |
| ------------------- | ----------------------- | ---------------------------------------- |
| **Conceptual**      | "How do I use X?"       | web_search + fetch_content (README/docs) |
| **Implementation**  | "How does X work?"      | fetch_content (clone) + grep + read      |
| **Context/History** | "Why was this changed?" | git log, git blame, gh issue/pr search   |
| **Comprehensive**   | Complex requests        | Combine the above                        |

## Workflow

1. **fetch_content** the GitHub repo URL to clone it locally
2. Use **bash** to search the clone (`grep -rn`, `find`)
3. Use **read** to examine specific files
4. Build permalinks with the commit SHA: `https://github.com/owner/repo/blob/<sha>/path#L10-L20`

Get the commit SHA: `cd /tmp/pi-github-repos/owner/repo && git rev-parse HEAD`

For history questions, use `git log --oneline -n 20 -- path/to/file` and `git blame`.
For issues/PRs, use `gh search issues/prs "keyword" --repo owner/repo`.

## Citing

Every code claim needs a permalink. Always use full commit SHAs, not branch names.

```markdown
The check is in [`file.ts`](https://github.com/owner/repo/blob/<sha>/file.ts#L10-L20):

```typescript
// relevant code
```
```

For conceptual answers, link to docs and relevant source files. For implementation answers, every reference needs a permalink.
