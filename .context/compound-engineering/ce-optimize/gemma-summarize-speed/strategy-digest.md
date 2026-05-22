# Strategy Digest: gemma-summarize-speed

## Key Learnings

### What Works
1. **Stop tokens are the biggest win** — Experiment 10 (7.0s, -56% latency) used stop tokens `["\n\nSources", "\n\n- ", "\n\n##"]` to terminate generation early. The model stops after ~220 tokens instead of generating 300-400.
2. **Prompt compression matters** — Going from the full `<search_results>` XML format (~1400 token prompts) to compact `Source:` labeled format (~230 prompt tokens) cut prompt processing time significantly.
3. **System message for source enforcement** — Adding `"Always include a Sources section"` to the system message ensures the model includes sources even with shorter prompts.
4. **Lower top_k (40) and top_p (0.90)** — Consistent ~20% TPS improvement over baseline, with more deterministic output.
5. **Temperature 0.7** — Good balance between creativity and determinism.

### What Doesn't Work
1. **max_tokens too low (256)** — Cuts off before sources section can be written (Experiment 2, 7).
2. **Ultra-minimal prompts without source instructions** — Model omits sources when prompt is too terse (Experiment 7).
3. **Stop tokens without system message** — Stop tokens alone can cause the model to stop mid-summary without sources.

### Optimal Configuration (Current Best)
```
System: "You are a research assistant. Write concise, factual summaries. Always include a Sources section."
Prompt format: Compact with "Source: URL" labels per result
Params: temperature=0.7, top_p=0.90, top_k=40, max_tokens=512
Stop tokens: ["\n\nSources", "\n\n- ", "\n\n##"]
Result: 7.0s latency (vs 15.9s baseline), 220 tokens, 31.4 TPS, sources included
```

## Remaining Opportunities
1. **llama-server config changes** — Increase threads from 8 to 16, reduce context window from 8192 to 4096
2. **Model swap** — Test Qwen 27B on port 8081 for potentially faster CPU inference
3. **Structured output** — Try JSON format to limit token generation
4. **Prompt caching** — Enable `--cache-prompt` on gemma server for repeated queries
