import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const extractUrl = new URL("../extract.ts", import.meta.url).href;

// `loadSsrfAllowRanges` reads the config path captured at module load, so each
// case runs in a child process with PI_CODING_AGENT_DIR pointed at a temp dir.
function runLoad(env) {
	const childEnv = { ...process.env };
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const script = `
		const { loadSsrfAllowRanges } = await import(${JSON.stringify(extractUrl)});
		try {
			console.log(JSON.stringify({ ok: true, ranges: loadSsrfAllowRanges() }));
		} catch (err) {
			console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		}
	`;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function runLoadConfig(env) {
	const childEnv = { ...process.env };
	delete childEnv.PI_CODING_AGENT_DIR;
	delete childEnv.XDG_CONFIG_HOME;
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete childEnv[key];
		else childEnv[key] = value;
	}
	const script = `
		const { loadSsrfConfig } = await import(${JSON.stringify(extractUrl)});
		try {
			console.log(JSON.stringify({ ok: true, config: loadSsrfConfig() }));
		} catch (err) {
			console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
		}
	`;
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

async function makeConfigDir(prefix) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const agentDir = join(root, "agent-dir");
	await mkdir(agentDir, { recursive: true });
	return { root, agentDir, configPath: join(agentDir, "web-search.json") };
}

function envFor(root, agentDir) {
	return {
		PI_CODING_AGENT_DIR: agentDir,
		HOME: join(root, "home"),
		USERPROFILE: join(root, "home"),
	};
}

test("loadSsrfConfig defaults trustEnvProxy to false", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-proxy-default-");
	await writeFile(configPath, JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15"] } }), "utf8");

	const result = runLoadConfig(envFor(root, agentDir));
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.config, { allowRanges: ["198.18.0.0/15"], trustEnvProxy: false });
});

test("loadFetchContentDomainPolicy reads normalized allow and deny hostnames", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-domain-policy-valid-");
	await writeFile(configPath, JSON.stringify({ fetchContent: { domainPolicy: { allow: [" Example.COM. "], deny: ["blocked.example.com"] } } }), "utf8");

	const childEnv = envFor(root, agentDir);
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { loadFetchContentDomainPolicy } = await import(${JSON.stringify(extractUrl.replace("/extract.ts", "/ssrf-protection.ts"))});
			console.log(JSON.stringify(loadFetchContentDomainPolicy()));
		`,
		encoding: "utf8",
		env: childEnv,
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout), { allow: ["example.com"], deny: ["blocked.example.com"] });
});

test("loadFetchContentDomainPolicy rejects malformed policy values", async () => {
	for (const domainPolicy of [
		{ allow: "example.com" },
		{ deny: ["*.example.com"] },
		{ allow: ["example.com", 42] },
	]) {
		const { root, agentDir, configPath } = await makeConfigDir("pi-domain-policy-invalid-");
		await writeFile(configPath, JSON.stringify({ fetchContent: { domainPolicy } }), "utf8");
		const childEnv = envFor(root, agentDir);
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			input: `
				const { loadFetchContentDomainPolicy } = await import(${JSON.stringify(extractUrl.replace("/extract.ts", "/ssrf-protection.ts"))});
				try { loadFetchContentDomainPolicy(); console.log(JSON.stringify({ ok: true })); }
				catch (err) { console.log(JSON.stringify({ ok: false, error: err.message })); }
			`,
			encoding: "utf8",
			env: childEnv,
		});
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout);
		assert.equal(result.ok, false, JSON.stringify(domainPolicy));
		assert.match(result.error, /fetchContent\.domainPolicy\.(allow|deny)/);
	}
});

function runLoadRedirectPolicy(env) {
	const child = spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { loadFetchContentRedirectPolicy } = await import(${JSON.stringify(extractUrl.replace("/extract.ts", "/ssrf-protection.ts"))});
			try { console.log(JSON.stringify({ ok: true, policy: loadFetchContentRedirectPolicy() ?? null })); }
			catch (err) { console.log(JSON.stringify({ ok: false, error: err.message })); }
		`,
		encoding: "utf8",
		env,
	});
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

