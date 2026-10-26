# Off-topic judge (measurement)

Issue [#619](https://github.com/nicobailon/pi-web-access/issues/619) proposes letting `searchRouting` move on to the next provider when a provider answers with results that have nothing to do with the query. Before any routing code, this measures whether a classifier model from Pi's catalog can tell. Nothing in the extension calls the judge yet.

`offtopic-judge.ts` sends one choice question with the query, the provider's answer text (up to 4,000 characters), and up to 10 results (title, URL, snippet up to 500 characters):

> A search engine returned this answer and these results for the query. addresses: the answer or at least one result is about what the query asks for, even if incomplete or outdated. off_topic: nothing is about what the query asks for, including results that only share words with it, a different meaning of the same word, or a different product.

Only `off_topic` would ever act, so it is the only threshold measured. The rule is the claim judge's: `max(0.85, highest off_topic probability given to a response that addresses the query + 0.05)`, rounded up, set on the calibration set and then applied unchanged to the held-out set.

## Calibration

32 responses ([`eval/fixtures/offtopic-calibration.json`](../eval/fixtures/offtopic-calibration.json)), 16 of each label: homonyms (Rust, Python, Go, Apple, Mercury, Kestrel, Stripe), a sibling product, a wrong version, answer-only responses with no results, mixed lists with one relevant result, SEO spam that repeats the query, navigational queries, and Chinese, Japanese and German queries. 3 rounds each.

| Model | Highest wrong `off_topic` | Threshold | Off-topic caught | Wrong `off_topic` | Latency p50 / p90 |
| --- | --- | --- | --- | --- | --- |
| `cloudflare-workers-ai/@cf/cloudflare/clef` | 0.04 | 0.85 | 42/48 | 0 | 273 / 470 ms |
| `typesafe/jev-latest` | 0.08 | 0.85 | 42/48 | 0 | 88 / 107 ms |
| `cloudflare-workers-ai/typesafe/jev-1.14.0` | 0.06 | 0.85 | 42/48 | 0 | 191 / 223 ms |

The misses are safe (the route would return the response, as today). Every model missed o18: "Kestrel Agent" against results about the ASP.NET Kestrel web server and the kestrel bird (0.05 to 0.14). Clef missed o12, a Node.js 18 end-of-life answer to a Node.js 24 release date question, at 0.82, just under the threshold. Jev missed o08, SEO spam that repeats the query (0.13 to 0.22). Clef gave the same probabilities for its misses in every round; Jev's varied by up to 0.09 (o08).

`openrouter/cloudflare/clef` could not be measured (no OpenRouter credits) and `openrouter/typesafe/jev-1.14` is not in Pi 1.0.4's catalog.

## Held-out

Not yet measured. A held-out set written blind goes in `eval/fixtures/offtopic-holdout.json`; the harness runs it automatically when the file exists, at the calibration threshold.

## Measure it yourself

```bash
PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/offtopic-judge.mjs --models cloudflare-workers-ai/@cf/cloudflare/clef,typesafe/jev-latest --repeat 3
```

It makes real billed requests with Pi's stored credentials. Run it without `--import ./test/isolate-env.mjs`. `--holdout <path>` reads a held-out set from another path.
