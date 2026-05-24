import { execFile } from "node:child_process";
import type { ExtractedContent } from "./extract.js";
import type { GitHubUrlInfo } from "./github-extract.js";

const MAX_TREE_ENTRIES = 200;
const MAX_INLINE_FILE_CHARS = 100_000;

let ghAvailable: boolean | null = null;
let ghHintShown = false;

export async function checkGhAvailable(): Promise<boolean> {
	if (ghAvailable !== null) return ghAvailable;

	return new Promise((resolve) => {
		execFile("gh", ["--version"], { timeout: 5000 }, (err) => {
			ghAvailable = !err;
			resolve(ghAvailable);
		});
	});
}

export function showGhHint(): void {
	if (!ghHintShown) {
		ghHintShown = true;
		console.error("[pi-web-access] Install `gh` CLI for better GitHub repo access including private repos.");
	}
}

export async function checkRepoSize(owner: string, repo: string): Promise<number | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".size"], { timeout: 10000 }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const kb = parseInt(stdout.trim(), 10);
			resolve(Number.isNaN(kb) ? null : kb);
		});
	});
}

async function getDefaultBranch(owner: string, repo: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile("gh", ["api", `repos/${owner}/${repo}`, "--jq", ".default_branch"], { timeout: 10000 }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			const branch = stdout.trim();
			resolve(branch || null);
		});
	});
}

async function fetchTreeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, "--jq", ".tree[].path"],
			{ timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				const paths = stdout.trim().split("\n").filter(Boolean);
				if (paths.length === 0) {
					resolve(null);
					return;
				}
				const truncated = paths.length > MAX_TREE_ENTRIES;
				const display = paths.slice(0, MAX_TREE_ENTRIES).join("\n");
				resolve(truncated ? display + `\n... (${paths.length} total entries)` : display);
			},
		);
	});
}

async function fetchReadmeViaApi(owner: string, repo: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}/readme?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10000 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					const decoded = Buffer.from(stdout.trim(), "base64").toString("utf-8");
					resolve(decoded.length > 8192 ? decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : decoded);
				} catch {
					resolve(null);
				}
			},
		);
	});
}

async function fetchFileViaApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	if (!(await checkGhAvailable())) return null;

	return new Promise((resolve) => {
		execFile(
			"gh",
			["api", `repos/${owner}/${repo}/contents/${path}?ref=${ref}`, "--jq", ".content"],
			{ timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					resolve(Buffer.from(stdout.trim(), "base64").toString("utf-8"));
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/**
 * Fetch file content via direct GitHub REST API (no gh CLI needed)
 * Works for public repos without authentication.
 */
async function fetchFileViaDirectApi(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
	try {
		const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
		const res = await fetch(url, {
			headers: { "Accept": "application/vnd.github.v3+json" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return null;
		const data = await res.json() as { content?: string };
		if (!data.content) return null;
		return Buffer.from(data.content, "base64").toString("utf-8");
	} catch {
		return null;
	}
}

/**
 * Fetch repo tree via direct GitHub REST API (no gh CLI needed)
 */
async function fetchTreeViaDirectApi(owner: string, repo: string, ref: string): Promise<string | null> {
	try {
		const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
		const res = await fetch(url, {
			headers: { "Accept": "application/vnd.github.v3+json" },
			signal: AbortSignal.timeout(15000),
		});
		if (!res.ok) return null;
		const data = await res.json() as { tree?: Array<{ path: string; type: string }> };
		const tree = data.tree || [];
		const filtered = tree.filter(t => t.type === "blob");
		const paths = filtered.slice(0, MAX_TREE_ENTRIES).map(t => t.path);
		if (paths.length === 0) return null;
		const truncated = filtered.length > MAX_TREE_ENTRIES;
		return paths.join("\n") + (truncated ? `\n... (${filtered.length} total entries)` : "");
	} catch {
		return null;
	}
}

/**
 * Fetch README via direct GitHub REST API (no gh CLI needed)
 */
async function fetchReadmeViaDirectApi(owner: string, repo: string, ref: string): Promise<string | null> {
	try {
		const url = `https://api.github.com/repos/${owner}/${repo}/readme?ref=${encodeURIComponent(ref)}`;
		const res = await fetch(url, {
			headers: { "Accept": "application/vnd.github.v3+json" },
			signal: AbortSignal.timeout(10000),
		});
		if (!res.ok) return null;
		const data = await res.json() as { content?: string };
		if (!data.content) return null;
		const decoded = Buffer.from(data.content, "base64").toString("utf-8");
		return decoded.length > 8192 ? decoded.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : decoded;
	} catch {
		return null;
	}
}

export async function fetchViaApi(
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	sizeNote?: string,
): Promise<ExtractedContent | null> {
	const ref = info.ref || (await getDefaultBranch(owner, repo));
	if (!ref) return null;

	const lines: string[] = [];
	if (sizeNote) {
		lines.push(sizeNote);
		lines.push("");
	}

	if (info.type === "blob" && info.path) {
		// Try gh CLI first, fall back to direct API
		let content = await fetchFileViaApi(owner, repo, info.path, ref);
		if (!content) {
			content = await fetchFileViaDirectApi(owner, repo, info.path, ref);
		}
		if (!content) return null;

		lines.push(`## ${info.path}`);
		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push(`\n[File truncated at 100K chars]`);
		} else {
			lines.push(content);
		}

		return {
			url,
			title: `${owner}/${repo} - ${info.path}`,
			content: lines.join("\n"),
			error: null,
		};
	}

	// Try gh CLI first, fall back to direct API
	let [tree, readme] = await Promise.all([
		fetchTreeViaApi(owner, repo, ref),
		fetchReadmeViaApi(owner, repo, ref),
	]);

	if (!tree || !readme) {
		const [treeFallback, readmeFallback] = await Promise.all([
			fetchTreeViaDirectApi(owner, repo, ref),
			fetchReadmeViaDirectApi(owner, repo, ref),
		]);
		tree = tree ?? treeFallback;
		readme = readme ?? readmeFallback;
	}

	if (!tree && !readme) return null;

	if (tree) {
		lines.push("## Structure");
		lines.push(tree);
		lines.push("");
	}

	if (readme) {
		lines.push("## README.md");
		lines.push(readme);
		lines.push("");
	}

	lines.push("This is an API-only view. Clone the repo or use `read`/`bash` for deeper exploration.");

	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return {
		url,
		title,
		content: lines.join("\n"),
		error: null,
	};
}
