import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

const moduleUrl = new URL("../github-issue-pr.ts", import.meta.url).href;
const extractUrl = new URL("../extract.ts", import.meta.url).href;
const publicLookup = async () => [{ address: "140.82.112.6", family: 4 }];

async function writeFakeExecutable(binDir, name, source) {
	const executable = join(binDir, name);
	await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
	return executable;
}

// For tests that assert a wall-clock bound: a Node shim costs 300–900 ms just
// to boot on a loaded host and the bound is 1 s, so the probe alone can fail
// the assertion. A /bin/sh shim starts in a few ms.
async function writeFakeShellExecutable(binDir, name, script) {
	const executable = join(binDir, name);
	await writeFile(executable, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return executable;
}

test("parseGitHubIssuePrUrl accepts PR and issue variants without changing repo parsing", async () => {
	const { parseGitHubIssuePrUrl } = await import(moduleUrl);
	assert.deepEqual(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/123/files#discussion_r42"), {
		owner: "owner", repo: "repo", kind: "pull", number: 123, anchor: "discussion_r42",
	});
	assert.deepEqual(parseGitHubIssuePrUrl("https://www.github.com/owner/repo/issues/5#issuecomment-99"), {
		owner: "owner", repo: "repo", kind: "issue", number: 5, anchor: "issuecomment-99",
	});
	assert.deepEqual(parseGitHubIssuePrUrl("https://www.github.com/owner/repo/issues/5#discussion_r99"), {
		owner: "owner", repo: "repo", kind: "issue", number: 5,
	});
	assert.equal(parseGitHubIssuePrUrl("https://github.com/owner/repo/pulls"), null);
	assert.equal(parseGitHubIssuePrUrl("https://github.com/owner/repo/issues/new"), null);
	assert.equal(parseGitHubIssuePrUrl("https://github.com/owner/repo/pull/123/unknown"), null);
	assert.equal(parseGitHubIssuePrUrl("https://github.com/owner/repo/issues/5/edit"), null);
	assert.equal(parseGitHubIssuePrUrl("https://github.com/owner%2Frepo/repo/issues/1"), null);
});

test("renderer orders sections, marks truncation, and forces anchored comments inline", async () => {
	const { renderGitHubPrIssue } = await import(moduleUrl);
	const comments = Array.from({ length: 20 }, (_, index) => ({
		id: index + 1,
		user: { login: `user${index + 1}` },
		created_at: "2026-01-01T00:00:00Z",
		body: index === 18 ? "anchored comment body" : `comment ${index + 1}`,
	}));
	const result = renderGitHubPrIssue({
		url: "https://github.com/owner/repo/pull/7#issuecomment-19",
		owner: "owner",
		repo: "repo",
		kind: "pull",
		number: 7,
		anchor: "issuecomment-19",
		reviewThreads: [],
		fallbackNotes: [],
		view: {
			number: 7,
			title: "Improve fetch",
			state: "OPEN",
			isDraft: false,
			author: { login: "alice" },
			baseRefName: "main",
			headRefName: "feature",
			headRepositoryOwner: { login: "fork" },
			createdAt: "2026-01-01T00:00:00Z",
			labels: [{ name: "bug" }],
			additions: 5,
			deletions: 1,
			changedFiles: 1,
			body: "x".repeat(4100),
			files: [{ path: "a.ts", additions: 5, deletions: 1 }],
			commits: [{ oid: "abcdef123456", messageHeadline: "commit subject" }],
			comments,
			statusCheckRollup: [{ name: "test", conclusion: "SUCCESS" }],
		},
	});

	assert.equal(result.error, null);
	assert.match(result.content, /#7 Improve fetch/);
	assert.ok(result.content.indexOf("## Body") < result.content.indexOf("## Checks"));
	assert.ok(result.content.includes('[body truncated; the rest is stored under "body (continued)": use get_search_content findText or offset]'));
	assert.match(result.content, /user19.*\[anchored\]/s);
	assert.ok(result.content.includes('[16 of 20 comments shown; 4 more stored under "Conversation comments (continued)": use get_search_content findText or offset, or gh issue view -c]'));
	assert.equal(result.content.split("anchored comment body").length - 1, 1);
	assert.match(result.content, /gh pr diff 7 --repo owner\/repo/);
});

test("extractGitHubIssuePr retries gh view with core fields on unknown --json field", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-pr-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `
		const args = process.argv.slice(2);
		if (args[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
		if (args[0] === "pr" && args[1] === "view") {
			const fields = args[args.indexOf("--json") + 1] || "";
			if (fields.includes("statusCheckRollup")) { console.error("Unknown JSON field: statusCheckRollup"); process.exit(1); }
			console.log(JSON.stringify({ number: 12, title: "Fallback fields", state: "OPEN", author: { login: "alice" }, body: "body", comments: [] }));
			process.exit(0);
		}
		if (args[0] === "api") { console.log("[]"); process.exit(0); }
		process.exit(1);
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/12");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.match(result.content, /Fallback fields/);
	assert.match(result.content, /retried with the core field set/);
	assert.match(result.content, /Linked references\nUnavailable in this GitHub fetch path/);
});

test("gh path fetches an anchored review comment beyond fetched pages", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-deep-review-anchor-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `
		const args = process.argv.slice(2);
		if (args[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
		if (args[0] === "pr" && args[1] === "view") {
			console.log(JSON.stringify({ number: 7, title: "Deep anchor", state: "OPEN", author: { login: "alice" }, body: "body", comments: [] }));
			process.exit(0);
		}
		if (args[0] === "api" && args[1].includes("/pulls/7/comments?")) {
			const comments = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, user: { login: "page" }, path: "a.ts", line: 1, body: "paged" }));
			console.log(JSON.stringify(comments));
			process.exit(0);
		}
		if (args[0] === "api" && args[1].endsWith("/pulls/comments/999")) {
			console.log(JSON.stringify({ id: 999, pull_request_url: "https://api.github.com/repos/owner/repo/pulls/7", user: { login: "reviewer" }, path: "deep.ts", line: 44, body: "deep anchor" }));
			process.exit(0);
		}
		process.exit(1);
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/7#discussion_r999");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.match(result.content, /reviewer.*\[anchored\]/s);
	assert.match(result.content, /deep anchor/);
	assert.match(result.content, /review threads: at least 301/);
	assert.match(result.content, /review thread comments shown from at least 301/);
});

