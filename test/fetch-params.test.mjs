import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeFetchContentParams } from "../fetch-params.ts";

test("fetch_content params fall back to url when urls is an empty array", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/docs",
		urls: [],
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/docs"]);
});

test("fetch_content params keep non-empty urls precedence over url", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/fallback",
		urls: ["https://example.com/primary"],
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/primary"]);
});

test("fetch_content params ignore blank optional strings and blank urls", () => {
	const normalized = normalizeFetchContentParams({
		url: "  https://example.com/one  ",
		urls: ["", " https://example.com/two ", "https://example.com/one"],
		prompt: "",
		timestamp: "   ",
		model: " gemini-3-flash-preview ",
	});

	assert.deepEqual(normalized.urlList, ["https://example.com/two", "https://example.com/one"]);
	assert.equal(normalized.options.prompt, undefined);
	assert.equal(normalized.options.timestamp, undefined);
	assert.equal(normalized.options.model, "gemini-3-flash-preview");
	assert.equal(normalizeFetchContentParams({ model: "" }).options.model, undefined);
});

test("fetch_content params preserve forceClone only for boolean values", () => {
	assert.equal(normalizeFetchContentParams({ forceClone: true }).options.forceClone, true);
	assert.equal(normalizeFetchContentParams({ forceClone: false }).options.forceClone, false);
	assert.equal(normalizeFetchContentParams({ forceClone: "true" }).options.forceClone, undefined);
});

test("fetch_content params drop non-positive and non-integer frames", () => {
	assert.equal(normalizeFetchContentParams({ frames: 0, timestamp: "1:23" }).options.frames, undefined);
	assert.equal(normalizeFetchContentParams({ frames: -1, timestamp: "1:23" }).options.frames, undefined);
	assert.equal(normalizeFetchContentParams({ frames: 1.5, timestamp: "1:23" }).options.frames, undefined);
	assert.equal(normalizeFetchContentParams({ frames: "1", timestamp: "1:23" }).options.frames, undefined);
});

test("fetch_content params ignore bridge-filled default frames for ordinary page fetches", () => {
	const normalized = normalizeFetchContentParams({
		url: "https://example.com/docs",
		urls: [],
		frames: 1,
		prompt: "Summarize this page",
		timestamp: "",
	});

	assert.equal(normalized.options.frames, undefined);
});

test("fetch_content params preserve explicit video frame options", () => {
	assert.equal(normalizeFetchContentParams({ url: "https://youtu.be/demo", frames: 1, timestamp: "1:23" }).options.frames, 1);
	assert.equal(normalizeFetchContentParams({ url: "https://youtu.be/demo", frames: 2 }).options.frames, 2);
});
