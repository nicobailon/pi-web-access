# Contributing

Bug reports and fixes are welcome. Open an issue first for anything larger than a bug fix, so we can agree on the shape before you write it. [VISION.md](VISION.md) explains what the project accepts and why.

## New search or fetch providers

Each built-in provider adds code, tests, configuration, and documentation that has to be kept working, and every new provider touches the same shared lists as the last one. A provider is built in only when it gives users something no built-in provider does, for example:

- its own search index, not results bought from Google or Bing;
- a kind of answer or content the others can't return;
- a self-hosted, keyless, or private option for people who can't send queries to a third party.

Not accepted as built-in providers:

- an API that resells Google or Bing results;
- a page fetcher that does what Firecrawl, Jina, Crawl4AI, or Bright Data Web Unlocker already do here;
- a provider that differs from an existing one mainly in price or account.

Any search API that takes a query and returns a JSON list of results can still be used as a custom provider in `web-search.json`. To support one, add a recipe to [docs/custom-providers.md](docs/custom-providers.md) instead of a provider file.

If you work for the provider, say so in the issue. Open an issue that explains what the provider adds before writing the code; a provider PR without one will be closed.
