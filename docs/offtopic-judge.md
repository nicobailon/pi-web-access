# Off-topic fallback for search routing

`searchRouting` can move on to the next provider when a provider answers with results that have nothing to do with the query ([#619](https://github.com/nicobailon/pi-web-access/issues/619)). A classifier model from Pi's catalog makes the call; this page shows how it was measured.

## Turn it on

```json
{
  "searchRouting": {
    "providers": ["brave", "tavily", "exa"],
    "fallbackOn": ["transient", "quota", "network", "off-topic"],
    "offTopicModel": "cloudflare-workers-ai/@cf/cloudflare/clef"
  }
}
```

`offTopicModel` must be one of the three measured references below, and is required when `fallbackOn` lists `"off-topic"`; anything else is reported as a `searchRouting` config error, like other mistakes there. The judge uses Pi's credentials for that provider.

- It runs only on routed searches, after a provider returns an answer or results. Named providers, `provider: "all"`, and provider lists are never judged. An empty response is left to the `empty` kind.
- When the judge says off-topic at or above the model's threshold, the route tries the next provider. If every provider is weak, you get the first weak response, as with `empty` and `domain-miss`.
- If the check fails (an error, its 10-second limit, or `searchRouting.timeoutMs` running out), the response is kept and the failure shows in Pi's activity log.
- It needs Pi's model registry, so it does nothing over MCP.
- **Privacy:** the query, the answer and the result titles, URLs and snippets are sent to the model's provider on every routed search that returns something.

## How it was measured

`offtopic-judge.ts` sends one choice question with the query, the provider's answer text (up to 4,000 characters), and up to 10 results (title, URL, snippet up to 500 characters):

> A search engine returned this answer and these results for the query. addresses: the answer or at least one result is about what the query asks for, even if incomplete or outdated. off_topic: nothing is about what the query asks for, including results that only share words with it, a different meaning of the same word, or a different product.

Only `off_topic` would ever act, so it is the only threshold measured. The threshold is `max(0.85, highest off_topic probability given to a response that addresses the query + 0.05)`, rounded up, set on the calibration set and then applied unchanged to the held-out set.

## Calibration

32 responses ([`eval/fixtures/offtopic-calibration.json`](../eval/fixtures/offtopic-calibration.json)), 16 of each label: homonyms (Rust, Python, Go, Apple, Mercury, Kestrel, Stripe), a sibling product, a wrong version, answer-only responses with no results, mixed lists with one relevant result, SEO spam that repeats the query, navigational queries, and Chinese, Japanese and German queries. Two runs of 3 rounds each; the highest wrong probability is over both.

| Model | Highest wrong `off_topic` | Threshold | Off-topic caught | Wrong `off_topic` | Latency p50 / p90 |
| --- | --- | --- | --- | --- | --- |
| `cloudflare-workers-ai/@cf/cloudflare/clef` | 0.04 | 0.85 | 42/48 | 0 | 273 / 470 ms |
| `typesafe/jev-latest` | 0.08 | 0.85 | 42/48 | 0 | 88 / 107 ms |
| `cloudflare-workers-ai/typesafe/jev-1.14.0` | 0.08 | 0.85 | 42/48 | 0 | 191 / 223 ms |

The misses are safe (the route would return the response, as today). Every model missed o18: "Kestrel Agent" against results about the ASP.NET Kestrel web server and the kestrel bird (0.05 to 0.14). Clef missed o12, a Node.js 18 end-of-life answer to a Node.js 24 release date question, at 0.82, just under the threshold. Jev missed o08, SEO spam that repeats the query (0.12 to 0.22). Clef gave the same probabilities for its misses in every round; Jev's varied by up to 0.10 (o08).

`openrouter/cloudflare/clef` could not be measured (no OpenRouter credits) and `openrouter/typesafe/jev-1.14` is not in Pi 1.0.4's catalog.

## Held-out

30 responses ([`eval/fixtures/offtopic-holdout.json`](../eval/fixtures/offtopic-holdout.json)), 15 of each label, written blind by a separate agent that never saw the calibration set, the judge, or any model output. 3 rounds each, judged at the calibration threshold.

| Model | Highest wrong `off_topic` | Threshold | Off-topic caught | Wrong `off_topic` | Latency p50 / p90 |
| --- | --- | --- | --- | --- | --- |
| `cloudflare-workers-ai/@cf/cloudflare/clef` | 0.06 | 0.85 | 45/45 | 0 | 300 / 495 ms |
| `typesafe/jev-latest` | 0.08 | 0.85 | 45/45 | 0 | 86 / 122 ms |
| `cloudflare-workers-ai/typesafe/jev-1.14.0` | 0.08 | 0.85 | 45/45 | 0 | 177 / 224 ms |

Every held-out response got the right majority label in every round. The two answer-only responses (no results) were judged as expected by every model: h10, an answer about HTTP 429 (off_topic 0.00 to 0.01), and h11, an answer about the animal for a Jaguar car question (0.98 to 1.00). So were the six non-English ones (Chinese, Japanese, German, including a Japanese React question against results about game loops and photo effects): off_topic 0.00 to 0.04 when they address the query, 0.98 to 1.00 when they don't.

The held-out set had no near-misses like calibration's o12, o08 and o18, so it was easier; the calibration misses are the cases to watch.

Over calibration and held-out together, the highest wrong `off_topic` is 0.06 for Clef and 0.08 for both Jev routes, so the threshold stays at 0.85 for all three.

## Measure it yourself

```bash
PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/offtopic-judge.mjs --models cloudflare-workers-ai/@cf/cloudflare/clef,typesafe/jev-latest --repeat 3
```

It makes real billed requests with Pi's stored credentials. Run it without `--import ./test/isolate-env.mjs`. `--holdout <path>` reads a held-out set from another path.
