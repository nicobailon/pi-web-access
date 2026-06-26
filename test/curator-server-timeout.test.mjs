import assert from "node:assert/strict";
import { access, unlink, writeFile } from "node:fs/promises";
import { after, test } from "node:test";

const curatorPageShim = new URL("../curator-page.js", import.meta.url);
let wroteCuratorPageShim = false;

const TEST_TIMEOUT_MS = 8000;

async function loadServer() {
	try {
		await access(curatorPageShim);
	} catch {
		await writeFile(
			curatorPageShim,
			'export { generateCuratorPage } from "./curator-page.ts";\n',
			"utf8",
		);
		wroteCuratorPageShim = true;
	}

	return import(`../curator-server.ts?test=${Date.now()}`);
}

after(async () => {
	if (!wroteCuratorPageShim) return;
	await unlink(curatorPageShim).catch(() => {});
});

function baseOptions(timeout = 1) {
	return {
		queries: ["test query"],
		sessionToken: "test-token",
		timeout,
		availableProviders: { openai: false, brave: false, parallel: false, tavily: false, searxng: false, perplexity: false, exa: true, gemini: false },
		defaultProvider: "exa",
		searchProvider: "exa",
		summaryModels: [],
		defaultSummaryModel: null,
	};
}

function baseCallbacks(resolveCancel) {
	return {
		onSubmit: () => {},
		onCancel: resolveCancel,
		onProviderChange: () => {},
		onAddSearch: async () => ({ answer: "", results: [], provider: "exa" }),
		onSummarize: async () => ({
			summary: "",
			meta: { model: null, durationMs: 0, tokenEstimate: 0, fallbackUsed: true },
		}),
		onRewriteQuery: async (query) => query,
	};
}

function withTimeout(promise, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`${label} timed out`)), TEST_TIMEOUT_MS);
		}),
	]);
}

test("curator times out when searches finish but no browser connects", async () => {
	const { startCuratorServer } = await loadServer();
	let resolveCancel;
	const cancelPromise = new Promise((resolve) => { resolveCancel = resolve; });
	const handle = await startCuratorServer(baseOptions(1), baseCallbacks(resolveCancel));

	try {
		handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
		handle.searchesDone();

		const reason = await withTimeout(cancelPromise, "no-browser timeout");
		assert.equal(reason, "timeout");
	} finally {
		handle.close();
	}
});

test("curator heartbeat timeout finalizes connected idle browser sessions", async () => {
	const { startCuratorServer } = await loadServer();
	let resolveCancel;
	const cancelPromise = new Promise((resolve) => { resolveCancel = resolve; });
	const handle = await startCuratorServer(baseOptions(20), baseCallbacks(resolveCancel));

	try {
		await fetch(handle.url);
		handle.pushResult(0, { answer: "answer", results: [], provider: "exa" });
		handle.searchesDone();

		const response = await fetch(new URL("/heartbeat", handle.url), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: "test-token", idleMs: 21000, timeoutSec: 20 }),
		});
		assert.equal(response.status, 200);

		const reason = await withTimeout(cancelPromise, "idle heartbeat timeout");
		assert.equal(reason, "timeout");
	} finally {
		handle.close();
	}
});
