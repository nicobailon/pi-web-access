// Measures fetch_content extract mode (Clairic) against the extraction fixtures with real provider calls.
// Usage: PI_WEB_ACCESS_REAL_SEMANTIC=1 node eval/field-extract.mjs [--repeat 1]
// It uses your Pi credentials for the cloudflare-workers-ai provider (CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID, or Pi's stored login).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { extractPageFields, parseExtractFields } from "../field-extract.ts";

if (process.env.PI_WEB_ACCESS_REAL_SEMANTIC !== "1") {
	console.error("This harness sends the fixture pages to Cloudflare and is billed to your account. Set PI_WEB_ACCESS_REAL_SEMANTIC=1 to run it.");
	process.exit(2);
}
const modelRegistry = new ModelRegistry(await ModelRuntime.create());
const credential = await modelRegistry.getProviderAuth("cloudflare-workers-ai");
if (!credential?.auth.apiKey || !credential.env?.CLOUDFLARE_ACCOUNT_ID) {
	console.error("Cloudflare Workers AI is not set up in Pi; set CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID.");
	process.exit(2);
}
const { values } = parseArgs({ options: { repeat: { type: "string", default: "1" } } });
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");

const fixtureSets = ["calibration", "holdout"].map((name) => ({
	name,
	pages: JSON.parse(readFileSync(new URL(`./fixtures/extract-${name}.json`, import.meta.url), "utf8")),
}));

// Numbers within 0.005; dates by ISO day, datetimes to the minute, times as HH:MM; text trimmed and case-sensitive; lists item by item.
function same(type, got, want) {
	if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && got.every((item, index) => same(type.replace(/^list\.?/, "") || "text", item, want[index]));
	if (/^(number|integer|duration)/.test(type)) return typeof got === "number" && Math.abs(got - want) < 0.005;
	if (type === "datetime") return typeof got === "string" && got.slice(0, 16) === want;
	if (type === "time") return typeof got === "string" && got.slice(0, 5) === want;
	if (type === "date") return typeof got === "string" && got.slice(0, 10) === want;
	return typeof got === "string" && got.trim() === String(want).trim();
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

for (const { name, pages } of fixtureSets) {
	const counts = { correct: 0, correctNull: 0, withheld: 0, wrongExtracted: 0, wrongWithheld: 0, missed: 0, errors: 0 };
	let highestWrong = 0;
	const latency = [];
	const notes = new Set();
	for (let round = 0; round < repeat; round++) {
		for (const page of pages) {
			const specs = parseExtractFields(Object.fromEntries(Object.entries(page.fields).map(([field, { type, instructions }]) => [field, instructions ? `${type}: ${instructions}` : type])));
			const started = performance.now();
			const extraction = await extractPageFields(page.page, specs, { modelRegistry }, undefined, page.referenceDate);
			latency.push(performance.now() - started);
			if ("error" in extraction) {
				counts.errors++;
				notes.add(`${page.id}: error ${extraction.error}`);
				continue;
			}
			for (const [field, { type }] of Object.entries(page.fields)) {
				const want = page.expected[field];
				const result = extraction.fields[field];
				let outcome;
				// A guess for a field that is not on the page is still wrong, even when it is withheld.
				if (want === null) outcome = result.status === "extracted" ? "wrongExtracted" : result.status === "uncertain" ? "wrongWithheld" : "correctNull";
				else if (result.status === "extracted") outcome = same(type, result.value, want) ? "correct" : "wrongExtracted";
				else if (result.status === "uncertain") outcome = same(type, result.guess, want) ? "withheld" : "wrongWithheld";
				else outcome = "missed";
				counts[outcome]++;
				if ((outcome === "wrongExtracted" || outcome === "wrongWithheld") && result.confidence !== undefined) highestWrong = Math.max(highestWrong, result.confidence);
				if (outcome !== "correct" && outcome !== "correctNull") {
					const shown = result.status === "extracted" ? result.value : result.status === "uncertain" ? result.guess : null;
					notes.add(`${page.id}.${field}: ${outcome}, want ${JSON.stringify(want)}, got ${JSON.stringify(shown)}${result.confidence !== undefined ? ` at ${result.confidence.toFixed(3)}` : ""}${result.notFound ? " (not found on the page)" : ""}`);
				}
			}
		}
	}
	const fields = pages.reduce((total, page) => total + Object.keys(page.fields).length, 0);
	latency.sort((a, b) => a - b);
	console.log(`\nclairic · ${name} (${pages.length} pages, ${fields} fields × ${repeat})`);
	console.log(`  correct ${counts.correct}  correct-null ${counts.correctNull}  withheld ${counts.withheld}  wrong-extracted ${counts.wrongExtracted}  wrong-withheld ${counts.wrongWithheld}  missed ${counts.missed}  errors ${counts.errors}`);
	console.log(`  highest wrong confidence ${highestWrong.toFixed(3)}`);
	console.log(`  latency p50 ${Math.round(percentile(latency, 0.5))} ms, p95 ${Math.round(percentile(latency, 0.95))} ms`);
	for (const note of notes) console.log(`  ${note}`);
}
