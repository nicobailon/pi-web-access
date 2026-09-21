import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";

import initializeExtension from "../index.ts";

const indexUrl = new URL("../index.ts", import.meta.url).href;
const indexSrc = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const readmeSrc = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function runRegistration(config) {
	return runRegistrationWithConfig(JSON.stringify(config) + "\n");
}

function runRegistrationWithConfig(configText) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-access-tool-names-"));
	writeFileSync(join(root, "web-search.json"), configText, "utf8");
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: `
			const { default: initializeExtension } = await import(${JSON.stringify(indexUrl)});
			const tools = [];
			const commands = [];
			let active = [];
			initializeExtension({
				registerTool(tool) { tools.push({ name: tool.name, description: tool.description, promptSnippet: tool.promptSnippet, parameters: tool.parameters }); active.push(tool.name); },
				registerCommand(name) { commands.push(name); },
				registerShortcut() {},
				on() {},
				getAllTools() { return tools; },
				getActiveTools() { return active; },
				setActiveTools(names) { active = [...names]; },
			});
			console.log(JSON.stringify({ tools, commands }));
		`,
		encoding: "utf8",
		env: { ...process.env, PI_CODING_AGENT_DIR: root, XDG_CONFIG_HOME: "", HOME: join(root, "home"), USERPROFILE: join(root, "home") },
	});
}

function registered(config) {
	const child = runRegistration(config);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout);
}

function registeredToolNames(config) {
	return registered(config).tools.map(tool => tool.name);
}

function registeredTool(config, name) {
	return registered(config).tools.find(tool => tool.name === name);
}

function registeredCommandNames(config) {
	return registered(config).commands;
}

function registrationError(config) {
	const child = runRegistration(config);
	assert.notEqual(child.status, 0, child.stdout);
	return child.stderr;
}

test("malformed config falls back during extension registration", () => {
	const child = runRegistrationWithConfig("{");
	assert.equal(child.status, 0, child.stderr);
	const registered = JSON.parse(child.stdout);
	assert.deepEqual(registered.tools.map(tool => tool.name), ["web_search", "source_check", "fetch_content", "get_search_content", "web_enable"]);
});

test("default public execution tool definitions retain their compatibility hashes", () => {
	const expected = {
		web_search: "86a2703f9ca905c7b84f758a986e32b03458939de50d24d0026d27c588c6f27e",
		source_check: "be86e565fd8329f134ad28147ba4b7ad22dc1123eb0f631beec91a7b3a5490a3",
		fetch_content: "0082465bae0f184988fd37fe152cad9c7a236e410747ba6770013895a28978d4",
		get_search_content: "23af3967338f4c7da86b692f62580616a93123b1184ab4683f51f84ca4a8ccaf",
	};
	const tools = registered({}).tools.filter(tool => tool.name !== "web_enable");
	assert.deepEqual(Object.fromEntries(tools.map(({ name, description, parameters }) => [
		name,
		createHash("sha256").update(JSON.stringify({ name, description, parameters })).digest("hex"),
	])), expected);
});

