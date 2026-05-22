#!/usr/bin/env bash
# Measurement harness for gemma-summarize-speed optimization
# Usage: echo '<params_json>' | bash harness.sh
#
# params_json: array of test objects, each with:
#   - prompt: the full prompt text
#   - maxTokens: max tokens to generate
#   - temperature, top_p, top_k, thinking, reasoning: optional params
#
# Output: JSON array of results

set -euo pipefail
PARAMS="${1:-$(cat /dev/stdin)}"

python3 - "$PARAMS" << 'PYEOF'
import json, subprocess, sys, time, re

params = json.loads(sys.argv[1])
LLM_URL = "http://localhost:8082/v1/chat/completions"

results = []

for test in params:
    prompt = test["prompt"]
    max_tokens = test.get("maxTokens", 2048)
    temperature = test.get("params", {}).get("temperature", 1.0)
    top_p = test.get("params", {}).get("top_p", 0.95)
    top_k = test.get("params", {}).get("top_k", 64)
    thinking = test.get("params", {}).get("thinking", False)
    reasoning = test.get("params", {}).get("reasoning", False)

    payload = {
        "model": "gemma-4-E2B-it-UD-Q4_K_XL.gguf",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
        "top_k": top_k,
        "thinking": thinking,
        "reasoning": reasoning
    }

    start = time.time()
    proc = subprocess.run(
        ["curl", "-s", "--max-time", "60", LLM_URL,
         "-H", "Content-Type: application/json",
         "-d", json.dumps(payload)],
        capture_output=True, text=True
    )
    ms = int((time.time() - start) * 1000)

    if proc.returncode != 0:
        results.append({"error": proc.stderr[:200], "latency_ms": ms})
        continue

    try:
        resp = json.loads(proc.stdout)
        content = resp.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = resp.get("usage", {})
        tokens = usage.get("completion_tokens", max(1, len(content) // 4))
        tps = round(tokens / (ms / 1000), 1) if ms > 0 else 0

        results.append({
            "latency_ms": ms,
            "tokens_generated": tokens,
            "tps": tps,
            "summary_length_chars": len(content),
            "has_sources_section": bool(re.search(r"sources?\s*:", content, re.IGNORECASE)),
            "no_hallucination_flag": False,
            "summary_text": content
        })
    except Exception as e:
        results.append({"error": str(e), "latency_ms": ms})

print(json.dumps(results))
PYEOF
