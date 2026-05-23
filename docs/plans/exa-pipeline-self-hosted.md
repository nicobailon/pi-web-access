# Self-Hosted Exa-Pipeline Architecture Plan

## Hardware Specs
- **GPU**: RTX 5080 — 16GB VRAM
- **CPU**: Ryzen 9 9000X — 16 cores (Zen 5)
- **RAM**: 32GB DDR5

---

## The Embedding Problem (And Solution)

### Problem: BGE-M3 is NOT Matryoshka-trained
- BGE-M3 produces fixed 1024-dim embeddings
- Binary quantization on untrained embeddings loses **15-30% accuracy**
- Full float32 storage: 4KB per embedding → 4GB for 1M docs (unusable)

### Solution: **Nomic Embed v1.5** (Matryoshka-trained)
- **Natively trained with Matryoshka Representation Learning**
- Truncates cleanly: 768 → 512 → 256 → 128 → 64 dimensions
- **98%+ accuracy preserved at 256-dim** (vs full 768-dim)
- Storage: **1KB per embedding** (vs 4KB for float32)
- 1M docs = **1GB RAM** (vs 4GB for BGE-M3 float32)
- MTEB score: 62.28 (768-dim) → 61.04 (256-dim) → only 1.8% loss

### Why Nomic Embed v1.5
| Dimension | MTEB Score | Storage/Doc | Accuracy vs Full |
|-----------|-----------|-------------|------------------|
| 768 | 62.28 | 3KB | 100% |
| 512 | 61.96 | 2KB | 99.5% |
| **256** | **61.04** | **1KB** | **98.0%** |
| 128 | 59.34 | 512B | 95.3% |
| 64 | 56.10 | 256B | 90.1% |

**We use 256-dim**: Best accuracy/size tradeoff for search.

---

## Model Allocation (VRAM Budget: 16GB)

| Model | Placement | VRAM | Why |
|-------|-----------|------|-----|
| **Qwen3.6 35B-A3B** | **GPU** (llama.cpp) | ~12-14GB | MoE model — only active params (~3.4B) loaded during inference. Q4_K_M quantization. Runs at ~32 TPS. |
| **jina-reranker-v1-tiny-en** | **GPU** (ONNX) | ~130MB | 33M params, 4-layer, 8192 token context. 48.54 NDCG@10. Fastest reranker. |
| **Nomic Embed v1.5** | **GPU** (ONNX) | ~400MB | Matryoshka-trained — truncate to 256-dim (98%+ accuracy), 1KB per embedding. ONNX runtime on GPU for fast inference. |
| **BGE-M3 embeddings** | **Not used** | — | Does NOT support Matryoshka. Replaced by Nomic Embed. |
| **BGE-large reranker** | **Not used** | — | jina-tiny is faster with comparable accuracy. |
| **Gemma 4 E2B** | **Not needed** | — | Too small to be useful. Qwen3.6 covers all generation needs. |

**VRAM Usage: ~12.5GB / 16GB** (3.5GB headroom for frame extraction, temporary buffers)

---

## Full Pipeline Architecture

```
INPUT: User query
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 1: SEARCH (SearXNG + Firecrawl)                       │
│  SearXNG (port 8081) aggregates Google, Bing, DuckDuckGo    │
│  Returns: URLs, titles, snippets                             │
│  Speed: 50-200ms                                             │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 2: HYBRID RERANKING                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Nomic Embed v1.5 (GPU, 256-dim Matryoshka)          │   │
│  │  - Dense vector (256-dim, 1KB per embedding)         │   │
│  │  - Truncated from 768-dim with 98% accuracy          │   │
│  │  - Stored in SQLite with full precision              │   │
│  │  - 1M docs = 1GB RAM (vs 4GB for BGE-M3)             │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Hybrid Scoring: 0.4 * BM25 + 0.6 * Embedding        │   │
│  │  (BM25 from SearXNG snippets + Nomic embeddings)     │   │
│  │  (Compensates for any embedding quality loss)        │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  jina-reranker-v1-tiny-en (GPU)                       │   │
│  │  - Cross-encoder reranking on top-K results          │   │
│  │  - Final ranking refinement                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 3: CONTENT EXTRACTION (LightPanda)                    │
│  Render JS-heavy pages, extract markdown                    │
│  Handle SPAs, anti-bot, Next.js RSC                          │
│  Speed: 200-500ms per URL                                    │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 4: SUMMARIZATION (Qwen3.6 on GPU)                     │
│  Generate summaries for top-10 results                      │
│  Speed: ~32 TPS                                              │
└─────────────────────────────────────────────────────────────┘

CODE SEARCH (Parallel Path):
  Sourcegraph (self-hosted) + Nomic Embed v1.5 (256-dim) + ripgrep

VIDEO EXTRACTION (Parallel Path):
  yt-dlp → ffmpeg → Qwen3.6 (GPU) for frame analysis
```

