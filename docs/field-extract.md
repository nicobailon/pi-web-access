# Extract mode for `fetch_content`

`mode: "extract"` reads named values off a page, such as a price, a release date, or a rate limit, instead of returning the whole page. Each value comes back typed (a number, a date, a list), or marked as uncertain or not on the page. A small extraction model, Cloudflare's Clairic, reads the page; it runs on your own Cloudflare account.

```typescript
fetch_content({
  url: "https://example.com/pricing",
  mode: "extract",
  fields: { pro_monthly: "number: Pro plan price per month, billed monthly", trial_days: "integer", currency: "text" },
})
```

## Turn it on

Extract is off by default. Add it to the allowed modes in `web-search.json`:

```json
{ "fetch": { "allowedModes": ["readable", "raw", "answer", "extract"] } }
```

It uses the Cloudflare credential Pi already has for its `cloudflare-workers-ai` provider: set `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` in the environment, or store them with Pi's `/login`. The key needs Workers AI access. There are no extract-specific credential settings in `web-search.json`. Without the credential, each page reports `Extraction failed: Cloudflare Workers AI is not set up in Pi; ...` and nothing is sent.

To send the requests through a Cloudflare [AI Gateway](https://developers.cloudflare.com/ai-gateway/) for its logs, caching, rate limits or billing, give Pi a gateway id: set `CLOUDFLARE_GATEWAY_ID`, or store one with `/login cloudflare-ai-gateway`. Extract then adds the `cf-aig-gateway-id` header to the same Workers AI request, with the same key. A gateway that doesn't exist fails with Cloudflare's "Please configure AI Gateway in the Cloudflare dashboard". In testing, results through the `default` gateway matched direct calls, with about 30 ms added per page.

`fields` is in the tool definition only when extract is allowed, and so is a line in the agent's tool list telling it to use extract for a specific value (a price, version, date or limit) instead of reading the whole page. `extract` cannot be `fetch.defaultMode`, because every call needs its own `fields`.

Extract is available in Pi only, because it uses Pi's credentials. The MCP server's `fetch_content` offers `readable` and `raw`, not `extract`.

## Fields

`fields` maps each name to `"<type>"` or `"<type>: <what to find>"`. Names are 1–64 letters, digits, or underscores; a call takes 1 to 16 fields.

| Type | Value |
| --- | --- |
| `text` | a string from the page |
| `number`, `integer` | a number; `integer` must be whole |
| `date` | `YYYY-MM-DD` |
| `time` | `HH:MM` or `HH:MM:SS` |
| `datetime` | ISO 8601, such as `2026-11-05T16:00` |
| `duration`, `duration.<seconds\|minutes\|hours\|days\|weeks\|months\|years>` | a number, in the given unit; a plain `duration` is in seconds |
| `list`, `list.number`, `list.date` | a list of text, numbers, or dates |

Relative dates ("2 days ago") and dates without a year are read against today's date (UTC). An invalid field fails the call before anything is fetched.

## What you get

Each URL gets a heading and one line per field:

- `total: 42.1 (0.99)`: extracted. The value has the right type, is a real date or time where that applies, and the model's confidence is at least 0.80.
- `invoice: uncertain (guess INV-2291, 0.55)`: the model found a value but isn't sure of it, so it is shown as a guess. This is what you get below 0.80, when the value has the wrong type (`"Oct 27"` for a date, `2.5` for an integer, `2026-13-45`, empty text, a negative duration), or when the model gave no confidence.
- `coupon: not on the page`: the model decided the value is not on the page. Clairic still sends a fallback guess in that case; it is not shown, because it is not taken from the page.

A text or number value that is found on the page is followed by the line it is on, such as `total: 42.1 (0.99) from "Order total $42.10."`, so it can be checked and cited; `details.extractions` has it as `line`. Text is matched ignoring case, spacing, markdown (emphasis, escapes such as `my\_package`, and link addresses), curly quotes and dashes; numbers allow thousands separators and trailing zeros (`1,299`, `1 299`, `42.10`). Dates, times, durations and lists get no line, because the model rewrites them (`next Friday` becomes `2026-10-30`). A number match only adds the line and never changes the result, since the same digits can appear elsewhere on the page.

Text the model reports with high confidence that is not on the page at all is shown as `uncertain (guess …, 0.97; not found on the page)`, because it was not read from the page. On the measurement sets below, every correct text and number value was found on its page, so this check withheld none of them.

When any value is uncertain, the note at the end suggests checking it with `get_search_content` and `findText`.

The typed results are also in `details.extractions`. In the text, a value longer than 1,000 characters is cut on its own, and the whole result is cut at `maxInlineContentChars`. Pages are fetched as in `readable` mode, including `proxy`, and PDFs are read from their text. Up to three pages are sent to Clairic at a time. The fetched pages are stored as usual, so `get_search_content` can read them afterwards.

`auth` is refused, as with answer mode, so pages fetched with your browser cookies are never sent. GitHub repositories, issues and pull requests are read as in the other modes, with your signed-in `gh` account when you have one, so extracting from a private repository you can read sends its text to Cloudflare, just as answer mode sends it to your chat model.

If the Clairic call for a page fails (missing credentials, HTTP error, timeout after 30 seconds, or an answer that doesn't check out), that page shows `Extraction failed: <reason>` with any credential removed; the other URLs carry on, and the page itself is still stored.

Only the first 200,000 characters of a page are sent, and the result says so when a page was cut, or when Clairic read only part of it. Clairic's context is 64k tokens: in testing, a 256 KB page worked (3.2 s), a 400 KB page was read only in part, and 600 KB or more was rejected.

**Privacy:** with extract, the text of each page you extract from is sent to Cloudflare. The other modes never call Clairic.

## Measurement

The 0.80 threshold and the type checks were measured on two sets of pages written as markdown, the way the fetcher returns them: pricing pages, changelogs, rate-limit docs, status pages, product and event pages, with decoys such as a beta next to the stable version, monthly next to yearly prices, relative dates, European number formats, and values that are only in a table. Some fields are not on their page at all.

- **Calibration**: 10 pages, 43 fields, written while building the mode ([`eval/fixtures/extract-calibration.json`](../eval/fixtures/extract-calibration.json)).
- **Held-out**: 10 pages, 40 fields, written blind by a separate agent that never saw the calibration set or any model output ([`eval/fixtures/extract-holdout.json`](../eval/fixtures/extract-holdout.json)). One label was corrected afterwards: x02's `latest_stable_version` is `v5.3.1`, because the page says `## v5.3.1 (latest)` and that set's rules required the exact text from the page; the original label was `5.3.1`.

The threshold rule is `max(0.80, highest confidence of any wrong value + 0.05)`. The most confident wrong value scored 0.32, so it stays at 0.80.

Results from `eval/field-extract.mjs` run through Pi, 2 rounds per set, so each count covers every field twice:

| Set | Field results | Correct | Correct "not on the page" | Withheld (right guess, < 0.80) | Wrong guess, withheld | Wrong value extracted |
| --- | --- | --- | --- | --- | --- | --- |
| Calibration | 43 × 2 | 62 | 16 | 4 | 4 (highest 0.32) | 0 |
| Held-out | 40 × 2 | 54 | 18 | 4 | 4 (highest 0.24) | 0 |

No value was reported extracted that was wrong, and no field that was on its page came back as not on the page. Two fields per set that were not on their page came back as low-confidence guesses (0.02 to 0.24) instead of "not on the page", shown as uncertain; "Wrong guess, withheld" counts them. Latency was about 200 ms per page (p50).

## Measure it yourself

```bash
PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/field-extract.mjs --repeat 3
```

It loads your Pi model registry and uses Pi's `cloudflare-workers-ai` credential, calls the same extraction code `fetch_content` uses, makes real billed requests, and refuses to run without `PI_WEB_ACCESS_REAL_SEMANTIC=1`. It prints the table's counts per fixture set, plus missed values (reported as not on the page), errors, and latency.
