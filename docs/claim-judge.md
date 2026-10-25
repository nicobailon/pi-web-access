# Claim judge for `source_check`

`source_check` finds passages about a claim. On its own it never decides whether they back the claim up: every result is `unclear` (or `missing-evidence` when nothing was found), and you read the passages yourself. Before version 0.30 it guessed a verdict by matching words such as "confirmed" or "false"; that was removed because it gave wrong answers ([#383](https://github.com/nicobailon/pi-web-access/issues/383)).

The claim judge is an opt-in replacement that asks a classifier model from Pi's catalog instead. Turn it on in `web-search.json` with a Pi model reference:

```json
{ "sourceCheck": { "judgeModel": "cloudflare-workers-ai/@cf/cloudflare/clef" } }
```

Only these measured references are accepted; any other `sourceCheck` value stops the extension from loading, like other config errors.

| `judgeModel` | Model | `supported` at | `contradicted` at | Pi credentials |
| --- | --- | --- | --- | --- |
| `cloudflare-workers-ai/@cf/cloudflare/clef` | Cloudflare Clef | 0.85 | 0.87 | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `openrouter/cloudflare/clef` | Cloudflare Clef | 0.85 | 0.87 | `OPENROUTER_API_KEY` or `/login` |
| `typesafe/jev-latest` | TypeSafe Jev (served Jev 1.14 when measured) | 0.88 | 0.85 | `TYPESAFE_API_KEY` |
| `openrouter/typesafe/jev-1.14` | TypeSafe Jev 1.14 | 0.88 | 0.85 | `OPENROUTER_API_KEY` or `/login` |
| `cloudflare-workers-ai/typesafe/jev-1.14.0` | TypeSafe Jev 1.14 | 0.88 | 0.85 | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `openrouter/typesafe/jev-1.13` | TypeSafe Jev 1.13 | 0.85 | 0.90 | `OPENROUTER_API_KEY` or `/login` |

The judge uses whatever credentials Pi has for that provider. `typesafe/jev-latest` is an alias, so its model can change; the other references name a fixed version. `openrouter/typesafe/jev-1.14` and `cloudflare-workers-ai/typesafe/jev-1.14.0` are in Pi 1.4.0's catalog but not 1.0.4's; an older Pi answers `unclear` with "not in this Pi's classifier catalog". The judge needs Pi's model registry, so it does not run over MCP: there, claims stay `unclear`.

## What you get

The judge makes one call with the claim and the passages, each labeled with the title of the page it came from (or its URL when the page has no title), and asks two questions: does a passage support the claim, contradict it, or neither, and which passage shows it. The result is:

- `supported` or `contradicted` only when the model's probability for that answer reaches the threshold for that reference **and** it names one of the passages. That passage id is listed under supporting or contradicting passages, and the rationale shows all three probabilities.
- `unclear` in every other case: the model is sure the passages don't settle the claim, was not confident enough, cited no passage, or the call failed. A judged `unclear` shows the model's highest probability as its confidence, whichever answer that was; the rationale lists all three. A failure (the model is missing from your Pi's catalog, an error from the provider, a timeout after 10 seconds, or an answer that doesn't check out) is described in the rationale and in the artifact's `errors`, and never becomes a verdict.

At most 48 passages and 24 KB, titles included, are sent; passages beyond that are left out from the lowest-ranked end, and the rationale says how many.

**Known limit:** when two products share a brand name, for example a claim about "Acme Agent" and a page about "Acme Dashboard", the models can wrongly answer `supported` with high confidence. Check the title of the cited passage's source before relying on a verdict.

**Privacy:** when the judge is on, the claim, its passages and their page titles are sent to the reference's provider on every `source_check` call that finds passages. Nothing is sent when `sourceCheck` is not configured.

## How the thresholds were chosen

Two sets of claims, each with 2–7 short passages labeled with their page titles and an expected answer:

- **Calibration**: 33 claims written while building the judge ([`eval/fixtures/claims-calibration.json`](../eval/fixtures/claims-calibration.json)).
- **Held-out**: 32 claims written blind by a separate agent that never saw the calibration set or any model output ([`eval/fixtures/claims-holdout.json`](../eval/fixtures/claims-holdout.json)). They cover negation, wrong numbers, wrong product or version, claims stronger than the evidence, word-overlap decoys, paraphrases with no shared words, old vs. new statements, and forum rumors.

Each set has 8 cases where the page title matters: 2 about versions, 2 about plans or editions, 2 about sibling products, and 2 where only the title names the subject. The sibling-product cases are a known limit and are reported apart from the scores, leaving 61 scored claims.

Every reference ran all 61 scored claims through Pi 3 times, and the claims closest to a threshold 10 times. Each threshold is `max(0.85, highest probability that reference gave that answer when it was wrong + 0.05)`, rounded up:

| Model | Highest wrong `supported` | Highest wrong `contradicted` | Thresholds |
| --- | --- | --- | --- |
| Clef (both routes) | 0.301 | 0.812 | 0.85 / 0.87 |
| Jev 1.14 (all three routes, including `typesafe/jev-latest`) | 0.83, over 10 rounds on h11 | 0.50 | 0.88 / 0.85 |
| Jev 1.13 | 0.74 | 0.77, and 0.85 over 10 earlier rounds | 0.85 / 0.90 |

At these thresholds no reference gave a wrong verdict. Clef returned the same answer every round; Jev's probabilities vary a little between identical calls, which is why its thresholds come from the 10-round runs. The one claim every model missed is h11, where an old page and a newer one disagree; they answered `unclear`, a missing verdict rather than a wrong one. `opencode/jev-1.13` and `openai/gpt-6-luna` could not be measured and are not accepted.

**Page titles matter.** Without them, Clef answered `supported` at 0.88 for a v1 claim backed by a v2 docs page. With them, the version and plan cases are answered correctly.

**Sibling products.** The 4 sibling-product fixture cases came back `unclear`. But the claim "Kestrel Agent runs on Windows." with the passage "Runs on Windows, macOS and Linux." from the page "Kestrel Dashboard — System requirements" got `supported` at about 0.98 from both models, with or without extra instructions. Treat products that share a brand name as a known miss.

Two designs were measured on the first, title-free fixtures and rejected: Cloudflare's faster `clef-flash` (one wrong `supported` at 0.88), and asking about each passage separately (Clef judged an outdated passage alone as supporting the claim at 0.98).

## Measure it yourself

```bash
PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/claim-judge.mjs --models cloudflare-workers-ai/@cf/cloudflare/clef,typesafe/jev-latest --repeat 3
```

It calls the same judge code `source_check` uses through Pi's model registry with your Pi credentials, makes real billed requests, and refuses to run without `PI_WEB_ACCESS_REAL_SEMANTIC=1`. Without `--models` it runs every accepted reference. For each reference and fixture set it prints the pass count, wrong `supported` and `contradicted` verdicts, the highest wrong probability for each, how many verdicts cited an expected passage, latency, and the known-limit cases on their own.

Run it without `--import ./test/isolate-env.mjs`: that test helper hides Pi's stored credentials.