test("gh path rejects anchored review comments from another pull request", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-cross-review-anchor-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `
		const args = process.argv.slice(2);
		if (args[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
		if (args[0] === "pr" && args[1] === "view") {
			console.log(JSON.stringify({ number: 7, title: "Cross anchor", state: "OPEN", author: { login: "alice" }, body: "body", comments: [] }));
			process.exit(0);
		}
		if (args[0] === "api" && args[1].includes("/pulls/7/comments?")) { console.log(JSON.stringify([])); process.exit(0); }
		if (args[0] === "api" && args[1].endsWith("/pulls/comments/999")) {
			console.log(JSON.stringify({ id: 999, pull_request_url: "https://api.github.com/repos/other/repo/pulls/7", user: { login: "wrong" }, path: "wrong.ts", line: 1, body: "wrong pull" }));
			process.exit(0);
		}
		process.exit(1);
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/7#discussion_r999");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.doesNotMatch(result.content, /wrong pull/);
	assert.match(result.content, /anchored review thread comment unavailable for this pull request/);
});

test("gh path still attempts an anchored review comment after page failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-page-fail-anchor-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `
		const args = process.argv.slice(2);
		if (args[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
		if (args[0] === "pr" && args[1] === "view") {
			console.log(JSON.stringify({ number: 7, title: "Page fail anchor", state: "OPEN", author: { login: "alice" }, body: "body", comments: [] }));
			process.exit(0);
		}
		if (args[0] === "api" && args[1].includes("/pulls/7/comments?")) { process.exit(1); }
		if (args[0] === "api" && args[1].endsWith("/pulls/comments/999")) {
			console.log(JSON.stringify({ id: 999, pull_request_url: "https://api.github.com/repos/owner/repo/pulls/7", user: { login: "reviewer" }, path: "deep.ts", line: 44, body: "deep after page failure" }));
			process.exit(0);
		}
		process.exit(1);
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/7#discussion_r999");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.match(result.content, /reviewer.*\[anchored\]/s);
	assert.match(result.content, /deep after page failure/);
});

test("gh review thread page failure renders unavailable instead of none", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-review-unavailable-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `
		const args = process.argv.slice(2);
		if (args[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
		if (args[0] === "pr" && args[1] === "view") {
			console.log(JSON.stringify({ number: 7, title: "Unavailable reviews", state: "OPEN", author: { login: "alice" }, body: "body", comments: [] }));
			process.exit(0);
		}
		if (args[0] === "api" && args[1].includes("/pulls/7/comments?")) { process.exit(1); }
		process.exit(1);
	`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/7");
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout);
	assert.match(result.content, /review threads: unavailable/);
	assert.match(result.content, /Review thread comments\nUnavailable in this GitHub fetch path/);
});

