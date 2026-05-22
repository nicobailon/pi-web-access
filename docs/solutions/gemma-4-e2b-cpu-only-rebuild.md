---
title: "Gemma 4 E2B CPU-Only Rebuild — turboquant_plus without CUDA"
date: 2026-05-18
category: tooling_decisions
module: LLM Gateway
problem_type: tooling_decision
component: llama_server
tags: [gemma-4-e2b, cpu-only, cuda-off, turboquant-plus, pi-web-access]
---

# Gemma 4 E2B CPU-Only Rebuild — turboquant_plus without CUDA

## Problem

Gemma 4 E2B server could not start due to VRAM exhaustion. RTX 5080 had only ~1.1GB free after Qwen3.6 (port 8080) consumed 14.7GB. Gemma 4 needed ~900MB for compute buffers even with `--ngl 0` and `GGML_CUDA=0`. All attempts to start on ports 8082/8083 failed with:

```
ggml_backend_cuda_buffer_type_alloc_buffer: allocating 1244.58 MiB on device 0: cudaMalloc failed: out of memory
```

## Symptoms

- Gemma 4 E2B server crash on startup with `cudaMalloc failed: out of memory`
- Error in log: `llama_model_load_from_file_impl: failed to load model`
- Server never reaches "listening" state
- All LLM features for pi-web-access (summaries, semantic reranking) unavailable

## What Didn't Work

1. **Environment variable approach**: `GGML_CUDA=0`, `GGML_FORCE_CPU=1` — turboquant_plus build still initializes CUDA and tries to allocate buffers
2. **Different binary**: rotorquant build doesn't support gemma4 model architecture (`unknown model architecture: 'gemma4'`)
3. **Reduced context/batch size**: Even with `-c 4096 --batch-size 512`, the ~900MB compute buffer allocation always fails when VRAM is full

## Solution

Rebuilt turboquant_plus from source with CUDA disabled:

```bash
cd /home/john/.local/llm/src/turboquant_plus
make clean
cmake -B build -DGGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build --target llama-server -- -j$(nproc)
```

Start with the rebuilt CPU-only binary:

```bash
cd /home/john/.local/llm/src/turboquant_plus/build
./bin/llama-server \
    -m /home/john/.local/llm/models/gemma-4-E2B-it-UD-Q4_K_XL.gguf \
    --chat-template-file /home/john/.local/llm/models/chat_template_gemma_e2b.jinja \
    --fit off \
    -c 4096 \
    --threads $(nproc) \
    --host 0.0.0.0 --port 8083 \
    --embeddings \
```

## Why This Works

The turboquant_plus build has CUDA **compiled in** (not just linked). Setting `GGML_CUDA=0` only disables *runtime* CUDA usage — the binary still initializes CUDA at startup and tries to allocate compute buffers. By rebuilding with `-DGGML_CUDA=OFF`, the binary contains zero CUDA code paths, eliminating all VRAM allocation attempts.

Verification:
```bash
ldd build/bin/llama-server | grep cuda  # Returns nothing (pure CPU)
```

## Prevention

- **Golden rule**: When GPU is full and you need another model on CPU-only → rebuild with `-DGGML_CUDA=OFF`
- **NEVER kill Qwen3.6 on port 8080** — it powers the pi coding agent itself
- **Port allocation**: Qwen3.6 = 8080, SearXNG = 8081, Firecrawl = 3002, Gemma 4 E2B = 8083

## Related Issues

- `/home/john/pi-web-access/docs/plans/fix-scrape-features.md` — original plan
- Session chronology: `/tmp/pi_coding_agent_may18_sessions.html` (401-line HTML artifact)