test("loadFetchContentRedirectPolicy is off unless fetchContent.redirects is set", async () => {
	const missing = await makeConfigDir("pi-redirect-policy-missing-");
	assert.deepEqual(runLoadRedirectPolicy(envFor(missing.root, missing.agentDir)), { ok: true, policy: null });

	const unset = await makeConfigDir("pi-redirect-policy-unset-");
	await writeFile(unset.configPath, JSON.stringify({ fetchContent: { domainPolicy: { allow: ["example.com"] } } }), "utf8");
	assert.deepEqual(runLoadRedirectPolicy(envFor(unset.root, unset.agentDir)), { ok: true, policy: null });

	const set = await makeConfigDir("pi-redirect-policy-set-");
	await writeFile(set.configPath, JSON.stringify({ fetchContent: { redirects: "same-origin" } }), "utf8");
	assert.deepEqual(runLoadRedirectPolicy(envFor(set.root, set.agentDir)), { ok: true, policy: "same-origin" });
});

test("loadFetchContentRedirectPolicy rejects values other than same-origin", async () => {
	for (const redirects of ["follow", "Same-Origin", true, { mode: "same-origin" }]) {
		const { root, agentDir, configPath } = await makeConfigDir("pi-redirect-policy-invalid-");
		await writeFile(configPath, JSON.stringify({ fetchContent: { redirects } }), "utf8");
		const result = runLoadRedirectPolicy(envFor(root, agentDir));
		assert.equal(result.ok, false, JSON.stringify(redirects));
		assert.match(result.error, /fetchContent\.redirects in .*web-search\.json must be "same-origin"/);
	}
});

test("loadSsrfConfig accepts an explicit trustEnvProxy opt-in", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-proxy-enabled-");
	await writeFile(configPath, JSON.stringify({ ssrf: { trustEnvProxy: true } }), "utf8");

	const result = runLoadConfig(envFor(root, agentDir));
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.config, { allowRanges: [], trustEnvProxy: true });
});

test("loadSsrfConfig rejects a non-boolean trustEnvProxy value", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-proxy-invalid-");
	await writeFile(configPath, JSON.stringify({ ssrf: { trustEnvProxy: "yes" } }), "utf8");

	const result = runLoadConfig(envFor(root, agentDir));
	assert.equal(result.ok, false);
	assert.match(result.error, /ssrf\.trustEnvProxy in .* must be a boolean/);
});

test("loadSsrfAllowRanges throws when ssrf.allowRanges is not an array", async () => {
	// Regression: a mistyped non-array value (bare string, object, number) must
	// fail loudly instead of being silently ignored as "no exemptions".
	for (const allowRanges of ["198.18.0.0/15", { "198.18.0.0/15": true }, 42]) {
		const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-nonarray-");
		await writeFile(configPath, JSON.stringify({ ssrf: { allowRanges } }), "utf8");

		const result = runLoad(envFor(root, agentDir));
		assert.equal(result.ok, false, `expected throw for ${JSON.stringify(allowRanges)}`);
		assert.match(result.error, /ssrf\.allowRanges in .* must be an array of CIDR strings/);
	}
});

test("loadSsrfAllowRanges throws when an ssrf.allowRanges entry is not a string", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-entry-type-");
	await writeFile(configPath, JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15", 123] } }), "utf8");

	const result = runLoad(envFor(root, agentDir));
	assert.equal(result.ok, false);
	assert.match(result.error, /ssrf\.allowRanges in .* must contain only CIDR strings; entry 2 is number/);
});

test("loadSsrfAllowRanges returns trimmed, non-empty CIDR strings for a valid array", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-valid-");
	await writeFile(
		configPath,
		JSON.stringify({ ssrf: { allowRanges: ["198.18.0.0/15", "  fd00::/8  ", "", "   "] } }),
		"utf8",
	);

	const result = runLoad(envFor(root, agentDir));
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.ranges, ["198.18.0.0/15", "fd00::/8"]);
});

test("loadSsrfAllowRanges returns [] when the config file is missing", async () => {
	const { root, agentDir } = await makeConfigDir("pi-ssrf-missing-");
	// Intentionally do not write web-search.json.
	const result = runLoad(envFor(root, agentDir));
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.ranges, []);
});

test("loadSsrfAllowRanges returns [] when ssrf.allowRanges is unset", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-unset-");
	await writeFile(configPath, JSON.stringify({ perplexityApiKey: "pplx-x" }), "utf8");

	const result = runLoad(envFor(root, agentDir));
	assert.equal(result.ok, true, result.error);
	assert.deepEqual(result.ranges, []);
});

test("loadSsrfAllowRanges reports malformed config JSON", async () => {
	const { root, agentDir, configPath } = await makeConfigDir("pi-ssrf-badjson-");
	await writeFile(configPath, "{ not valid json", "utf8");

	const result = runLoad(envFor(root, agentDir));
	assert.equal(result.ok, false);
	assert.match(result.error, /Failed to parse .*web-search\.json/);
});
