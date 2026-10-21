import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveApiBaseUrl, resolveProviderApiUrl } from "../utils.ts";

test("provider URL resolution keeps endpoint paths and derives multiword environment names", () => {
	const previous = process.env.MISTRAL_SEARCH_BASE_URL;
	try {
		delete process.env.MISTRAL_SEARCH_BASE_URL;
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "https://gateway.example.com/mistral///"),
			"https://gateway.example.com/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "http://localhost:8080/mistral/";
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "not-a-url"),
			"http://localhost:8080/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "http://gateway.example.com/mistral/";
		assert.throws(() => resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", undefined, false),
			/MISTRAL_SEARCH_BASE_URL must be an absolute HTTPS URL/);
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "not-a-url", true),
			"http://gateway.example.com/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "";
		assert.throws(() => resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "https://gateway.example.com"),
			/MISTRAL_SEARCH_BASE_URL must be/);
	} finally {
		if (previous === undefined) delete process.env.MISTRAL_SEARCH_BASE_URL;
		else process.env.MISTRAL_SEARCH_BASE_URL = previous;
	}
});

const baseUrlOptions = {
	configKey: "braveBaseUrl",
	configuredValue: undefined,
	defaultValue: "https://api.search.brave.com/res/v1",
	environmentKey: "BRAVE_BASE_URL",
	environmentValue: undefined,
};

test("missing and false HTTP opt-ins preserve HTTPS defaults and exact loopback support", () => {
	for (const allowHttp of [undefined, false]) {
		const options = { ...baseUrlOptions, allowHttp };
		assert.equal(resolveApiBaseUrl(options), baseUrlOptions.defaultValue);
		assert.equal(resolveApiBaseUrl({ ...options, configuredValue: "https://gateway.example.com/api///" }),
			"https://gateway.example.com/api");
		for (const host of ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.42.3.4", "[::1]"]) {
			const value = "http://" + host + ":8080/api/";
			assert.equal(resolveApiBaseUrl({ ...options, configuredValue: value }), new URL(value).href.replace(/\/$/, ""));
		}
		for (const host of ["gateway.example.com", "client-gateway", "localhost.example", "foo.localhost", "10.0.0.1", "[fd00::1]", "[::ffff:127.0.0.1]"]) {
			assert.throws(() => resolveApiBaseUrl({ ...options, configuredValue: "http://" + host + "/api" }),
				/braveBaseUrl .* must be an absolute HTTPS URL/);
		}
	}
});

test("HTTP opt-ins permit explicit remote hosts without changing defaults or environment precedence", () => {
	const options = { ...baseUrlOptions, allowHttp: true };
	assert.equal(resolveApiBaseUrl(options), baseUrlOptions.defaultValue);
	assert.equal(resolveApiBaseUrl({ ...options, configuredValue: "https://gateway.example.com/api/" }),
		"https://gateway.example.com/api");
	for (const host of ["gateway.example.com", "client-gateway", "10.0.0.1", "192.168.1.4", "93.184.216.34", "[fd00::1]", "[2001:db8::1]"]) {
		const value = "http://" + host + ":8080/prefix/api///";
		const expected = "http://" + host + ":8080/prefix/api";
		assert.equal(resolveApiBaseUrl({ ...options, configuredValue: value }), expected);
		assert.equal(resolveApiBaseUrl({ ...options, configuredValue: "not-a-url", environmentValue: value }), expected);
	}
});

test("HTTP opt-ins reject non-booleans even without a gateway override", () => {
	for (const allowHttp of ["true", "false", 1, 0, null, {}, []]) {
		for (const configuredValue of [undefined, "https://gateway.example.com", "http://gateway.example.com"]) {
			assert.throws(() => resolveApiBaseUrl({ ...baseUrlOptions, configuredValue, allowHttp }),
				/braveAllowHttp in .*web-search\.json must be a boolean/);
		}
	}
	assert.throws(() => resolveProviderApiUrl("jinaSearch", "https://s.jina.ai/", undefined, "true"),
		/jinaSearchAllowHttp in .*web-search\.json must be a boolean/);
});

