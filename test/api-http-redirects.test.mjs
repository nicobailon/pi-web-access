import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchWithCredentialRedirects } from "../utils.ts";
import { fetchRemoteUrl } from "../ssrf-protection.ts";

for (const status of [301, 302, 303, 307, 308]) {
	test(`API HTTP policy refuses a ${status} downgrade before sending a second request`, async (t) => {
		const original = globalThis.fetch;
		t.after(() => { globalThis.fetch = original; });
		let calls = 0;
		globalThis.fetch = async () => {
			calls++;
			return new Response(null, { status, headers: { location: "http://gateway.example.com/collect" } });
		};
		for (const allowHttp of [undefined, false]) {
			calls = 0;
			await assert.rejects(() => fetchWithCredentialRedirects("https://gateway.example.com/search", {
				method: "POST", body: "private-query", headers: { "X-API-KEY": "synthetic-key" },
			}, ["X-API-KEY"], [], allowHttp), /HTTP API requests require/);
			assert.equal(calls, 1);
		}
	});
}

test("API HTTP opt-in covers HTTPS-to-HTTP redirects and keeps cross-origin credentials stripped", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), key: new Headers(init.headers).get("X-API-KEY"), body: init.body });
		const targets = ["https://other.example.com/step", "http://other.example.com/final"];
		return calls.length <= targets.length
			? new Response(null, { status: 307, headers: { location: targets[calls.length - 1] } })
			: Response.json({ ok: true });
	};
	await fetchWithCredentialRedirects("https://gateway.example.com/search", {
		method: "POST", body: "private-query", headers: { "X-API-KEY": "synthetic-key" },
	}, ["X-API-KEY"], [], true);
	assert.deepEqual(calls.map(call => call.key), ["synthetic-key", null, null]);
	assert.ok(calls.every(call => call.body === "private-query"));
	assert.equal(new URL(calls.at(-1).url).protocol, "http:");
});

test("API HTTP policy also checks later hops after an HTTPS redirect", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	let calls = 0;
	globalThis.fetch = async () => new Response(null, { status: 308, headers: {
		location: ++calls === 1 ? "https://other.example.com/step" : "http://other.example.com/final",
	} });
	await assert.rejects(() => fetchWithCredentialRedirects("https://gateway.example.com/search", {
		method: "POST", body: "private-query",
	}, [], [], false), /HTTP API requests require/);
	assert.equal(calls, 2);
});

test("implicit loopback HTTP stays on the configured origin", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	for (const target of ["http://127.0.0.1:8081/other", "http://localhost:8080/other", "http://remote.example.com/other"]) {
		let calls = 0;
		globalThis.fetch = async () => new Response(null, { status: 307, headers: {
			location: ++calls === 1 ? "/same-origin" : target,
		} });
		await assert.rejects(() => fetchWithCredentialRedirects("http://127.0.0.1:8080/api", {}, []), /HTTP API requests require/);
		assert.equal(calls, 2);
	}
});

test("explicit false refuses an initial remote HTTP API URL before any request", async (t) => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	globalThis.fetch = async () => assert.fail("HTTP request must not be sent");
	await assert.rejects(() => fetchWithCredentialRedirects("http://gateway.example.com/api", {}, [], [], false), /HTTP API requests require/);
});

for (const apiAllowHttp of [false, true]) {
	test(`SSRF-guarded API transport enforces its HTTP policy (${apiAllowHttp}) before redirect DNS`, async () => {
		const calls = [], lookups = [];
		const operation = fetchRemoteUrl("https://gateway.example.com/api", { method: "POST", body: "private-query" }, {
			apiAllowHttp,
			lookup: async host => { lookups.push(host); return [{ address: "93.184.216.34", family: 4 }]; },
			fetch: async url => {
				calls.push(String(url));
				return calls.length === 1
					? new Response(null, { status: 307, headers: { location: "http://other.example.com/collect" } })
					: Response.json({ ok: true });
			},
		});
		if (apiAllowHttp) {
			await operation;
			assert.equal(calls.length, 2);
			assert.deepEqual(lookups, ["gateway.example.com", "other.example.com"]);
		} else {
			await assert.rejects(operation, /HTTP API requests require/);
			assert.equal(calls.length, 1);
			assert.deepEqual(lookups, ["gateway.example.com"]);
		}
	});
}
