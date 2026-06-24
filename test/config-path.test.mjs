import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const utilsUrl = new URL("../utils.ts", import.meta.url).href;
const perplexityUrl = new URL("../perplexity.ts", import.meta.url).href;
const geminiApiUrl = new URL("../gemini-api.ts", import.meta.url).href;

function runChild(script, env) {
	const childEnv = { ...process.env };
	delete childEnv.PERPLEXITY_API_KEY;
	delete childEnv.GEMINI_API_KEY;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) {
			delete childEnv[key];
		} else {
			childEnv[key] = value;
		}
	}
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
}

test("web-search config path uses PI_CODING_AGENT_DIR before XDG_CONFIG_HOME", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-config-path-"));
	const agentDir = join(root, "agent-dir");
	const xdgDir = join(root, "xdg");
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(agentDir, "web-search.json"), JSON.stringify({ perplexityApiKey: "pplx-from-agent" }) + "\n", "utf8");
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({}) + "\n", "utf8");

	const child = runChild(`
		const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isPerplexityAvailable } = await import(${JSON.stringify(perplexityUrl)});
		console.log(JSON.stringify({
			dir: getWebSearchConfigDir(),
			path: getWebSearchConfigPath(),
			available: isPerplexityAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: xdgDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: agentDir,
		path: join(agentDir, "web-search.json"),
		available: true,
	});
});

test("web-search config path uses XDG_CONFIG_HOME pi directory when agent dir is unset", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-web-access-xdg-config-"));
	const xdgDir = join(root, "xdg");
	await mkdir(join(xdgDir, "pi"), { recursive: true });
	await writeFile(join(xdgDir, "pi", "web-search.json"), JSON.stringify({ geminiApiKey: "gemini-from-xdg" }) + "\n", "utf8");

	const child = runChild(`
		const { getWebSearchConfigDir, getWebSearchConfigPath } = await import(${JSON.stringify(utilsUrl)});
		const { isGeminiApiAvailable } = await import(${JSON.stringify(geminiApiUrl)});
		console.log(JSON.stringify({
			dir: getWebSearchConfigDir(),
			path: getWebSearchConfigPath(),
			available: isGeminiApiAvailable(),
		}));
	`, {
		PI_CODING_AGENT_DIR: undefined,
		XDG_CONFIG_HOME: xdgDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	});

	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), {
		dir: join(xdgDir, "pi"),
		path: join(xdgDir, "pi", "web-search.json"),
		available: true,
	});
});