test("extractGitHubIssuePr aborts active gh work with the caller signal", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-abort-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeShellExecutable(binDir, "gh", `if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi\nsleep 30`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async (_input, init = {}) => {
				if (!init.signal?.aborted) throw new Error("fallback fetch did not receive aborted signal");
				throw new Error("aborted fallback fetch");
			};
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);
			const started = Date.now();
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/7", controller.signal, { lookup: async () => [{ address: "140.82.112.6", family: 4 }] });
			console.log(JSON.stringify({ elapsed: Date.now() - started, result }));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.result.error, "Aborted");
	// Alternative outcome is the 30 s gh hang; 5 s proves the abort won without racing process spawn on a loaded host.
	assert.ok(output.elapsed < 5000, `expected abort before gh timeout, got ${output.elapsed}ms`);
});

test("extractGitHubIssuePr aborts a hung gh availability probe", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-probe-abort-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeShellExecutable(binDir, "gh", `sleep 30`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { extractGitHubIssuePr } = await import(${JSON.stringify(moduleUrl)});
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 50);
			const started = Date.now();
			const result = await extractGitHubIssuePr("https://github.com/owner/repo/pull/7", controller.signal);
			console.log(JSON.stringify({ elapsed: Date.now() - started, result }));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout);
	assert.equal(output.result.error, "Aborted");
	assert.ok(output.elapsed < 5000, `expected abort before gh probe timeout, got ${output.elapsed}ms`);
});

test("REST fallback preserves caller cancellation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-rest-abort-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeShellExecutable(binDir, "gh", `exit 1`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const controller = new AbortController();
			const fetched = [];
			globalThis.fetch = async (input, init = {}) => {
				fetched.push(String(input));
				setTimeout(() => controller.abort(), 10);
				await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("Aborted REST fetch")), { once: true }));
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = ${publicLookup.toString()};
			const result = await extractContent("https://github.com/owner/repo/issues/12", controller.signal, { lookup });
			console.log(JSON.stringify({ fetched, result }));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.split("\n").at(-2));
	assert.equal(output.result.error, "Aborted");
	// The invariant is ORDERING, not speed: the aborted REST request must be the
	// only fetch — the generic github.com page fallback must never start. (A
	// wall-clock bound here raced process spawn, which is 300–900 ms on a loaded
	// host before any code of ours runs.)
	assert.deepEqual(output.fetched, ["https://api.github.com/repos/owner/repo/issues/12"]);
});

test("extractContent returns an actionable GitHub rate-limit result instead of HTML fall-through", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-rate-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `process.exit(1);`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async () => new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" } });
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = ${publicLookup.toString()};
			const result = await extractContent("https://github.com/owner/repo/issues/12", undefined, { lookup });
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.split("\n").at(-2));
	assert.equal(result.status, 403);
	assert.match(result.error, /rate limit/i);
	assert.match(result.content, /gh auth login/);
});

test("REST fallback fetches an anchored issue comment outside the first page", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-issue-anchor-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `process.exit(1);`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async (input) => {
				const url = String(input);
				if (url.endsWith("/issues/12")) return new Response(JSON.stringify({ number: 12, title: "Issue", state: "open", user: { login: "owner" }, body: "body", comments: 75 }), { status: 200 });
				if (url.endsWith("/issues/12/comments?per_page=50")) return new Response(JSON.stringify([{ id: 1, user: { login: "first" }, created_at: "2026-01-01T00:00:00Z", body: "first page" }]), { status: 200 });
				if (url.endsWith("/issues/comments/99")) return new Response(JSON.stringify({ id: 99, issue_url: "https://api.github.com/repos/owner/repo/issues/12", user: { login: "anchored" }, created_at: "2026-01-02T00:00:00Z", body: "outside first page" }), { status: 200 });
				throw new Error("unexpected URL " + url);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = ${publicLookup.toString()};
			const result = await extractContent("https://github.com/owner/repo/issues/12#issuecomment-99", undefined, { lookup });
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.split("\n").at(-2));
	assert.match(result.content, /anchored.*\[anchored\]/s);
	assert.match(result.content, /outside first page/);
	assert.match(result.content, /comments: at least 75/);
	assert.match(result.content, /comments shown from at least 75/);
});

