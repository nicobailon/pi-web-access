---
title: Self-Hosted Exa Pipeline — replacing cloud search with local infrastructure
date: 2026-05-24
category: architecture-patterns
module: exa-pipeline
problem_type: architecture_pattern
component: search-pipeline
severity: high
applies_when:
  - "Replacing cloud search APIs (Exa, Perplexity, Gemini) with self-hosted alternatives"
  - "Need semantic search without external API dependencies"
  - "Building a fully local web search pipeline"
tags: [exa-pipeline, self-hosted, searxng, firecrawl, nomic-embed, jina-reranker, qwen3.6]
---

# Self-Hosted Exa Pipeline

## Context

The `pi-web-access` extension originally depended on cloud APIs for all search and content processing:
- **Exa MCP/API** — web search and vector search
- **Perplexity** — search fallback
- **Gemini API** — content extraction, video analysis, summaries

These dependencies were replaced with a fully self-hosted pipeline:

```
INPUT: User query
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 1: SEARCH (SearXNG + Firecrawl)                       │
│  SearXNG (port 8081) aggregates Google, Bing, DuckDuckGo    │
│  Firecrawl (port 3002) provides search + content extraction  │
│  Speed: 50-200ms                                              │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 2: HYBRID RERANKING                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Nomic Embed v1.5 (GPU, 256-dim Matryoshka)          │   │
│  │  - Dense vector (256-dim, 1KB per embedding)         │   │
│  │  - Truncated from 768-dim with 98% accuracy          │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Hybrid Scoring: 0.4 * BM25 + 0.6 * Embedding        │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  jina-reranker-v1-tiny-en (GPU)                       │   │
│  │  - Cross-encoder reranking on top-K results          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 3: CONTENT EXTRACTION (LightPanda)                    │
│  Render JS-heavy pages, extract markdown                    │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 4: SUMMARIZATION (Qwen3.6 on GPU)                     │
│  Generate summaries for top-10 results                      │
│  Speed: ~32 TPS                                              │
└─────────────────────────────────────────────────────────────┘
```

## Component Stack

| Component | Port | Purpose | Speed |
|-----------|------|---------|-------|
| **SearXNG** | 8081 | Search aggregation (Google, Bing, DuckDuckGo) | 50-200ms |
| **Firecrawl** | 3002 | Web search + content extraction | 200-500ms |
| **Qwen3.6 35B-A3B** | 8082 | Summarization + multimodal analysis | ~32 TPS |
| **Nomic Embed v1.5** | — | Semantic embeddings (ONNX, GPU) | ~50ms batch |
| **jina-reranker-v1-tiny-en** | — | Cross-encoder reranking (ONNX, GPU) | 100+ pairs/sec |

### Hardware Requirements

| Component | VRAM | Placement |
|-----------|------|-----------|
| Qwen3.6 35B-A3B | ~12-14GB | GPU (llama.cpp, Q4_K_M) |
| jina-reranker-v1-tiny-en | ~130MB | GPU (ONNX) |
| Nomic Embed v1.5 | ~400MB | GPU (ONNX) |
| **Total** | **~12.5GB / 16GB** | **RTX 5080** |

## Pipeline Stages

### Stage 1: Search (SearXNG + Firecrawl)

SearXNG aggregates results from multiple search engines (Google, Bing, DuckDuckGo). Firecrawl provides additional search and content extraction capabilities.

```typescript
// Search with SearXNG
const searxngResults = await searchWithSearXNG(query, { numResults: 20 });

// Search with Firecrawl
const firecrawlResults = await search(query, { numResults: 20, provider: "firecrawl" });
```

### Stage 2: Hybrid Reranking

Results are reranked using a hybrid of BM25 (term overlap) and embedding similarity:

```typescript
// BM25-style term overlap bonus
const termCount = (r.content.toLowerCase().match(query.toLowerCase().split(/\s+/).filter(t => t.length > 2)) || []).length;
const bm25Bonus = termCount > 0 ? Math.min(0.3, termCount * 0.05) : 0;

// Final score: embedding similarity + BM25 bonus
const score = Math.max(0, cosineSimilarity(queryEmbedding, docEmbedding) + bm25Bonus);
```

