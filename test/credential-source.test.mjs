import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CredentialResolutionError,
	hasCredentialSource,
	resolveCredential,
} from "../credential-source.ts";

const fake = value => async () => ({ stdout: value });

function options(configuredValue, environmentValue) {
	return { provider: "Synthetic", configuredValue, environmentValue };
}

test("literal and legacy environment credentials preserve existing precedence", async () => {
	assert.equal(await resolveCredential(options("literal-value", "environment-value")), "environment-value");
	assert.equal(await resolveCredential(options("literal-value", undefined)), "literal-value");
	assert.equal(await resolveCredential(options(undefined, "environment-value")), "environment-value");
	assert.equal(await resolveCredential(options(undefined, undefined)), null);
});

test("explicit environment sources use only the named variable", async () => {
	assert.equal(await resolveCredential({
		...options("${SCOPED_SYNTHETIC_KEY}", "stale-legacy-value"),
		environment: { SCOPED_SYNTHETIC_KEY: "scoped-value" },
	}), "scoped-value");
	await assert.rejects(
		resolveCredential({
			...options("$SCOPED_SYNTHETIC_KEY", "stale-legacy-value"),
			environment: {},
		}),
		err => err instanceof CredentialResolutionError && err.category === "environment-empty",
	);
});

test("command sources override stale values, remain lazy, and rotate per resolution", async () => {
	let calls = 0;
	const runCommand = async (command, runOptions) => {
		calls += 1;
		assert.equal(command, "/trusted/read synthetic");
		assert.deepEqual(runOptions.environment, {
			HOME: "/synthetic/home",
			PATH: "/usr/bin:/bin",
			OP_SERVICE_ACCOUNT_TOKEN: "synthetic-service-account-token",
			OP_SESSION_my: "synthetic-password-manager-session",
		});
		return { stdout: calls === 1 ? "first-value\n" : "second-value\n" };
	};
	const commandOptions = {
		...options("!/trusted/read synthetic", "stale-environment-value"),
		runCommand,
		environment: {
			HOME: "/synthetic/home",
			PATH: "/usr/bin:/bin",
			EXA_API_KEY: "stale-provider-key-must-not-reach-command",
			OP_SESSION_my: "synthetic-password-manager-session",
			OP_SERVICE_ACCOUNT_TOKEN: "synthetic-service-account-token",
			NODE_OPTIONS: "--require=untrusted.js",
		},
	};

	assert.equal(hasCredentialSource(commandOptions), true);
	assert.equal(calls, 0);
	assert.equal(await resolveCredential(commandOptions), "first-value");
	assert.equal(await resolveCredential(commandOptions), "second-value");
	assert.equal(calls, 2);
});

test("service-account tokens remain absent unless inherited by Pi", async () => {
	let childEnvironment;
	await resolveCredential({
		...options("!/trusted/read synthetic", undefined),
		runCommand: async (_command, runOptions) => {
			childEnvironment = runOptions.environment;
			return { stdout: "value" };
		},
		environment: { HOME: "/synthetic/home" },
	});
	assert.equal(childEnvironment.OP_SERVICE_ACCOUNT_TOKEN, undefined);
});

test("a real resolver child can authenticate with an inherited service-account token", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-access-fake-op-"));
	const fakeOp = join(directory, "fake-op.mjs");
	await writeFile(fakeOp, `
		if (process.argv.slice(2).join(" ") !== "read op://Synthetic/Search/credential") process.exit(2);
		if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== "synthetic-service-account-token") process.exit(3);
		if (process.env.UNRELATED_SECRET !== undefined) process.exit(4);
		process.stdout.write("synthetic-provider-key");
	`, "utf8");
	const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(fakeOp)} read ${JSON.stringify("op://Synthetic/Search/credential")}`;
	assert.equal(await resolveCredential({
		...options(`!${command}`, undefined),
		environment: {
			HOME: directory,
			PATH: process.env.PATH,
			OP_SERVICE_ACCOUNT_TOKEN: "synthetic-service-account-token",
			UNRELATED_SECRET: "must-not-reach-command",
		},
	}), "synthetic-provider-key");
});

test("command output must be one non-empty bounded value", async () => {
	for (const [stdout, category] of [
		["", "command-empty"],
		["one\ntwo\n", "command-invalid-output"],
		["x".repeat(16_385), "command-output-too-large"],
	]) {
		await assert.rejects(
			resolveCredential({ ...options("!ignored", undefined), runCommand: fake(stdout) }),
			err => err instanceof CredentialResolutionError && err.category === category,
		);
	}
});

test("command failures are categorized and redact command output", async () => {
	const secret = "SYNTHETIC_SECRET_MUST_NOT_ESCAPE";
	for (const [failure, category] of [
		[Object.assign(new Error(`spawn failed ${secret}`), { code: "ENOENT", stderr: secret }), "command-failed"],
		[Object.assign(new Error(`timed out ${secret}`), { killed: true, stderr: secret }), "command-timeout"],
		[Object.assign(new Error(`too large ${secret}`), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: secret }), "command-output-too-large"],
	]) {
		await assert.rejects(
			resolveCredential({
				...options("!/trusted/read synthetic", "stale-value"),
				runCommand: async () => { throw failure; },
			}),
			err => {
				assert.equal(err instanceof CredentialResolutionError, true);
				assert.equal(err.category, category);
				assert.equal(err.message.includes(secret), false);
				assert.equal(err.message.includes("/trusted/read"), false);
				return true;
			},
		);
	}
});

test("escaped source prefixes remain literal and override legacy environment values", async () => {
	assert.equal(await resolveCredential(options("$$OPENAI_API_KEY", "legacy-value")), "$OPENAI_API_KEY");
	assert.equal(await resolveCredential(options("$!literal-command", "legacy-value")), "!literal-command");
	assert.equal(hasCredentialSource(options("$$OPENAI_API_KEY", undefined)), true);
});

test("malformed explicit sources fail closed instead of becoming literals", async () => {
	for (const source of ["!", "$BAD-NAME", "${UNCLOSED"]) {
		await assert.rejects(
			resolveCredential(options(source, "stale-value")),
			err => err instanceof CredentialResolutionError && err.category === "invalid-source",
		);
	}
});
