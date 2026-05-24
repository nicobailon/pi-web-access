---
title: Nomic Embed v1.5 — Matryoshka embeddings for efficient semantic search
date: 2026-05-24
category: architecture-patterns
module: embeddings
problem_type: architecture_pattern
component: semantic-search
severity: high
applies_when:
  - "Implementing semantic search with constrained storage"
  - "Need embeddings that can be safely truncated without accuracy loss"
  - "Replacing BGE-M3 or other fixed-dimension embeddings"
tags: [nomic-embed, matryoshka, embeddings, semantic-search, vector-db, onnx]
---

# Nomic Embed v1.5 — Matryoshka Embeddings

## Context

The `exa_pipeline` and `code_search` tools in pi-web-access needed semantic search capabilities. The original approach used BGE-M3 embeddings (1024-dim, float32), which had two critical problems:

1. **No Matryoshka support** — BGE-M3 produces fixed 1024-dim embeddings. Truncating or binary quantizing untrained embeddings loses 15-30% accuracy.
2. **Storage explosion** — 1024-dim float32 = 4KB per embedding. 1M documents = 4GB RAM (unusable for local deployment).

The solution: Nomic Embed v1.5, which is natively trained with Matryoshka Representation Learning (MRL). This allows safe truncation from 768-dim down to 256-dim (or lower) with only ~2% accuracy loss.

## Architecture

### Matryoshka Representation Learning (MRL)

MRL trains an embedding model so that each prefix of the embedding vector is a valid, high-quality embedding on its own. This is achieved by:

1. Training with multiple loss functions at different dimensionalities
2. Each loss function optimizes the embedding at a specific truncation point
3. The model learns to encode meaningful information in all prefixes, not just the full vector

**Result:** 256-dim embeddings from Nomic v1.5 are as good as 256-dim embeddings from a model trained specifically for 256-dim.

### Dimension Tradeoff

| Dimension | MTEB Score | Storage/Doc | Accuracy vs Full |
|-----------|-----------|-------------|------------------|
| 768 | 62.28 | 3KB | 100% |
| 512 | 61.96 | 2KB | 99.5% |
| **256** | **61.04** | **1KB** | **98.0%** |
| 128 | 59.34 | 512B | 95.3% |
| 64 | 56.10 | 256B | 90.1% |

**We use 256-dim**: Best accuracy/size tradeoff for search. 98% accuracy at 1KB per embedding.

### Implementation

```typescript
// embedding-nomic.ts
import { pipeline, env } from '@xenova/transformers';

// Disable downloading models from hub since we have local models
env.allowLocalModels = true;
env.allowRemoteModels = false;  // CRITICAL: prevents treating local path as HF model ID
env.localModelPath = '';         // CRITICAL: prevents prepending base URL to absolute path
env.useCache = true;

const NOMIC_MODEL_PATH = '/home/john/.local/llm/models/nomic-embed-v1.5';

// Generate single embedding (256-dim)
export async function generateNomicEmbedding(text: string): Promise<Float32Array> {
    const embedding = await pipeline('feature-extraction', NOMIC_MODEL_PATH)({ text });
    return new Float32Array(embedding.data).slice(0, 256);
}

// Generate batched embeddings for efficiency
export async function generateNomicBatchedEmbeddings(
    texts: string[],
    batchSize: number = 32
): Promise<Float32Array[]> {
    const results = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await pipeline('feature-extraction', NOMIC_MODEL_PATH)(batch);
        results.push(...embeddings.map(e => new Float32Array(e.data).slice(0, 256)));
    }
    return results;
}

// Cosine similarity for ranking
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}
```

### Critical Configuration

The `env` settings in `embedding-nomic.ts` are the most common source of bugs:

```typescript
env.allowLocalModels = true;   // Allow loading from local filesystem
env.allowRemoteModels = false; // PREVENTS treating local path as HuggingFace URL
env.localModelPath = '';       // PREVENTS prepending base URL to absolute path
```

**Bug history:** Without `allowRemoteModels = false` and `localModelPath = ''`, the `@xenova/transformers` library treats the local model path as a HuggingFace model ID and constructs a remote URL:
```
https://huggingface.co/home/john/.local/llm/models/nomic-embed-v1.5/resolve/main/tokenizer_config.json
```
This fails with a 404 because the path is not a valid HuggingFace model ID.

## Why This Works

1. **Matryoshka training** — 256-dim embeddings are as good as a model trained specifically for 256-dim
2. **98% accuracy** — only 1.8% MTEB score loss vs full 768-dim
3. **1KB per embedding** — 100x smaller than BGE-M3 float32 (4KB)
4. **ONNX runtime** — fast inference via `@xenova/transformers` with ONNX backend
5. **GPU acceleration** — can run on CUDA for even faster inference
6. **No API keys** — fully self-hosted, no external dependencies

## Comparison: Nomic v1.5 vs BGE-M3

| Feature | Nomic v1.5 | BGE-M3 |
|---------|-----------|--------|
| Matryoshka support | ✅ Native | ❌ Fixed 1024-dim |
| 256-dim accuracy | 98.0% | N/A (cannot truncate) |
| Storage per doc (256-dim) | 1KB | 4KB (full dim) |
| 1M docs total storage | 1GB | 4GB |
| MTEB score (256-dim) | 61.04 | N/A |
| MTEB score (full dim) | 62.28 (768-dim) | 57.49 (1024-dim) |
| Binary quantization safe | ✅ Yes | ❌ 15-30% accuracy loss |

## When to Use Lower Dimensions

| Dimension | Use Case | Storage/Doc | Accuracy |
|-----------|----------|-------------|----------|
| 256 | General search (default) | 1KB | 98% |
| 128 | High-volume search, speed-critical | 512B | 95% |
| 64 | Ultra-high-volume, approximate only | 256B | 90% |
| 768 | Maximum accuracy, low volume | 3KB | 100% |

## Related

- `embedding-nomic.ts` — Nomic Embed v1.5 implementation
- `code-search.ts` — Semantic code search using Nomic embeddings
- `exa_pipeline.ts` — Exa pipeline with hybrid search (BM25 + embeddings)
- `docs/solutions/architecture-patterns/code-search-race-condition.md` — Related code search pattern
- `docs/solutions/architecture-patterns/github-api-direct-fallback.md` — Related fallback pattern
