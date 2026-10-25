# Claim judge for `source_check`

`source_check` finds passages about a claim. On its own it never decides whether they back the claim up: every result is `unclear` (or `missing-evidence` when nothing was found), and you read the passages yourself. Before version 0.30 it guessed a verdict by matching words such as "confirmed" or "false"; that was removed because it gave wrong answers ([#383](https://github.com/nicobailon/pi-web-access/issues/383)).

The claim judge is an opt-in replacement that asks a small classification model instead. Turn it on in `web-search.json`:

```json
{ "sourceCheck": { "judgeModel": "clef" } }
```

| `judgeModel` | Provider | Credentials |
| --- | --- | --- |
| `clef` | Cloudflare Workers AI, on your own Cloudflare account | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or `cloudflareAccountId` and `cloudflareApiToken` |
| `jev-1.13.0` | TypeSafe | `TYPESAFE_API_KEY`, or `typesafeApiKey` |

Config values accept the same `$ENV_NAME` and `!command` forms as other keys.

## What you get

The judge makes one call with the claim and the passages and asks two questions: does a passage support the claim, contradict it, or neither, and which passage shows it. The result is:

- `supported` or `contradicted` only when the model's probability for that answer reaches that model's threshold **and** it names one of the passages. That passage id is listed under supporting or contradicting passages, and the rationale shows all three probabilities.
- `unclear` in every other case: the model was not confident enough, cited no passage, or the call failed. A failure (missing credentials, network error, timeout after 10 seconds, or an answer that doesn't check out) is described in the rationale and in the artifact's `errors`, and never becomes a verdict.

At most 48 passages and 24 KB are sent; passages beyond that are left out from the lowest-ranked end, and the rationale says how many.

**Privacy:** when the judge is on, the claim and its passages are sent to Cloudflare or TypeSafe on every `source_check` call that finds passages. Nothing is sent when `sourceCheck` is not configured.

## How the thresholds were chosen

Two sets of claims, each with 3–8 short passages and an expected answer:

- **Calibration**: 25 claims written while building the judge ([`eval/fixtures/claims-calibration.json`](../eval/fixtures/claims-calibration.json)).
- **Held-out**: 24 claims written blind by a separate agent that never saw the calibration set or any model output ([`eval/fixtures/claims-holdout.json`](../eval/fixtures/claims-holdout.json)). They cover negation, wrong numbers, wrong product or version, claims stronger than the evidence, word-overlap decoys, paraphrases with no shared words, old vs. new statements, and forum rumors.

A claim passes when the judge returns its expected answer; for claims the passages don't settle, the expected answer is `unclear`.

Each threshold is `max(0.85, highest probability the model gave that answer when it was wrong + 0.05)`. For Clef both thresholds stay at 0.85. For Jev, `supported` stays at 0.85, but `contradicted` is 0.90: Jev's answers vary a little between identical calls, and on one held-out claim (h18: "available in every region", where a passage only lists three regions) its wrong `contradicted` ranged from 0.76 to 0.85 over 10 runs.

## Results

| Model | Calibration | Held-out | Wrong verdicts | Same answer every run | Latency p50 / p95 |
| --- | --- | --- | --- | --- | --- |
| `clef` | 25/25 | 23/24 | 0 | yes (10 runs) | 350–440 ms / 610–1,020 ms |
| `jev-1.13.0` | 25/25 | 23/24 | 0 | no (±0.10) | 85–100 ms / 175–185 ms |

Both models missed the same held-out claim (h11): an old passage and a newer one disagree, and the right answer is that the newer one contradicts the claim. Both returned `unclear`, so the miss is a missing verdict, not a wrong one. Every verdict they did give cited the right passage.

Two options were measured and rejected:

- **`clef-flash`**, Cloudflare's faster model: 22/24 on the held-out set, with one wrong `supported` at 0.88 (h21, a feature of one product credited to another).
- **Asking about each passage separately** instead of all passages at once: on h11, Clef judged the old passage alone as supporting the claim at 0.98, a confident wrong `supported`. Judging all passages together returns `unclear` there for every model.

## Measure it yourself

```bash
PI_WEB_ACCESS_REAL_SEMANTIC=1 CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... TYPESAFE_API_KEY=... \
  node eval/claim-judge.mjs --models clef,jev-1.13.0 --repeat 3
```

It calls the same judge code `source_check` uses, makes real billed requests, and refuses to run without `PI_WEB_ACCESS_REAL_SEMANTIC=1`. For each model and fixture set it prints the pass count, wrong `supported` and `contradicted` verdicts, the highest wrong probability for each, how many verdicts cited an expected passage, and latency. Probabilities come from the rationale, rounded to two decimals.
