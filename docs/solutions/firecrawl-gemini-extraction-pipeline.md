---
title: "Firecrawl + Gemini Chat Extraction Pipeline"
date: 2026-05-18
category: best_practices
module: Web Scraping
problem_type: best_practice
component: firecrawl
tags: [firecrawl, gemini, web-scraping, browser-harness, lightpanda]
---

# Firecrawl + Gemini Chat Extraction Pipeline

## Problem

Need to extract ALL research-related chats from Google Gemini since August 2025 (~hundreds of conversations) and organize them semantically using local LLM (Gemma 4 E2B).

## Solution

### Architecture
```
Browser-Harness → Chrome/Chromium → Gemini Sidebar
                          ↓
Firecrawl (LightPanda) → Scrape individual chat pages
                          ↓
SearXNG → Privacy search fallback
                          ↓
Gemma 4 E2B (port 8083) → Summarize, categorize, embed
```

### Step 1: Extract Chat Titles via Browser-Harness
```bash
browser-harness <<'PY'
new_tab("https://gemini.google.com")
wait_for_load()
click_at_xy(25, 18)  # Hamburger menu
sleep(0.5) if 'sleep' in dir() else None

# Get all chat links
allLinks = js('''
Array.from(document.querySelectorAll('a')).map(a => ({
    text: a.textContent?.trim(),
    href: a.getAttribute('href') || ''
})).filter(l => l.text && l.text.length > 5);
''')

# Filter to actual chats (skip UI elements)
const chats = allLinks.filter(l => 
    !['New chat', 'My stuff', 'Notebooks'].includes(l.text)
);
PY
```

### Step 2: Scrape Individual Chats via Firecrawl
```bash
curl -s http://localhost:3002/v1/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://gemini.google.com/app/XXXX",
    "formats": ["markdown"],
    "onlyMainContent": true,
    "waitFor": 3000
  }' | python3 -c "...save to file..."
```

### Step 3: Analyze with Gemma 4 E2B
```bash
curl -s http://localhost:8083/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma-4-E2B-it-UD-Q4_K_XL.gguf",
    "messages": [{"role": "user", "content": "..."}],
    "max_tokens": 500,
    "temperature": 0.7
  }'
```

## What Didn't Work

1. **Firecrawl on Gemini homepage**: Only extracts UI chrome (~190 chars), not sidebar content (LightPanda can't execute JavaScript for dynamic menus)
2. **Direct `/history` URL**: Returns 404 — no public history endpoint
3. **BGE-M3 embeddings**: ONNX model exists but Python packages (`onnxruntime`, `transformers`) not installed

## Prevention / Best Practices

- Use browser-harness for sites with client-side rendered menus (hamburger, dropdowns)
- Use Firecrawl for static content pages (arXiv, docs sites, blogs)
- Always check `waitFor` timeout — Gemini needs 3+ seconds for chat content to render
- Save extracted data early: `/tmp/gemini_all_chats.json`, `/tmp/gemini_chat_analysis.csv`

## Related Issues

- Session chronology: `/tmp/pi_coding_agent_may18_sessions.html`
- Gemma 4 E2B CPU-only rebuild: `gemma-4-e2b-cpu-only-rebuild.md`
