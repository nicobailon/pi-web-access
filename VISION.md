# Vision

## What pi-web-access is

pi-web-access gives a Pi agent the web: search, page fetching, follow-up reads of stored results, source checks, video understanding, and GitHub repos cloned locally instead of scraped.
It serves a single Pi operator first: one person who wants good answers from the web inside their session, with control over which services see their queries.
The same tools also run as a local MCP server for other agents, but the product is designed around Pi.

## Providers must earn their place

Search and fetch providers are the most expensive part of this codebase to keep.
Each built-in provider adds a source file, tests, config keys, README text, and an entry in the same shared lists every other provider uses.
Two provider PRs conflict on those lists, and a fix that applies to all providers, such as timeout handling, has to touch every one of them.

This project once accepted providers one PR at a time, because each looked small and the vendor offered to do the work.
It reached 48 search providers. About ten resold the same Google results, most were opened by the vendor, and almost none were ever mentioned by anyone else.
They were removed in one release, and that removal broke config for anyone who used them.

So a provider is built in only when it gives users something no built-in provider does:

- its own search index, not results bought from Google or Bing;
- a kind of answer or content the others can't return;
- a self-hosted, keyless, or private option;
- access through a subscription or plan the operator already pays for.

A provider that differs from an existing one mainly in price, account, or vendor does not get built in, however small the PR.
Vendor interest is not user demand. A provider request counts as demand when someone other than the vendor asks for it or uses it.

## Everything else is config

A search API that takes a query and returns a JSON list of results is added as a custom provider in `web-search.json`, not as code.
The extension ships one generic custom-provider path, and `docs/custom-providers.md` holds copy-paste recipes.
A vendor who wants to be supported contributes a recipe, not a provider file.
Custom providers run only when the operator names them; `auto` never picks them.

## The operator decides where queries go

Queries and fetched URLs leave the machine only for services the operator configured.
`auto` tries a short, stable list of providers, and adding a provider to it is a product decision, not part of adding the provider.
Hosted page fetchers for remote targets, browser cookies, and authenticated fetches stay opt-in.
When a setting names something that no longer exists or can't be used, the extension fails with a message that says what to do, instead of quietly sending queries somewhere else.

## Context is the budget

The four tool definitions are sent on every turn, and a test caps their size.
A new parameter has to fit under that cap or replace text elsewhere.
Provider names stay out of tool descriptions; `provider` is a plain string.

## Compatibility is explicit

Default to hard cutovers when a provider, option, or config key is removed or replaced.
Do not keep aliases or shims unless the owner asks for them.
When something is removed, the changelog lists the names, config keys, and environment variables that stop working, and the error message points to the replacement.

## What this project refuses

It does not build in another reseller of Google or Bing results.
It does not build in a page fetcher that does what Firecrawl, Jina, Crawl4AI, or Bright Data Web Unlocker already do here.
It does not add a provider to `auto` or `all` as part of the PR that adds the provider.
It does not take a provider PR without an issue that explains what the provider adds.
It does not put provider marketing, referral links, or tracking parameters in docs, links, or errors.

## How to judge a change

A change fits when it makes web answers better, cheaper, or more private for the operator, and works the same whichever provider they use.
A new built-in provider fits only when it passes the bar above and a recipe in `docs/custom-providers.md` can't do the same job.
When in doubt, ask whether the operator would notice if the change were missing, and who would keep it working a year from now.