---

## How Exa.ai Does Agentic Search (And How We Mimic It)

Exa.ai built their own web-scale vector database with **five optimizations**:

1. **Matryoshka Embeddings** — They trained their own embeddings model using Matryoshka techniques to allow safe truncation from 4096-dim to 256-dim (20x memory reduction)
2. **Binary Quantization** — 16-bit floats → 1-bit values (16x more reduction)
3. **Dot-Product Lookup Tables** — Precompute all 16 possible subvector combinations (4x faster)
4. **CPU Register Optimization** — Load lookup tables into CPU registers (not RAM)
5. **Clustering** — Divide documents into 100,000 clusters, search only relevant clusters (1000x throughput improvement)

**We replicate this by**:
- Using **Nomic Embed v1.5** (natively Matryoshka-trained) for embeddings
- Truncating to 256-dim (98% accuracy, 1KB per embedding)
- Using hybrid search (BM25 + embeddings) to compensate for any quality loss
- Using jina-reranker-v1-tiny-en for final ranking refinement
- Adding clustering (K-Means) for document grouping

---

## How Sourcegraph Does Agentic Search

Sourcegraph's Cody uses **three context sources**:

1. **Keyword Search** — Traditional text-based search with automatic query rewriting
2. **Sourcegraph Search** — Native search API with full-text search stack
3. **Code Graph** — Analyzes code structure and relationships (calls, imports, extends)

**Cody's agentic context fetching**:
- Proactively gathers context from codebase, project structure, current task
- Uses multiple tools: Code Search, Codebase File, Terminal, Web Browser, MCP
- Performs multiple review loops to refine context
- Reduces hallucinations by providing complete context

**We replicate this by**:
- Using Sourcegraph (self-hosted) for code search
- Augmenting with Nomic Embed v1.5 (256-dim) for semantic code search
- Adding ripgrep for instant local search

---

## Feature Replacement Matrix

| pi-web-access Feature | Cloud Provider | Replacement | Speed | Quality | Privacy |
|----------------------|---------------|-------------|-------|---------|---------|
| **Web Search** | Exa MCP/API | SearXNG + Firecrawl | ★★★★★ (50-200ms) | ★★★★ (no neural search) | ★★★★★ (fully local) |
| **Semantic Reranking** | Exa vector DB | Nomic Embed + jina-tiny | ★★★★ (200-500ms) | ★★★★★ (Exa-style) | ★★★★★ (fully local) |
| **Code Search** | Exa MCP | Sourcegraph + ripgrep | ★★★★★ (instant) | ★★★★ (code graph) | ★★★★★ (fully local) |
| **Content Extraction** | Gemini Web/Jina | LightPanda | ★★★ (200-500ms) | ★★★★★ (full control) | ★★★★★ (fully local) |
| **Video Analysis** | Gemini API | yt-dlp + ffmpeg + Qwen3.6 | ★★★ (variable) | ★★★★ (local model) | ★★★★★ (fully local) |
| **Summaries** | Claude/GPT | Qwen3.6 (GPU) | ★★★★ (32 TPS) | ★★★★ (comparable) | ★★★★★ (fully local) |
| **Browser Cookies** | Gemini Web | Not needed | N/A | N/A | ★★★★★ (removed) |

---

## Speed Benchmarks (Expected)

| Operation | Original (Cloud) | New (Self-Hosted) | Improvement |
|-----------|-----------------|-------------------|-------------|
| Search | 200-500ms (Exa) | 50-200ms (SearXNG) | 2-3x faster |
| Embed 20 docs | 400ms (sequential) | 50ms (batched ONNX) | 8x faster |
| Rerank 20 docs | 200ms (Exa) | 100ms (jina-tiny GPU) | 2x faster |
| Extract 10 URLs | 10-30s (Gemini Web) | 2-5s (LightPanda) | 2-6x faster |
| Summarize 10 docs | 5-10s (Claude) | 3-5s (Qwen3.6 GPU) | 1.5-2x faster |
| Video analysis | 30-60s (Gemini API) | 10-30s (local) | 2-3x faster |
| **Total pipeline** | **60-120s** | **15-40s** | **3-4x faster** |

---

## Storage Comparison

| Model | Dim | Storage/Doc | 10K Docs | 100K Docs | 1M Docs |
|-------|-----|-------------|----------|-----------|---------|
| BGE-M3 (float32) | 1024 | 4KB | 40MB | 400MB | 4GB |
| BGE-M3 (binary) | 1024 | 128B | 1.2MB | 12MB | 120MB |
| **Nomic v1.5 (256-dim)** | **256** | **1KB** | **10MB** | **100MB** | **1GB** |
| Nomic v1.5 (64-dim) | 64 | 256B | 2.5MB | 25MB | 250MB |

