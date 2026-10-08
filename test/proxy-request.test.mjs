import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { installGlobalProxyFetch, runWithProxy } from "../utils.ts";

const nativeFetch = globalThis.fetch;
const target = "http://request.example.test/resource";
const curlSkip = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0 ? false : "requires curl on PATH";

async function withProxy(t, respond = (_request, response) => response.end("ok")) {
	const calls = [];
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		calls.push({ url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
		respond(request, response);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const previousNoProxy = process.env.NO_PROXY;
	const previousNoProxyLower = process.env.no_proxy;
	process.env.NO_PROXY = "";
	process.env.no_proxy = "";
	globalThis.fetch = nativeFetch;
	installGlobalProxyFetch();
	t.after(async () => {
		globalThis.fetch = nativeFetch;
		if (previousNoProxy === undefined) delete process.env.NO_PROXY;
		else process.env.NO_PROXY = previousNoProxy;
		if (previousNoProxyLower === undefined) delete process.env.no_proxy;
		else process.env.no_proxy = previousNoProxyLower;
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	const proxy = `http://127.0.0.1:${server.address().port}`;
	return { calls, fetch: (input, init) => runWithProxy(proxy, () => fetch(input, init)) };
}

test("proxied Request retains its method, headers and JSON body", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const request = new Request(target, {
		method: "POST",
		headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
		body: JSON.stringify({ message: "hello" }),
	});
	assert.equal(await (await proxy.fetch(request)).text(), "ok");
	assert.equal(proxy.calls.length, 1);
	assert.equal(proxy.calls[0].url, target);
	assert.equal(proxy.calls[0].method, "POST");
	assert.equal(proxy.calls[0].headers.authorization, "Bearer test");
	assert.equal(proxy.calls[0].headers["content-type"], "application/json");
	assert.equal(proxy.calls[0].body.toString(), '{"message":"hello"}');
	assert.equal(request.bodyUsed, true);
});

test("proxied HEAD uses HEAD on the wire and returns no body", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (_request, response) => {
		response.setHeader("Content-Length", "4");
		response.setHeader("X-Test", "head");
		response.end("body");
	});
	for (const [input, init] of [[new Request(target, { method: "HEAD" }), undefined], [target, { method: "HEAD" }]]) {
		const response = await proxy.fetch(input, init);
		assert.equal(proxy.calls.at(-1).method, "HEAD");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-test"), "head");
		assert.equal(response.body, null);
		assert.equal(await response.text(), "");
	}
	assert.deepEqual(proxy.calls.map(call => call.method), ["HEAD", "HEAD"]);
});

test("proxied Request applies init overrides and replaces headers", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const request = new Request(target, {
		method: "POST", headers: { "X-Original": "old" }, body: "original",
	});
	await proxy.fetch(request, {
		method: "PUT", headers: { "X-Override": "new" }, body: new Uint8Array([0, 255, 13, 10]),
	});
	assert.equal(proxy.calls[0].method, "PUT");
	assert.equal(proxy.calls[0].headers["x-original"], undefined);
	assert.equal(proxy.calls[0].headers["x-override"], "new");
	assert.deepEqual(proxy.calls[0].body, Buffer.from([0, 255, 13, 10]));
});

test("proxied Request inherits body and content type when init only overrides method", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	await proxy.fetch(new Request(target, {
		method: "POST", body: new URLSearchParams({ query: "a b" }),
	}), { method: "PATCH" });
	assert.equal(proxy.calls[0].method, "PATCH");
	assert.equal(proxy.calls[0].headers["content-type"], "application/x-www-form-urlencoded;charset=UTF-8");
	assert.equal(proxy.calls[0].body.toString(), "query=a+b");
});

test("proxied Request keeps multipart headers and bytes from the same body", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const form = new FormData();
	form.set("message", "hello");
	await proxy.fetch(new Request(target, { method: "POST", body: form }));
	const boundary = proxy.calls[0].headers["content-type"].split("boundary=")[1];
	assert.ok(boundary);
	assert.ok(proxy.calls[0].body.toString().startsWith(`--${boundary}\r\n`));
	assert.ok(proxy.calls[0].body.toString().includes('name="message"\r\n\r\nhello'));
});

test("proxied Request replays its bytes on 307 and drops its body on 303", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (request, response) => {
		const status = request.url === target ? 307 : request.url.endsWith("/retry") ? 303 : 200;
		response.writeHead(status, { Location: request.url === target ? "/retry" : "/final" });
		response.end("ok");
	});
	await proxy.fetch(new Request(target, { method: "POST", body: "replayed" }));
	assert.deepEqual(proxy.calls.map((call) => [call.method, call.body.toString()]), [
		["POST", "replayed"], ["POST", "replayed"], ["GET", ""],
	]);
	assert.equal(proxy.calls[2].headers["content-type"], undefined);
});

test("proxied Request retains redirect policy and allows init to override it", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t, (_request, response) => {
		response.writeHead(302, { Location: "http://other.example.test/final" });
		response.end();
	});
	const response = await proxy.fetch(new Request(target, { redirect: "manual" }));
	assert.equal(response.status, 302);
	assert.equal(proxy.calls.length, 1);
	await assert.rejects(proxy.fetch(new Request(target, { redirect: "manual" }), { redirect: "error" }), /redirect blocked/);
	assert.equal(proxy.calls.length, 2);
});

test("proxied Request inherits abort signal and supports an override", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(proxy.fetch(new Request(target, { signal: controller.signal })), { name: "AbortError" });
	assert.equal(proxy.calls.length, 0);
	await proxy.fetch(new Request(target, { signal: controller.signal }), { signal: new AbortController().signal });
	assert.equal(proxy.calls.length, 1);
});

test("proxied Request aborts a running curl request", { timeout: 5000, skip: curlSkip }, async (t) => {
	let received;
	const started = new Promise((resolve) => { received = resolve; });
	const proxy = await withProxy(t, () => received());
	const controller = new AbortController();
	const pending = proxy.fetch(new Request(target, { signal: controller.signal }));
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
});

test("proxied Request cancels body buffering when its signal aborts", { timeout: 5000, skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	let cancelled = false;
	let reading;
	const started = new Promise((resolve) => { reading = resolve; });
	const body = new ReadableStream({
		pull() { reading(); },
		cancel() { cancelled = true; },
	});
	const controller = new AbortController();
	const pending = proxy.fetch(new Request(target, { method: "POST", body, duplex: "half", signal: controller.signal }));
	const rejected = assert.rejects(pending, { name: "AbortError" });
	await started;
	controller.abort();
	await rejected;
	assert.equal(cancelled, true);
	assert.equal(proxy.calls.length, 0);
});

test("proxied Request rejects a consumed body before sending a request", { skip: curlSkip }, async (t) => {
	const proxy = await withProxy(t);
	const request = new Request(target, { method: "POST", body: "used" });
	await request.text();
	await assert.rejects(proxy.fetch(request), TypeError);
	assert.equal(proxy.calls.length, 0);
	await proxy.fetch(request, { body: "replacement" });
	assert.equal(proxy.calls[0].body.toString(), "replacement");
});