test("REST fallback rejects anchored issue comments from another work item", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-cross-issue-anchor-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `process.exit(1);`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async (input) => {
				const url = String(input);
				if (url.endsWith("/issues/12")) return new Response(JSON.stringify({ number: 12, title: "Issue", state: "open", user: { login: "owner" }, body: "body", comments: 1 }), { status: 200 });
				if (url.endsWith("/issues/12/comments?per_page=50")) return new Response(JSON.stringify([]), { status: 200 });
				if (url.endsWith("/issues/comments/99")) return new Response(JSON.stringify({ id: 98, issue_url: "https://api.github.com/repos/other/repo/issues/12", user: { login: "wrong" }, created_at: "2026-01-02T00:00:00Z", body: "wrong issue" }), { status: 200 });
				throw new Error("unexpected URL " + url);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = ${publicLookup.toString()};
			const result = await extractContent("https://github.com/owner/repo/issues/12#issuecomment-99", undefined, { lookup });
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.split("\n").at(-2));
	assert.doesNotMatch(result.content, /wrong issue/);
	assert.match(result.content, /anchored comment unavailable for this issue or pull request/);
});

test("REST fallback fetches an anchored PR review comment outside the first page", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-review-anchor-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `process.exit(1);`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async (input) => {
				const url = String(input);
				if (url.endsWith("/pulls/7")) return new Response(JSON.stringify({ number: 7, title: "PR", state: "open", user: { login: "owner" }, body: "body", draft: false, base: { ref: "main" }, head: { ref: "feature", repo: { owner: { login: "owner" } } }, additions: 1, deletions: 0, changed_files: 75, review_comments: 12 }), { status: 200 });
				if (url.endsWith("/issues/7/comments?per_page=50")) return new Response(JSON.stringify([]), { status: 200 });
				if (url.endsWith("/pulls/7/files?per_page=50")) return new Response(JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ filename: "file" + index + ".ts", additions: 1, deletions: 0 }))), { status: 200 });
				if (url.endsWith("/pulls/7/comments?per_page=50")) return new Response(JSON.stringify([{ id: 1, user: { login: "first" }, path: "a.ts", line: 1, body: "first review" }]), { status: 200 });
				if (url.endsWith("/pulls/comments/42")) return new Response(JSON.stringify({ id: 42, pull_request_url: "https://api.github.com/repos/owner/repo/pulls/7", user: { login: "reviewer" }, path: "b.ts", line: 9, body: "outside review page" }), { status: 200 });
				throw new Error("unexpected URL " + url);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = ${publicLookup.toString()};
			const result = await extractContent("https://github.com/owner/repo/pull/7#discussion_r42", undefined, { lookup });
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.split("\n").at(-2));
	assert.match(result.content, /reviewer.*\[anchored\]/s);
	assert.match(result.content, /outside review page/);
	assert.match(result.content, /commits unavailable/);
	assert.match(result.content, /Review verdicts\nUnavailable in this GitHub fetch path/);
	assert.match(result.content, /50 files shown from at least 75/);
	assert.match(result.content, /Commits\nUnavailable in this GitHub fetch path/);
	assert.match(result.content, /review threads: at least 12/);
	assert.match(result.content, /review thread comments shown from at least 12/);
	assert.match(result.content, /Linked references\nUnavailable in this GitHub fetch path/);
});

test("REST fallback does not render positive changedFiles as none when files are missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-files-unavailable-"));
	const binDir = join(root, "bin");
	const agentDir = join(root, "agent");
	await mkdir(binDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFakeExecutable(binDir, "gh", `process.exit(1);`);

	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			globalThis.fetch = async (input) => {
				const url = String(input);
				if (url.endsWith("/pulls/7")) return new Response(JSON.stringify({ number: 7, title: "PR", state: "open", user: { login: "owner" }, body: "body", draft: false, base: { ref: "main" }, head: { ref: "feature", repo: { owner: { login: "owner" } } }, additions: 1, deletions: 0, changed_files: 3 }), { status: 200 });
				if (url.endsWith("/issues/7/comments?per_page=50")) return new Response(JSON.stringify([]), { status: 200 });
				if (url.endsWith("/pulls/7/files?per_page=50")) return new Response(JSON.stringify([]), { status: 200 });
				if (url.endsWith("/pulls/7/comments?per_page=50")) return new Response(JSON.stringify([]), { status: 200 });
				throw new Error("unexpected URL " + url);
			};
			const { extractContent } = await import(${JSON.stringify(extractUrl)});
			const lookup = ${publicLookup.toString()};
			const result = await extractContent("https://github.com/owner/repo/pull/7", undefined, { lookup });
			console.log(JSON.stringify(result));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: agentDir },
	});

	assert.equal(child.status, 0, child.stderr);
	const result = JSON.parse(child.stdout.split("\n").at(-2));
	assert.match(result.content, /0 files shown from at least 3/);
	assert.doesNotMatch(result.content, /Files\nnone/);
});