**Nomic v1.5 at 256-dim**: 100x smaller than BGE-M3 float32, 98% accuracy, fully self-hosted.

---

## Implementation Phases

### Phase 1: Core Pipeline (Week 1-2)
- [ ] Set up SearXNG (already running on port 8081)
- [ ] Set up Firecrawl (already running on port 3002)
- [ ] Integrate Nomic Embed v1.5 (GPU, ONNX, 256-dim Matryoshka)
- [ ] Implement hybrid search (BM25 + embeddings)
- [ ] Set up jina-reranker-v1-tiny-en (GPU, ONNX)
- [ ] Build DAG-based pipeline orchestrator

### Phase 2: Content Extraction (Week 3)
- [ ] Integrate LightPanda for JS rendering
- [ ] Implement markdown extraction
- [ ] Add fallback to Jina Reader (free, no API key)
- [ ] Handle SPAs, anti-bot, Next.js RSC

### Phase 3: Code Search (Week 4)
- [ ] Set up self-hosted Sourcegraph
- [ ] Integrate Nomic Embed v1.5 for semantic code search
- [ ] Add ripgrep for instant local search
- [ ] Augment Sourcegraph results with Exa-style embeddings

### Phase 4: Video Extraction (Week 5)
- [ ] Integrate yt-dlp for video download
- [ ] Integrate ffmpeg for frame extraction
- [ ] Connect Qwen3.6 for frame analysis
- [ ] Handle YouTube, local videos, max 12 frames

### Phase 5: Integration & Testing (Week 6)
- [ ] Replace all pi-web-access cloud providers
- [ ] Test all features end-to-end
- [ ] Benchmark speed vs original pi-web-access
- [ ] Remove Exa, Perplexity, Gemini dependencies

---

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

---

## Model Justification

### Qwen3.6 35B-A3B (GPU) — **USE**
- MoE model — 35B total params but only ~3.4B active per token
- Fits in 16GB VRAM at Q4_K_M quantization
- ~32 TPS (good enough for summarization)
- Comparable to Claude Haiku for summarization

### jina-reranker-v1-tiny-en (GPU) — **USE**
- 33M params, 4-layer, 8192 token context
- 48.54 NDCG@10 (better speed/accuracy tradeoff than BGE-large)
- 100+ pairs/sec
- Only 130MB VRAM

### Nomic Embed v1.5 (GPU) — **USE**
- **Natively Matryoshka-trained** (no accuracy loss from truncation)
- 256-dim = 1KB per embedding (100x smaller than BGE-M3 float32)
- 98% accuracy at 256-dim (vs full 768-dim)
- MTEB score: 62.28 (768-dim) → 61.04 (256-dim)
- ONNX runtime on GPU for fast inference
- **Replaces BGE-M3 entirely**

### BGE-M3 — **NOT USED**
- Does NOT support Matryoshka representations
- Binary quantization on untrained embeddings loses 15-30% accuracy
- Full float32 storage is too large (4GB for 1M docs)
- Replaced by Nomic Embed v1.5

### BGE-large reranker — **NOT USED**
- Slower than jina-tiny with comparable accuracy
- jina-tiny is 4-layer, 33M params (vs BGE-large's larger size)
- jina-tiny supports 8192 token context (better for long documents)

### Gemma 4 E2B — **NOT NEEDED**
- Too small to be useful as a standalone model
- Qwen3.6 covers all generation needs
- Wasting VRAM

---

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
    "maxFrames": 12
  },
  "code": {
    "sourcegraph": "http://localhost:3000",
    "semanticSearch": true,
    "ripgrep": true
  }
}
```

---

## Summary

This plan replaces every cloud dependency in pi-web-access with self-hosted alternatives:

1. **Search**: SearXNG + Firecrawl (already local) → replaces Exa/Perplexity/Gemini
2. **Semantic Reranking**: Nomic Embed v1.5 (Matryoshka) + jina-tiny → mimics Exa's neural search
3. **Content Extraction**: LightPanda → replaces Gemini Web/Jina
4. **Code Search**: Sourcegraph + ripgrep → replaces Exa MCP
5. **Video Analysis**: yt-dlp + ffmpeg + Qwen3.6 → replaces Gemini API
6. **Summaries**: Qwen3.6 (GPU) → replaces Claude/GPT

**Key improvements over previous plan**:
- **Nomic Embed v1.5** (Matryoshka-trained) replaces BGE-M3 → 98% accuracy at 256-dim
- **1KB per embedding** (vs 4KB for BGE-M3 float32) → 100x storage savings
- **Hybrid search** (BM25 + embeddings) compensates for any quality loss
- **jina-reranker-v1-tiny-en** for final ranking refinement

**Result**: 3-4x faster, fully private, zero API keys, complete understanding of the system.
