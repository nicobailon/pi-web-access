---
name: librarian
description: >
  Research open-source libraries with evidence-backed answers and GitHub permalinks.
  Use when the user asks about library internals, needs implementation details with source code references,
  wants to understand why something was changed, or needs authoritative answers backed by actual code.
  Excels at navigating large open-source repos and providing citations to exact lines of code.
argument-hint: "[Research question about an open-source library. Blank to auto-detect from context]"
---

# Librarian — Subagent-Only Skill

## Purpose

Research open-source libraries with evidence-backed answers and GitHub permalinks. Every claim backed by actual code.

## Execution Model

**This skill runs as a subagent.** Dispatch it when you need deep library research:

```
subagent({
  agent: "librarian",
  task: "How does React implement concurrent rendering? Show me the source code with permalinks."
})
```

## When to Dispatch

Dispatch librarian when the user asks about:
- Library internals or implementation details
- Why something was changed (commit history)
- How to use a library (with source references)
- Comparing library implementations
- Any question requiring GitHub permalinks and code citations

## What the Subagent Does

The librarian subagent will:

1. **Classify the request** — conceptual, implementation, context/history, or comprehensive
2. **Research by type** — using web_search, fetch_content, code_search, bash
3. **Clone repos** — fetch_content clones GitHub repos to /tmp/pi-github-repos/
4. **Search source** — grep, read, git log, git blame on cloned repos
5. **Construct permalinks** — GitHub permalinks with full commit SHAs
6. **Cite everything** — every claim backed by a permalink to actual code

## Output Format

The subagent returns answers with:
- Direct answers to the question
- GitHub permalinks for every code reference
- Code snippets with line numbers
- Citations to official documentation
- Commit history for "why was this changed" questions

## Examples

**Dispatch for implementation details:**
```
subagent({
  agent: "librarian",
  task: "How does TanStack Query implement the stale time check? Show me the source with permalinks."
})
```

**Dispatch for history:**
```
subagent({
  agent: "librarian",
  task: "Why was the notifyManager changed in React Query v5? Show commit history and permalinks."
})
```

**Dispatch for library comparison:**
```
subagent({
  agent: "librarian",
  task: "Compare how Zustand and Jotai implement middleware. Show source with permalinks."
})
```