// Pi's registered fetch_content and the MCP core, over a fake gh, with the given web-search.json.
async function fetchGitHubDocument(config) {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-retrieval-name-"));
	const binDir = join(root, "bin");
	await mkdir(binDir, { recursive: true });
	await writeFile(join(root, "web-search.json"), JSON.stringify(config));
	await writeFakeExecutable(binDir, "gh", `
		const args = process.argv.slice(2);
		if (args[0] === "--version") { console.log("gh version 2.0.0"); process.exit(0); }
		if (args[0] === "pr" && args[1] === "view") {
			const comments = Array.from({ length: 16 }, (_, index) => ({ id: index + 1, author: { login: "fixture" }, body: "comment " + index }));
			const reviews = Array.from({ length: 11 }, (_, index) => ({ author: { login: "reviewer" + index }, state: "COMMENTED", body: "review " + index }));
			console.log(JSON.stringify({ number: 7, title: "Retrieval names", state: "OPEN", author: { login: "alice" }, body: "BODY_PREFIX_" + "x".repeat(4100), comments, reviews }));
			process.exit(0);
		}
		if (args[0] === "api") { console.log("[]"); process.exit(0); }
		process.exit(1);
	`);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initialize } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
			const { createStandaloneWebToolCore } = await import(${JSON.stringify(new URL("../web-tool-core.ts", import.meta.url).href)});
			const tools = [];
			initialize({ registerTool(tool) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
			const text = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\\n");
			const url = "https://github.com/owner/repo/pull/7";
			const pi = await tools.find(tool => tool.name === "fetch_content").execute("fetch", { url });
			const mcp = await createStandaloneWebToolCore().fetchContent({ url });
			console.log(JSON.stringify({ pi: text(pi), mcp: text(mcp) }));
		`,
		encoding: "utf8",
		env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH || ""}`, PI_CODING_AGENT_DIR: root, HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: "" },
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1));
}

test("GitHub document hints name the renamed retrieval tool in Pi and keep the MCP name", async () => {
	const { pi, mcp } = await fetchGitHubDocument({ toolNames: { getSearchContent: "grab_content" } });
	assert.doesNotMatch(pi, /get_search_content/);
	assert.ok(pi.includes('[body truncated; the rest is stored under "body (continued)": use grab_content findText or offset]'));
	assert.ok(pi.includes('[15 of 16 comments shown; 1 more stored under "Conversation comments (continued)": use grab_content findText or offset, or gh issue view -c]'));
	assert.ok(pi.includes('[10 of 11 review verdicts shown; 1 more stored under "Review verdicts (continued)": use grab_content findText or offset, or the gh command below]'));
	assert.match(pi, /Stored full document: use `grab_content`/);
	assert.ok(mcp.includes('[body truncated; the rest is stored under "body (continued)": use get_search_content findText or offset]'));
	assert.match(mcp, /Stored full document: use `get_search_content`/);
	assert.doesNotMatch(mcp, /grab_content/);
});

test("GitHub document hints point only at gh when retrieval is disabled", async () => {
	const { pi, mcp } = await fetchGitHubDocument({ tools: { getSearchContent: { enabled: false } } });
	for (const text of [pi, mcp]) {
		assert.doesNotMatch(text, /get_search_content|Stored full document/);
		assert.match(text, /\[body truncated; use the gh escalation commands below for the rest\]/);
		assert.match(text, /\[15 of 16 comments shown; use gh issue view -c\]/);
		assert.match(text, /\[10 of 11 review verdicts shown; use the gh command below\]/);
		assert.match(text, /Full view: `gh pr view 7 --repo owner\/repo`/);
	}
});

