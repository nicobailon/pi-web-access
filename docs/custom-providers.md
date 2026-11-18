# Custom search providers

A custom provider lets `web_search` use any search API that takes a query and answers with a JSON list of results, without a code change. You describe the request and where the results are in `~/.pi/agent/web-search.json`, and the provider's name then works like a built-in one: `provider: "serper"`, a list such as `"serper,brave"`, the config `provider`, `searchRouting.providers`, and `webSearch.allowedProviders`.

Custom providers run only when you name them. `auto` and `all` never use them.

```json
{
  "customSearchProviders": {
    "serper": {
      "url": "https://google.serper.dev/search",
      "method": "POST",
      "apiKey": "$SERPER_API_KEY",
      "apiKeyHeader": "X-API-KEY",
      "body": { "q": "{query}", "num": "{count}" },
      "results": "organic",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

## Fields

| Field | Required | What it does |
| --- | --- | --- |
| `url` | yes | The search endpoint. Must be HTTPS (HTTP only for `localhost`, or with `allowHttpBaseUrls`), with no query string; put parameters in `query`. |
| `method` | no | `"GET"` (default) or `"POST"`. |
| `apiKey` | no | The key. Like every other `*ApiKey`, it can be the key itself, `$ENV_VAR` to read an environment variable, or `!command` to run a local command that prints it. |
| `apiKeyHeader` | with `apiKey` | Send the key in this header. |
| `apiKeyPrefix` | no | Text put before the key in the header, for example `"Bearer "`. |
| `apiKeyQuery` | with `apiKey` | Send the key as this query parameter instead of a header. Set exactly one of `apiKeyHeader` or `apiKeyQuery`. |
| `headers` | no | Extra fixed headers, such as `"User-Agent"`. |
| `query` | no | Query parameters. Values may use `{query}` and `{count}`. |
| `body` | no | JSON body for a `POST`. String values may use `{query}` and `{count}`; a value of exactly `"{count}"` is sent as a number. |
| `results` | no | Dotted path to the array of results in the response, such as `"organic"` or `"data.sources"`. Leave it out when the response itself is the array. If the path is missing from a response, the search returns no results, since many APIs leave the array out when nothing matched; a value that is there but isn't an array is an error. |
| `fields` | yes | Dotted paths inside one result: `title` and `url` are required, `snippet` is optional. Results without a title or an `http(s)` URL are skipped. |

`{query}` is the search text and `{count}` is the number of results asked for (5 by default, at most 20). Nothing else is filled in.

Each request times out after 60 seconds. The key is removed from any error text. A `domainFilter` is applied to the returned URLs, so a few extra results are asked for when one is set. A `recencyFilter` is not sent, because there is no general way to express it; put a fixed date parameter in `query` or `body` if the API has one.

A name may contain lowercase letters, digits and `-`, and cannot be `auto`, `all`, or the name of a built-in provider.

## Recipes

Each recipe below was written from the built-in provider it replaces. Merge the `customSearchProviders` entry into your `web-search.json` and set the environment variable, or replace the `apiKey` value with the key itself.

The recipes send only the query (and a result count where the API takes one). Domain filters are applied to the returned URLs, as for every custom provider, and recency is not sent. What the built-in versions did differently:

- serper, serpapi, serply, serpbase and autom sent domain filters as Google `site:` terms and recency as Google's `tbs` time filter. searchapi did the same with its `time_period` filter.
- cloro and outcrawl sent domain filters as `site:` terms and had no recency filter.
- sofya sent domain filters as `include_domains` / `exclude_domains` and recency as `freshness`; search1api sent `include_sites` / `exclude_sites` and `time_range`.
- serpdive added the recency to the question text as a hint.
- xcrawl and specstream sent no filters either; they filtered the returned URLs, as the recipes do.

### serper

```json
{
  "customSearchProviders": {
    "serper": {
      "url": "https://google.serper.dev/search",
      "method": "POST",
      "apiKey": "$SERPER_API_KEY",
      "apiKeyHeader": "X-API-KEY",
      "body": { "q": "{query}", "num": "{count}" },
      "results": "organic",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### serpapi

```json
{
  "customSearchProviders": {
    "serpapi": {
      "url": "https://serpapi.com/search.json",
      "apiKey": "$SERPAPI_KEY",
      "apiKeyQuery": "api_key",
      "query": { "engine": "google", "q": "{query}", "num": "{count}" },
      "results": "organic_results",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### serply

```json
{
  "customSearchProviders": {
    "serply": {
      "url": "https://api.serply.io/v1/search",
      "apiKey": "$SERPLY_API_KEY",
      "apiKeyHeader": "X-Api-Key",
      "query": { "q": "{query}", "num": "{count}" },
      "results": "results",
      "fields": { "title": "title", "url": "link", "snippet": "description" }
    }
  }
}
```

### searchapi

```json
{
  "customSearchProviders": {
    "searchapi": {
      "url": "https://www.searchapi.io/api/v1/search",
      "apiKey": "$SEARCHAPI_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "headers": { "User-Agent": "pi-web-access" },
      "query": { "engine": "google", "q": "{query}" },
      "results": "organic_results",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### serpbase

```json
{
  "customSearchProviders": {
    "serpbase": {
      "url": "https://api.serpbase.dev/google/search",
      "apiKey": "$SERPBASE_API_KEY",
      "apiKeyQuery": "api_key",
      "query": { "q": "{query}", "num": "{count}" },
      "results": "organic_results",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### autom

```json
{
  "customSearchProviders": {
    "autom": {
      "url": "https://api.autom.dev/v1/google/search",
      "apiKey": "$AUTOM_API_KEY",
      "apiKeyHeader": "x-api-key",
      "query": { "query": "{query}" },
      "results": "organic_results",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### cloro

Google results only. The built-in provider's Google and Bing AI Mode answers have no recipe.

```json
{
  "customSearchProviders": {
    "cloro": {
      "url": "https://api.cloro.dev/v1/monitor/google",
      "method": "POST",
      "apiKey": "$CLORO_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "headers": { "User-Agent": "pi-web-access" },
      "body": { "query": "{query}", "country": "US" },
      "results": "result.organicResults",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### xcrawl

```json
{
  "customSearchProviders": {
    "xcrawl": {
      "url": "https://run.xcrawl.com/v1/serp",
      "method": "POST",
      "apiKey": "$XCRAWL_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "body": { "engine": "google_search", "q": "{query}" },
      "results": "organic_results",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### serpdive

SERPdive returns at most 10 results per request.

```json
{
  "customSearchProviders": {
    "serpdive": {
      "url": "https://api.serpdive.com/v1/search",
      "method": "POST",
      "apiKey": "$SERPDIVE_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "body": { "query": "{query}", "model": "krill", "max_results": 10 },
      "results": "results",
      "fields": { "title": "title", "url": "url", "snippet": "content" }
    }
  }
}
```

### search1api

```json
{
  "customSearchProviders": {
    "search1api": {
      "url": "https://api.search1api.com/search",
      "method": "POST",
      "apiKey": "$SEARCH1API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "body": { "query": "{query}", "max_results": "{count}", "crawl_results": 0 },
      "results": "results",
      "fields": { "title": "title", "url": "link", "snippet": "snippet" }
    }
  }
}
```

### outcrawl

```json
{
  "customSearchProviders": {
    "outcrawl": {
      "url": "https://api.outcrawl.ai/v1/search",
      "method": "POST",
      "apiKey": "$OUTCRAWL_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "headers": { "User-Agent": "pi-web-access" },
      "body": { "query": "{query}", "limit": "{count}" },
      "results": "hits",
      "fields": { "title": "title", "url": "url", "snippet": "snippet" }
    }
  }
}
```

### sofya

```json
{
  "customSearchProviders": {
    "sofya": {
      "url": "https://sofya.co/v1/search",
      "method": "POST",
      "apiKey": "$SOFYA_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "headers": { "User-Agent": "pi-web-access" },
      "body": { "query": "{query}", "search_depth": "snippets", "max_results": "{count}" },
      "results": "results",
      "fields": { "title": "title", "url": "url", "snippet": "content" }
    }
  }
}
```

### specstream

Search only; page fetches through SpecStream have no recipe.

```json
{
  "customSearchProviders": {
    "specstream": {
      "url": "https://api.specstream.ai/v1/web-search",
      "apiKey": "$SPECSTREAM_API_KEY",
      "apiKeyHeader": "Authorization",
      "apiKeyPrefix": "Bearer ",
      "headers": { "User-Agent": "pi-web-access" },
      "query": { "q": "{query}" },
      "results": "data.sources",
      "fields": { "title": "title", "url": "url", "snippet": "snippet" }
    }
  }
}
```

### brightdata

No recipe. Bright Data's search takes a Google results URL with the query encoded inside it, plus a zone name, and a custom provider only fills in plain text. Bright Data Web Unlocker page fetches still work as before.
