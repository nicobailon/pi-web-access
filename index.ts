import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { fetchAllContent, type ExtractedContent } from "./extract.js";
import { searchWithPerplexity, type SearchResult } from "./perplexity.js";
import {
	clearResults,
	deleteResult,
	generateId,
	getAllResults,
	getResult,
	restoreFromSession,
	storeResult,
	type QueryResultData,
	type StoredSearchData,
} from "./storage.js";

const pendingFetches = new Map<string, AbortController>();
let sessionActive = false;

function formatSearchSummary(results: SearchResult[], answer: string): string {
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

function abortPendingFetches(): void {
	for (const controller of pendingFetches.values()) {
		controller.abort();
	}
	pendingFetches.clear();
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		abortPendingFetches();
		sessionActive = true;
		restoreFromSession(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		abortPendingFetches();
		sessionActive = true;
		restoreFromSession(ctx);
	});
	pi.on("session_branch", async (_event, ctx) => {
		abortPendingFetches();
		sessionActive = true;
		restoreFromSession(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		abortPendingFetches();
		sessionActive = true;
		restoreFromSession(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionActive = false;
		abortPendingFetches();
		clearResults();
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Perplexity AI. Returns an AI-synthesized answer with source citations. Supports batch searching with multiple queries. When includeContent is true, full page content is fetched in the background.",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Single search query" })),
			queries: Type.Optional(Type.Array(Type.String(), { description: "Multiple queries (parallel)" })),
			numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
			includeContent: Type.Optional(Type.Boolean({ description: "Fetch full page content (async)" })),
			recencyFilter: Type.Optional(
				Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
					description: "Filter by recency",
				}),
			),
			domainFilter: Type.Optional(Type.Array(Type.String(), { description: "Limit to domains (prefix with - to exclude)" })),
		}),

		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			const queryList = params.queries ?? (params.query ? [params.query] : []);
			if (queryList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
					details: { error: "No query provided" },
				};
			}

			const searchResults: QueryResultData[] = [];
			const allUrls: string[] = [];

			for (let i = 0; i < queryList.length; i++) {
				const query = queryList[i];

				onUpdate?.({
					content: [{ type: "text", text: `Searching ${i + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: i / queryList.length, currentQuery: query },
				});

				try {
					const { answer, results } = await searchWithPerplexity(query, {
						numResults: params.numResults,
						recencyFilter: params.recencyFilter,
						domainFilter: params.domainFilter,
						signal,
					});

					searchResults.push({ query, answer, results, error: null });
					for (const r of results) {
						if (!allUrls.includes(r.url)) {
							allUrls.push(r.url);
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					searchResults.push({ query, answer: "", results: [], error: message });
				}
			}

			const successCount = searchResults.filter((r) => !r.error).length;
			const totalResults = searchResults.reduce((sum, r) => sum + r.results.length, 0);

			let output = "";
			for (const { query, answer, results, error } of searchResults) {
				if (queryList.length > 1) {
					output += `## Query: "${query}"\n\n`;
				}
				if (error) {
					output += `Error: ${error}\n\n`;
				} else if (results.length === 0) {
					output += "No results found.\n\n";
				} else {
					output += formatSearchSummary(results, answer) + "\n\n";
				}
			}

			let fetchId: string | null = null;
			if (params.includeContent && allUrls.length > 0) {
				fetchId = generateId();
				const controller = new AbortController();
				pendingFetches.set(fetchId, controller);

				const capturedFetchId = fetchId;
				fetchAllContent(allUrls, controller.signal)
					.then((fetched) => {
						if (!sessionActive || !pendingFetches.has(capturedFetchId)) {
							return;
						}

						const data: StoredSearchData = {
							id: capturedFetchId,
							type: "fetch",
							timestamp: Date.now(),
							urls: fetched,
						};
						storeResult(capturedFetchId, data);
						pi.appendEntry("web-search-results", data);

						const successfulFetches = fetched.filter((f) => !f.error).length;
						pi.sendMessage(
							{
								customType: "web-search-content-ready",
								content: `Content fetched for ${successfulFetches}/${fetched.length} URLs [${capturedFetchId}]. Full page content now available.`,
								display: true,
							},
							{ triggerTurn: true },
						);
					})
					.catch((err) => {
						if (!sessionActive || !pendingFetches.has(capturedFetchId)) {
							return;
						}

						const message = err instanceof Error ? err.message : String(err);
						const isAbort = err.name === "AbortError" || message.toLowerCase().includes("abort");
						if (!isAbort) {
							pi.sendMessage(
								{
									customType: "web-search-error",
									content: `Content fetch failed [${capturedFetchId}]: ${message}`,
									display: true,
								},
								{ triggerTurn: false },
							);
						}
					})
					.finally(() => {
						pendingFetches.delete(capturedFetchId);
					});

				output += `---\nContent fetching in background [${fetchId}]. Will notify when ready.`;
			}

			const searchId = generateId();
			const searchData: StoredSearchData = {
				id: searchId,
				type: "search",
				timestamp: Date.now(),
				queries: searchResults,
			};
			storeResult(searchId, searchData);
			pi.appendEntry("web-search-results", searchData);

			return {
				content: [{ type: "text", text: output.trim() }],
				details: {
					queries: queryList,
					queryCount: queryList.length,
					successfulQueries: successCount,
					totalResults,
					includeContent: params.includeContent ?? false,
					fetchId,
					fetchUrls: fetchId ? allUrls : undefined,
					searchId,
				},
			};
		},

		renderCall(args, theme) {
			const { query, queries } = args as { query?: string; queries?: string[] };
			const queryList = queries ?? (query ? [query] : []);
			if (queryList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			}
			if (queryList.length === 1) {
				const q = queryList[0];
				const display = q.length > 60 ? q.slice(0, 57) + "..." : q;
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${display}"`), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${queryList.length} queries`)];
			for (const q of queryList.slice(0, 5)) {
				const display = q.length > 50 ? q.slice(0, 47) + "..." : q;
				lines.push(theme.fg("muted", `  "${display}"`));
			}
			if (queryList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${queryList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as {
				queryCount?: number;
				successfulQueries?: number;
				totalResults?: number;
				error?: string;
				fetchId?: string;
				fetchUrls?: string[];
				phase?: string;
				progress?: number;
			};

			if (isPartial) {
				const progress = details?.progress ?? 0;
				const bar = "\u2588".repeat(Math.floor(progress * 10)) + "\u2591".repeat(10 - Math.floor(progress * 10));
				return new Text(theme.fg("accent", `[${bar}] ${details?.phase || "searching"}`), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const queryInfo = details?.queryCount === 1 ? "" : `${details?.successfulQueries}/${details?.queryCount} queries, `;
			let statusLine = theme.fg("success", `${queryInfo}${details?.totalResults ?? 0} sources`);
			if (details?.fetchId && details?.fetchUrls) {
				statusLine += theme.fg("muted", ` (fetching ${details.fetchUrls.length} URLs)`);
			} else if (details?.fetchId) {
				statusLine += theme.fg("muted", " (content fetching)");
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const lines = [statusLine];
			if (details?.fetchUrls && details.fetchUrls.length > 0) {
				lines.push(theme.fg("muted", "Fetching:"));
				for (const u of details.fetchUrls.slice(0, 5)) {
					const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
					lines.push(theme.fg("dim", "  " + display));
				}
				if (details.fetchUrls.length > 5) {
					lines.push(theme.fg("dim", `  ... and ${details.fetchUrls.length - 5} more`));
				}
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			lines.push(theme.fg("dim", preview));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract readable content as markdown. For multiple URLs, content is stored and can be retrieved with get_search_content.",
		parameters: Type.Object({
			url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
			urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
		}),

		async execute(_toolCallId, params, onUpdate, _ctx, signal) {
			const urlList = params.urls ?? (params.url ? [params.url] : []);
			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
				details: { phase: "fetch", progress: 0 },
			});

			const fetchResults = await fetchAllContent(urlList, signal);
			const successful = fetchResults.filter((r) => !r.error).length;
			const totalChars = fetchResults.reduce((sum, r) => sum + r.content.length, 0);

			if (urlList.length === 1) {
				const result = fetchResults[0];
				if (result.error) {
					return {
						content: [{ type: "text", text: `Error: ${result.error}` }],
						details: { urls: urlList, urlCount: 1, successful: 0, error: result.error },
					};
				}
				return {
					content: [{ type: "text", text: result.content }],
					details: { urls: urlList, urlCount: 1, successful: 1, totalChars: result.content.length, title: result.title },
				};
			}

			const responseId = generateId();
			const data: StoredSearchData = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: fetchResults,
			};
			storeResult(responseId, data);
			pi.appendEntry("web-search-results", data);

			let output = "## Fetched URLs\n\n";
			for (const { url, title, content, error } of fetchResults) {
				if (error) {
					output += `- ${url}: Error - ${error}\n`;
				} else {
					output += `- ${title || url} (${content.length} chars)\n`;
				}
			}
			output += `\n---\nUse get_search_content("${responseId}", {urlIndex: 0}) to retrieve full content.`;

			return {
				content: [{ type: "text", text: output }],
				details: { urls: urlList, urlCount: urlList.length, successful, totalChars, responseId },
			};
		},

		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const urlList = urls ?? (url ? [url] : []);
			if (urlList.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			}
			if (urlList.length === 1) {
				const display = urlList[0].length > 50 ? urlList[0].slice(0, 47) + "..." : urlList[0];
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display), 0, 0);
			}
			const lines = [theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${urlList.length} URLs`)];
			for (const u of urlList.slice(0, 5)) {
				const display = u.length > 60 ? u.slice(0, 57) + "..." : u;
				lines.push(theme.fg("muted", "  " + display));
			}
			if (urlList.length > 5) {
				lines.push(theme.fg("muted", `  ... and ${urlList.length - 5} more`));
			}
			return new Text(lines.join("\n"), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				urlCount?: number;
				successful?: number;
				totalChars?: number;
				error?: string;
				title?: string;
			};

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			if (details?.urlCount === 1) {
				const title = details?.title || "Untitled";
				const statusLine = theme.fg("success", title) + theme.fg("muted", ` (${details?.totalChars ?? 0} chars)`);
				if (!expanded) {
					return new Text(statusLine, 0, 0);
				}
				const textContent = result.content.find((c) => c.type === "text")?.text || "";
				const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
				return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
			}

			const statusLine = theme.fg("success", `${details?.successful}/${details?.urlCount} URLs`) + theme.fg("muted", " (content stored)");
			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}
			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		parameters: Type.Object({
			responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
			query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
			queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
			url: Type.Optional(Type.String({ description: "Get content for this URL" })),
			urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
		}),

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const data = getResult(params.responseId);
			if (!data) {
				return {
					content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
					details: { error: "Not found", responseId: params.responseId },
				};
			}

			if (data.type === "search" && data.queries) {
				let queryData: QueryResultData | undefined;

				if (params.query !== undefined) {
					queryData = data.queries.find((q) => q.query === params.query);
					if (!queryData) {
						const available = data.queries.map((q) => `"${q.query}"`).join(", ");
						return {
							content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
							details: { error: "Query not found" },
						};
					}
				} else if (params.queryIndex !== undefined) {
					queryData = data.queries[params.queryIndex];
					if (!queryData) {
						return {
							content: [{ type: "text", text: `Index ${params.queryIndex} out of range (0-${data.queries.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ");
					return {
						content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
						details: { error: "No query specified" },
					};
				}

				if (queryData.error) {
					return {
						content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
						details: { error: queryData.error, query: queryData.query },
					};
				}

				return {
					content: [{ type: "text", text: formatFullResults(queryData) }],
					details: { query: queryData.query, resultCount: queryData.results.length },
				};
			}

			if (data.type === "fetch" && data.urls) {
				let urlData: ExtractedContent | undefined;

				if (params.url !== undefined) {
					urlData = data.urls.find((u) => u.url === params.url);
					if (!urlData) {
						const available = data.urls.map((u) => u.url).join("\n  ");
						return {
							content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
							details: { error: "URL not found" },
						};
					}
				} else if (params.urlIndex !== undefined) {
					urlData = data.urls[params.urlIndex];
					if (!urlData) {
						return {
							content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${data.urls.length - 1})` }],
							details: { error: "Index out of range" },
						};
					}
				} else {
					const available = data.urls.map((u, i) => `${i}: ${u.url}`).join("\n  ");
					return {
						content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
						details: { error: "No URL specified" },
					};
				}

				if (urlData.error) {
					return {
						content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
						details: { error: urlData.error, url: urlData.url },
					};
				}

				return {
					content: [{ type: "text", text: `# ${urlData.title}\n\n${urlData.content}` }],
					details: { url: urlData.url, title: urlData.title, contentLength: urlData.content.length },
				};
			}

			return {
				content: [{ type: "text", text: "Invalid stored data format" }],
				details: { error: "Invalid data" },
			};
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex } = args as {
				responseId: string;
				query?: string;
				queryIndex?: number;
				url?: string;
				urlIndex?: number;
			};
			let target = "";
			if (query) target = `query="${query}"`;
			else if (queryIndex !== undefined) target = `queryIndex=${queryIndex}`;
			else if (url) target = url.length > 30 ? url.slice(0, 27) + "..." : url;
			else if (urlIndex !== undefined) target = `urlIndex=${urlIndex}`;
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target || responseId.slice(0, 8)), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as {
				error?: string;
				query?: string;
				url?: string;
				title?: string;
				resultCount?: number;
				contentLength?: number;
			};

			if (details?.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			let statusLine: string;
			if (details?.query) {
				statusLine = theme.fg("success", `"${details.query}"`) + theme.fg("muted", ` (${details.resultCount} results)`);
			} else {
				statusLine = theme.fg("success", details?.title || "Content") + theme.fg("muted", ` (${details?.contentLength ?? 0} chars)`);
			}

			if (!expanded) {
				return new Text(statusLine, 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text")?.text || "";
			const preview = textContent.length > 500 ? textContent.slice(0, 500) + "..." : textContent;
			return new Text(statusLine + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && r.urls) {
					return `[${r.id.slice(0, 6)}] ${r.urls.length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && selected.urls) {
					info += "URLs:\n";
					const urls = selected.urls.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						info += `- ${urlDisplay} (${u.error || `${u.content.length} chars`})\n`;
					}
					if (selected.urls.length > 10) {
						info += `... and ${selected.urls.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}