test("stored GitHub document holds each fetched item once, including tails and items past inline caps", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-gh-stored-once-"));
	const fixture = {
		url: "https://github.com/owner/repo/pull/7", owner: "owner", repo: "repo", kind: "pull", number: 7, fallbackNotes: [],
		reviewThreads: Array.from({ length: 31 }, (_, index) => ({ id: 1000 + index, path: "a.ts", line: 1, user: { login: "reviewer" },
			body: index === 0 ? `THREAD_HEAD ${"t".repeat(800)} THREAD_TAIL` : index === 30 ? "OMITTED_THREAD_SENTINEL" : `thread ${index}` })),
		view: {
			number: 7, title: "Stored once", state: "OPEN", author: { login: "alice" },
			body: `BODY_PREFIX_${"x".repeat(3989)} BODY_TAIL`,
			comments: Array.from({ length: 16 }, (_, index) => ({ id: index + 1, author: { login: "fixture" },
				body: index === 0 ? `COMMENT_HEAD ${"c".repeat(800)} COMMENT_TAIL` : index === 15 ? "OMITTED_COMMENT_SENTINEL" : `comment ${index}` })),
			reviews: [{ author: { login: "bob" }, state: "COMMENTED", body: `REVIEW_HEAD ${"r".repeat(400)} REVIEW_TAIL` }],
			files: Array.from({ length: 51 }, (_, index) => ({ path: index === 50 ? "omitted-file-sentinel.ts" : `file${index}.ts`, additions: 1, deletions: 0 })),
			commits: Array.from({ length: 21 }, (_, index) => ({ oid: `${index}`.padStart(7, "0"), messageHeadline: index === 20 ? "OMITTED_COMMIT_SENTINEL" : `commit ${index}` })),
			statusCheckRollup: Array.from({ length: 16 }, (_, index) => ({ name: index === 15 ? "OMITTED_CHECK_SENTINEL" : `check ${index}`, conclusion: "SUCCESS" })),
		},
	};
	const sentinels = ["BODY_PREFIX_", "BODY_TAIL", "COMMENT_HEAD", "COMMENT_TAIL", "OMITTED_COMMENT_SENTINEL", "REVIEW_HEAD", "REVIEW_TAIL",
		"THREAD_HEAD", "THREAD_TAIL", "OMITTED_THREAD_SENTINEL", "omitted-file-sentinel.ts", "OMITTED_COMMIT_SENTINEL", "OMITTED_CHECK_SENTINEL"];
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { renderGitHubPrIssue } = await import(${JSON.stringify(moduleUrl)});
			const { storeResult } = await import(${JSON.stringify(new URL("../storage.ts", import.meta.url).href)});
			const { createStandaloneWebToolCore } = await import(${JSON.stringify(new URL("../web-tool-core.ts", import.meta.url).href)});
			const document = renderGitHubPrIssue(${JSON.stringify(fixture)});
			storeResult("doc", { id: "doc", type: "fetch", timestamp: Date.now(), urls: [document] });
			const core = createStandaloneWebToolCore();
			const matches = {};
			for (const findText of ${JSON.stringify(sentinels)}) matches[findText] = (await core.getSearchContent({ responseId: "doc", findText })).details.matchCount;
			console.log(JSON.stringify(matches));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_WEB_ACCESS_CACHE_ROOT: root },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)), Object.fromEntries(sentinels.map(sentinel => [sentinel, 1])));
});

test("markers for data never fetched point only at gh, and the document ceiling names the gh commands", async () => {
	const { renderGitHubPrIssue } = await import(moduleUrl);
	const render = (view) => renderGitHubPrIssue({ url: "https://github.com/owner/repo/pull/7", owner: "owner", repo: "repo", kind: "pull", number: 7, reviewThreads: [], fallbackNotes: [], view: { number: 7, title: "T", state: "OPEN", ...view } }).content;
	const comments = count => Array.from({ length: count }, (_, index) => ({ id: index + 1, author: { login: "a" }, body: `comment ${index}` }));

	assert.ok(render({ comments: comments(2), commentsCount: 40 }).includes("[2 comments shown from at least 40; use gh issue view -c]"));
	assert.ok(render({ comments: comments(16), commentsCount: 40 }).includes('[15 comments shown from at least 40; 1 more stored under "Conversation comments (continued)": use get_search_content findText or offset; for the rest use gh issue view -c]'));
	assert.ok(render({ changedFiles: 3, files: [] }).includes("[0 files shown from at least 3; use the gh command below]"));
	// A long body is cut at a word boundary, so each word stays searchable in one piece.
	assert.equal(render({ body: `${"word ".repeat(799)}BOUNDARY_TOKEN tail` }).split("BOUNDARY_TOKEN").length - 1, 1);

	const huge = render({ body: "y".repeat(200_000) });
	assert.ok(huge.includes("## Escalation commands"));
	assert.ok(huge.endsWith("[GitHub document truncated at 150000 chars; use `gh pr view 7 --repo owner/repo` or `gh pr diff 7 --repo owner/repo` for complete data]"));
});
