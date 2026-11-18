# Contributing

Bug reports and fixes are welcome. Open an issue first for anything larger than a bug fix, so we can agree on the shape before you write it.

## New search or fetch providers

The extension already supports more than 40 search providers. Each one adds code, tests, configuration, and documentation that has to be kept working, and every new provider touches the same shared lists as the last one. A new provider is accepted only when it gives users something no existing provider does, for example:

- its own search index, not results bought from Google or Bing;
- a kind of answer or content the others can't return;
- a self-hosted or private option for people who can't send queries to a third party.

Not accepted:

- another API that resells Google or Bing results; several are already supported;
- a page fetcher that does what Firecrawl, Jina, or Bright Data Web Unlocker already do here;
- a provider that differs from an existing one mainly in price or account.

If you work for the provider, say so in the issue. Open an issue that explains what the provider adds before writing the code; a provider PR without one will be closed.