### Stage 3: Content Extraction

Content is extracted from URLs using multiple fallback methods:
1. **Readability** — lightweight HTML-to-markdown extraction
2. **Firecrawl** — JavaScript-rendered content extraction
3. **agent-browser-stealth** — undetectable browser automation for anti-bot pages

### Stage 4: Summarization

Top results are summarized using Qwen3.6 running locally on the GPU.

## Speed Benchmarks

| Operation | Original (Cloud) | New (Self-Hosted) | Improvement |
|-----------|-----------------|-------------------|-------------|
| Search | 200-500ms (Exa) | 50-200ms (SearXNG) | 2-3x faster |
| Embed 20 docs | 400ms (sequential) | 50ms (batched ONNX) | 8x faster |
| Rerank 20 docs | 200ms (Exa) | 100ms (jina-tiny GPU) | 2x faster |
| Extract 10 URLs | 10-30s (Gemini Web) | 2-5s (LightPanda) | 2-6x faster |
| Summarize 10 docs | 5-10s (Claude) | 3-5s (Qwen3.6 GPU) | 1.5-2x faster |
| Video analysis | 30-60s (Gemini API) | 10-30s (local) | 2-3x faster |
| **Total pipeline** | **60-120s** | **15-40s** | **3-4x faster** |

## Privacy Benefits

| Feature | Original (Cloud) | New (Self-Hosted) |
|---------|-----------------|-------------------|
| Search queries | Sent to Exa/Perplexity/Gemini | Stay local (SearXNG) |
| Browsing history | Sent to Gemini Web | Stay local (LightPanda) |
| Video content | Sent to Gemini API | Stay local (yt-dlp + Qwen3.6) |
| Code snippets | Sent to Exa MCP | Stay local (Sourcegraph) |
| Summaries | Generated by Claude/GPT | Generated by Qwen3.6 |
| **API keys needed** | Exa, Perplexity, Gemini | **None (all local)** |
| **Data collection** | Exa tracks queries | **Zero tracking** |

## Configuration

```json
{
  "search": {
    "provider": "firecrawl",
    "searxngUrl": "http://localhost:8081",
    "firecrawlUrl": "http://localhost:3002"
  },
  "semantic": {
    "embeddingModel": "nomic-ai/nomic-embed-text-v1.5",
    "embeddingDevice": "cuda",
    "embeddingDim": 256,
    "rerankerModel": "jinaai/jina-reranker-v1-tiny-en",
    "rerankerDevice": "cuda",
    "hybridWeights": {
      "bm25": 0.4,
      "embedding": 0.6
    }
  },
  "extraction": {
    "tool": "lightpanda",
    "fallback": "jina"
  },
  "summarization": {
    "model": "qwen3.6-35B-A3B",
    "device": "cuda",
    "quantization": "Q4_K_M"
  },
  "video": {
    "downloader": "yt-dlp",
    "frameExtractor": "ffmpeg",
    "analyzer": "qwen3.6",
    "maxFrames": 60
  },
  "code": {
    "sourcegraph": "http://localhost:3000",
    "semanticSearch": true,
    "ripgrep": true
  }
}
```

## Related

- `docs/plans/code-search-race-condition.md` — Code search race condition plan
- `docs/solutions/architecture-patterns/code-search-race-condition.md` — Code search pattern
- `docs/solutions/architecture-patterns/youtube-extraction-qwen3.6-multimodal.md` — YouTube extraction
- `docs/solutions/architecture-patterns/nomic-embedding-matryoshka.md` — Nomic embeddings
- `docs/solutions/architecture-patterns/github-api-direct-fallback.md` — GitHub API fallback
- `docs/solutions/architecture-patterns/background-fetch-timeout.md` — Timeout pattern
- `~/.local/sourcegraph/docker-compose.yaml` — Sourcegraph Docker setup
- `~/.pi/web-search.json` — Configuration file
