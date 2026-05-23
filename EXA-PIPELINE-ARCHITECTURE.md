# Exa-Pipeline Architecture

## Self-Hosted Exa Pipeline (v2)

This document describes the self-hosted Exa.ai-style semantic search pipeline implemented in `exa-pipeline.ts`.

### Architecture Overview

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
│  STEP 2: CONTENT EXTRACTION (LightPanda + fallbacks)        │
│  LightPanda for JS rendering, Jina/Firecrawl as fallbacks   │
│  Speed: 200-500ms per URL                                    │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 3: HYBRID RERANKING                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Nomic Embed v1.5 (CPU, 256-dim Matryoshka)          │   │
│  │  - Dense vector (256-dim, 32 bytes per embedding)    │   │
│  │  - 98% accuracy at 256-dim (vs full 768-dim)        │   │
│  │  - Stored in SQLite with binary quantization         │   │
│  │  - 1M docs = 1GB RAM (vs 4GB for BGE-M3)            │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Hybrid Scoring: 0.4 * BM25 + 0.6 * Embedding        │   │
│  │  (BM25 from text similarity + Nomic embeddings)      │   │
│  │  (Compensates for any embedding quality loss)        │   │
│  └──────────────────────────────────────────────────────┘   │
│         ↓                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  jina-reranker-v1-tiny-en (CPU)                       │   │
│  │  - Cross-encoder reranking on top-K results          │   │
│  │  - Final ranking refinement                          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
   ↓
┌─────────────────────────────────────────────────────────────┐
│  STEP 4: SUMMARIZATION (Qwen3.6)                            │
│  Generate summaries for top-10 results                      │
│  Speed: ~32 TPS                                              │
└─────────────────────────────────────────────────────────────┘
```

### Model Details

#### Nomic Embed v1.5
- **Path**: `~/.local/llm/models/nomic-embed-v1.5/`
- **Format**: ONNX (full precision)
- **Dimensions**: 256 (Matryoshka truncated from 768)
- **Tokenizer**: @xenova/transformers (BERT-style WordPiece)
- **MTEB Score**: 62.28 (768-dim) → 61.04 (256-dim)
- **Storage**: 32 bytes per embedding (binary quantized)
- **Key advantage**: Natively Matryoshka-trained — no accuracy loss from truncation

#### Jina Reranker v1 Tiny
- **Path**: `~/.local/llm/models/jina-reranker-tiny/`
- **Format**: ONNX (full precision)
- **Params**: 33M, 4-layer
- **Context**: 8192 tokens
- **NDCG@10**: 48.54
- **Performance**: 100+ pairs/sec
- **Tokenizer**: @xenova/transformers (RoBERTa-style)

### Hybrid Search

The pipeline uses hybrid scoring to combine BM25 keyword matching with semantic embedding similarity:

```
hybrid_score = bm25Weight * normalized_bm25_score + embeddingWeight * normalized_embedding_score
```

Default weights: `bm25Weight = 0.4`, `embeddingWeight = 0.6`

This compensates for any quality loss from embedding truncation or quantization.

### Code Search

Self-hosted code search combining three methods:

1. **Sourcegraph**: Full-text search with code graph awareness
2. **Ripgrep**: Fast local file search
3. **Semantic**: Nomic Embed v1.5 for semantic code similarity

### Video Analysis

Video understanding using Qwen3.6 multimodal:
1. yt-dlp extracts video stream
2. FFmpeg extracts frames (max 60 at 1fps)
3. Qwen3.6 analyzes frames + text prompt
4. Returns structured summary with transcript

### Privacy

All processing is fully local. Zero API keys required. Zero data collection.