test("search tools constrain numResults to integer values from 1 through 20", () => {
	for (const name of ["web_search", "source_check"]) {
		const schema = registeredTool({}, name).parameters.properties.numResults;
		assert.equal(schema.type, "integer");
		assert.equal(schema.minimum, 1);
		assert.equal(schema.maximum, 20);
		for (const value of [0, -1, 1.5, 21, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(Value.Check(schema, value), false, `${name} accepts ${value}`);
		}
		for (const value of [1, 5, 20]) {
			assert.equal(Value.Check(schema, value), true, `${name} rejects ${value}`);
		}
	}
});

test("tool registration gates support legacy and per-tool config", () => {
	assert.deepEqual(registeredToolNames({ webSearch: { enabled: false } }), ["fetch_content", "get_search_content", "web_enable"]);
	assert.deepEqual(registeredToolNames({
		webSearch: { enabled: false },
		tools: { webSearch: { enabled: true }, sourceCheck: { enabled: true }, fetchContent: { enabled: false } },
	}), ["web_search", "source_check", "get_search_content", "web_enable"]);
	assert.deepEqual(registeredToolNames({
		tools: { sourceCheck: { enabled: false }, getSearchContent: { enabled: false } },
	}), ["web_search", "fetch_content", "web_enable"]);
});

test("command registration gates default to enabled", () => {
	assert.deepEqual(registeredCommandNames({}), ["websearch", "curator", "google-account", "search"]);
	assert.deepEqual(registeredCommandNames({
		commands: { websearch: { enabled: false }, search: { enabled: false } },
	}), ["curator", "google-account"]);
});

test("fetch_content schema exposes auth profile opt-in", () => {
	const schema = registeredTool({}, "fetch_content").parameters.properties.auth;
	assert.ok(schema);
	assert.deepEqual(schema.anyOf.map(option => option.type), ["string", "boolean"]);
});

test("registered tools do not advertise disabled get_search_content", () => {
	const fetchTool = registeredTool({ tools: { getSearchContent: { enabled: false } } }, "fetch_content");
	assert.ok(fetchTool);
	assert.doesNotMatch(fetchTool.description, /get_search_content/);
	assert.match(fetchTool.description, /retrieval tool is not registered/);
});

test("web activity shortcut renders through the supported string-array API", async () => {
	const shortcuts = [];
	initializeExtension({
		registerTool() {},
		registerCommand() {},
		registerShortcut(name, shortcut) { shortcuts.push({ name, shortcut }); },
		on() {},
	});

	const activityShortcut = shortcuts.find(({ shortcut }) => shortcut.description === "Toggle web search activity");
	assert.ok(activityShortcut, "activity shortcut was not registered");
	const widgets = [];
	const ctx = {
		ui: {
			theme: { fg: (_color, text) => text },
			setWidget(key, content) { widgets.push({ key, content }); },
		},
	};

	await activityShortcut.shortcut.handler(ctx);
	assert.equal(widgets[0].key, "web-activity");
	assert.ok(Array.isArray(widgets[0].content), "activity widget content must be a string array");
	assert.ok(widgets[0].content.length > 0);

	await activityShortcut.shortcut.handler(ctx);
});

test("tool names can be configured without changing defaults", () => {
	assert.deepEqual(registeredToolNames({}), ["web_search", "source_check", "fetch_content", "get_search_content", "web_enable"]);
	assert.deepEqual(registeredToolNames({
		toolNames: {
			webSearch: "research_web",
			sourceCheck: "verify_sources",
			fetchContent: "grab_content",
			getSearchContent: "open_content",
		},
	}), ["research_web", "verify_sources", "grab_content", "open_content", "web_enable"]);
});

test("tool name config rejects invalid, duplicate, and reserved loader names", () => {
	assert.match(registrationError({ toolNames: { webSearch: "1bad" } }), /toolNames\.webSearch/);
	assert.match(registrationError({ toolNames: { webSearch: "same_name", fetchContent: "same_name" } }), /duplicates/);
	assert.match(registrationError({ toolNames: { webSearch: "web_enable" } }), /web_enable.*reserved/i);
});

test("webSearch.enabled false registers only fetch tools and ignores disabled-name duplicates", () => {
	assert.deepEqual(registeredToolNames({
		webSearch: { enabled: false },
		toolNames: {
			webSearch: "content_only",
			sourceCheck: "content_only",
			fetchContent: "grab_content",
			getSearchContent: "open_content",
		},
	}), ["grab_content", "open_content", "web_enable"]);
	assert.match(registrationError({
		webSearch: { enabled: false },
		toolNames: { fetchContent: "same_name", getSearchContent: "same_name" },
	}), /duplicates/);
});

test("README documents registration gates and toolNames", () => {
	assert.match(readmeSrc, /"tools": \{/);
	assert.match(readmeSrc, /"commands": \{/);
	assert.match(readmeSrc, /Pi restart is required for tool and command registration changes/);
	assert.match(readmeSrc, /`toolNames` can opt into alternate public tool names/);
});