test("HTTP environment flags accept booleans and numeric values and override JSON", () => {
	const options = { ...baseUrlOptions, configuredValue: "http://gateway.example.com/api/" };
	for (const allowHttpEnvironmentValue of ["true", "1", "TRUE", " TrUe ", " 1 "]) {
		for (const allowHttp of [undefined, false, "invalid-json-flag"]) {
			assert.equal(resolveApiBaseUrl({ ...options, allowHttp, allowHttpEnvironmentValue }),
				"http://gateway.example.com/api");
		}
		assert.equal(resolveApiBaseUrl({ ...baseUrlOptions, allowHttpEnvironmentValue }), baseUrlOptions.defaultValue);
	}
	for (const allowHttpEnvironmentValue of ["false", "0", "FALSE", " FaLsE ", " 0 "]) {
		const disabled = { ...options, allowHttp: true, allowHttpEnvironmentValue };
		assert.throws(() => resolveApiBaseUrl(disabled), /braveBaseUrl .* must be an absolute HTTPS URL/);
		assert.equal(resolveApiBaseUrl({ ...disabled, configuredValue: "http://localhost:8080/api/" }), "http://localhost:8080/api");
		assert.equal(resolveApiBaseUrl({ ...disabled, configuredValue: "https://gateway.example.com/api/" }), "https://gateway.example.com/api");
	}
});

test("invalid HTTP environment flags fail without falling back to JSON or the official host", () => {
	for (const allowHttpEnvironmentValue of ["", " ", "yes", "no", "on", "off", "2", "null"]) {
		for (const configuredValue of [undefined, "http://gateway.example.com", "https://gateway.example.com"]) {
			assert.throws(() => resolveApiBaseUrl({ ...baseUrlOptions, configuredValue, allowHttp: true, allowHttpEnvironmentValue }),
				/^Error: BRAVE_ALLOW_HTTP must be true, false, 1, or 0$/);
		}
	}
});

test("HTTP environment flags use the multiword and PI-prefixed provider names", () => {
	for (const [stem, environmentKey, allowHttpEnvironmentKey, bareKey] of [
		["jinaSearch", "JINA_SEARCH_BASE_URL", "JINA_SEARCH_ALLOW_HTTP"],
		["mistralSearch", "MISTRAL_SEARCH_BASE_URL", "MISTRAL_SEARCH_ALLOW_HTTP"],
		["ollama", "PI_OLLAMA_BASE_URL", "PI_OLLAMA_ALLOW_HTTP", "OLLAMA_ALLOW_HTTP"],
		["deepseek", "PI_DEEPSEEK_BASE_URL", "PI_DEEPSEEK_ALLOW_HTTP", "DEEPSEEK_ALLOW_HTTP"],
	]) {
		const keys = [environmentKey, allowHttpEnvironmentKey, bareKey].filter(Boolean);
		const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
		try {
			for (const key of keys) delete process.env[key];
			if (bareKey) process.env[bareKey] = "true";
			const resolve = allowHttp => resolveProviderApiUrl(stem, "https://official.example.com/search", "http://client-gateway/api/", allowHttp);
			assert.throws(() => resolve(false), /must be an absolute HTTPS URL/);
			process.env[allowHttpEnvironmentKey] = "1";
			assert.equal(resolve(false), "http://client-gateway/api/search");
			process.env[allowHttpEnvironmentKey] = "0";
			assert.throws(() => resolve(true), /must be an absolute HTTPS URL/);
			process.env[allowHttpEnvironmentKey] = "invalid";
			assert.throws(() => resolve(true), new RegExp(allowHttpEnvironmentKey + " must be true, false, 1, or 0"));
		} finally {
			for (const key of keys) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
		}
	}
});

test("HTTP opt-ins retain URL validation for both config and environment overrides", () => {
	const options = { ...baseUrlOptions, allowHttp: true };
	for (const value of ["", " ", "not-a-url", "/api", "ftp://gateway.example.com", "http://", "http://user:secret@gateway.example.com/api", "http://gateway.example.com/api?debug=true", "http://gateway.example.com/api#fragment"]) {
		assert.throws(() => resolveApiBaseUrl({ ...options, configuredValue: value }), /braveBaseUrl/);
		assert.throws(() => resolveApiBaseUrl({ ...options, configuredValue: "https://gateway.example.com", environmentValue: value }), /BRAVE_BASE_URL/);
	}
	for (const configuredValue of [null, true, 1, {}, []]) {
		assert.throws(() => resolveApiBaseUrl({ ...options, configuredValue }), /braveBaseUrl/);
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
