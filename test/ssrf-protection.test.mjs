import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchRemoteUrl, validateRemoteUrl } from "../ssrf-protection.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

async function rejectsInternal(url) {
	await assert.rejects(
		validateRemoteUrl(url, { lookup: publicLookup }),
		/internal|Blocked/,
		`${url} should be blocked`,
	);
}

test("validateRemoteUrl blocks localhost, loopback, link-local, private, and metadata targets", async () => {
	await rejectsInternal("http://localhost/");
	await rejectsInternal("http://127.0.0.1/");
	await rejectsInternal("http://10.0.0.1/");
	await rejectsInternal("http://172.16.0.1/");
	await rejectsInternal("http://192.168.1.1/");
	await rejectsInternal("http://169.254.169.254/latest/meta-data/");
	await rejectsInternal("http://0.0.0.0/");
	await rejectsInternal("http://[::1]/");
	await rejectsInternal("http://[fe80::1]/");
	await rejectsInternal("http://[fd00::1]/");
	await rejectsInternal("http://[::ffff:127.0.0.1]/");
});

test("validateRemoteUrl blocks encoded and alternate loopback IPv4 forms", async () => {
	await rejectsInternal("http://2130706433/");
	await rejectsInternal("http://0177.0.0.1/");
	await rejectsInternal("http://0x7f.0.0.1/");
	await rejectsInternal("http://127.1/");
});

test("validateRemoteUrl blocks hostnames that resolve to private addresses", async () => {
	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "192.168.0.2", family: 4 }],
		}),
		/Blocked internal address for example\.test: 192\.168\.0\.2/,
	);

	await assert.rejects(
		validateRemoteUrl("https://example.test/", {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }],
		}),
		/Blocked internal address for example\.test: fd00::1/,
	);
});

test("validateRemoteUrl permits public HTTP and HTTPS targets", async () => {
	assert.equal((await validateRemoteUrl("https://example.com/path", { lookup: publicLookup })).hostname, "example.com");
	assert.equal((await validateRemoteUrl("http://93.184.216.34/")).hostname, "93.184.216.34");
	assert.equal((await validateRemoteUrl("https://[2606:2800:220:1:248:1893:25c8:1946]/")).hostname, "[2606:2800:220:1:248:1893:25c8:1946]");
});

test("fetchRemoteUrl validates redirect targets before following", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		return new Response("", {
			status: 302,
			headers: { location: "http://127.0.0.1/admin" },
		});
	};

	await assert.rejects(
		fetchRemoteUrl("https://example.com/", {}, { lookup: publicLookup, fetch: fetchImpl }),
		/Blocked internal address/,
	);
	assert.deepEqual(requested, ["https://example.com/"]);
});

test("fetchRemoteUrl follows validated public redirects manually", async () => {
	const requested = [];
	const fetchImpl = async (url) => {
		requested.push(url.toString());
		if (requested.length === 1) {
			return new Response("", {
				status: 301,
				headers: { location: "/next" },
			});
		}
		return new Response("ok", { status: 200 });
	};

	const response = await fetchRemoteUrl("https://example.com/start", {}, { lookup: publicLookup, fetch: fetchImpl });
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
	assert.deepEqual(requested, ["https://example.com/start", "https://example.com/next"]);
});
