import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { resolveApiBaseUrl, resolveProviderApiUrl } from "../utils.ts";

const configDir = mkdtempSync(join(tmpdir(), "pi-web-access-http-base-url-"));
process.env.PI_CODING_AGENT_DIR = configDir;
delete process.env.PARALLEL_BASE_URL;
after(() => rmSync(configDir, { recursive: true, force: true }));

function withHttpSwitch(config, environmentValue, fn) {
	writeFileSync(join(configDir, "web-search.json"), JSON.stringify(config));
	if (environmentValue === undefined) delete process.env.PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS;
	else process.env.PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS = environmentValue;
	try {
		fn();
	} finally {
		delete process.env.PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS;
	}
}

const braveUrl = (configuredValue) => resolveApiBaseUrl({
	configKey: "braveBaseUrl",
	configuredValue,
	defaultValue: "https://api.search.brave.com/res/v1",
	environmentKey: "BRAVE_BASE_URL",
	environmentValue: undefined,
});
const parallelUrl = (configuredValue) => resolveProviderApiUrl("parallel", "https://api.parallel.ai/v1/search", configuredValue);

test("HTTP base URLs on non-loopback hosts require allowHttpBaseUrls", () => {
	withHttpSwitch({}, undefined, () => {
		assert.throws(() => braveUrl("http://gateway.internal:8080/brave"), /braveBaseUrl in .*web-search\.json must be an absolute HTTPS URL/);
		assert.equal(braveUrl("http://127.0.0.1:8080/brave"), "http://127.0.0.1:8080/brave");
	});
	withHttpSwitch({ allowHttpBaseUrls: true }, undefined, () => {
		assert.equal(braveUrl("http://gateway.internal:8080/brave/"), "http://gateway.internal:8080/brave");
		assert.equal(parallelUrl("http://10.0.0.1:8080/parallel"), "http://10.0.0.1:8080/parallel/v1/search");
		assert.equal(braveUrl(undefined), "https://api.search.brave.com/res/v1");
		assert.throws(() => braveUrl("http://user:pass@gateway.internal"), /must not include credentials/);
		assert.throws(() => braveUrl("http://gateway.internal/?region=us"), /must not include query parameters or fragments/);
	});
});

test("PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS overrides allowHttpBaseUrls and invalid values fail", () => {
	withHttpSwitch({ allowHttpBaseUrls: true }, "0", () => {
		assert.throws(() => braveUrl("http://gateway.internal"), /must be an absolute HTTPS URL/);
	});
	withHttpSwitch({ allowHttpBaseUrls: false }, " TRUE ", () => {
		assert.equal(parallelUrl("http://gateway.internal/parallel"), "http://gateway.internal/parallel/v1/search");
	});
	for (const value of ["yes", ""]) {
		withHttpSwitch({ allowHttpBaseUrls: true }, value, () => {
			assert.throws(() => braveUrl("http://gateway.internal"), /Invalid configuration: PI_WEB_ACCESS_ALLOW_HTTP_BASE_URLS must be true, false, 1, or 0/);
		});
	}
	withHttpSwitch({ allowHttpBaseUrls: "true" }, undefined, () => {
		assert.throws(() => braveUrl("http://gateway.internal"), /allowHttpBaseUrls in .*web-search\.json must be a boolean/);
	});
});

test("provider URL resolution keeps endpoint paths and derives multiword environment names", () => {
	const previous = process.env.MISTRAL_SEARCH_BASE_URL;
	try {
		delete process.env.MISTRAL_SEARCH_BASE_URL;
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "https://gateway.example.com/mistral///"),
			"https://gateway.example.com/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "http://localhost:8080/mistral/";
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "not-a-url"),
			"http://localhost:8080/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "";
		assert.throws(() => resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "https://gateway.example.com"),
			/MISTRAL_SEARCH_BASE_URL must be/);
	} finally {
		if (previous === undefined) delete process.env.MISTRAL_SEARCH_BASE_URL;
		else process.env.MISTRAL_SEARCH_BASE_URL = previous;
	}
});

test("provider URL resolution preserves root trailing slashes needed for path-based APIs", () => {
	const previous = process.env.JINA_SEARCH_BASE_URL;
	try {
		delete process.env.JINA_SEARCH_BASE_URL;
		assert.equal(resolveProviderApiUrl("jinaSearch", "https://s.jina.ai/", "https://gateway.example.com/jina/"),
			"https://gateway.example.com/jina/");
	} finally {
		if (previous === undefined) delete process.env.JINA_SEARCH_BASE_URL;
		else process.env.JINA_SEARCH_BASE_URL = previous;
	}
});
