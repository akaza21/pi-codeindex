#!/usr/bin/env node
/**
 * Architecture boundary guard: nothing under `src/engine/**` may depend on pi. The engine is pure
 * and host-agnostic; only `src/pi/**` adapts it to the pi runtime, which keeps the engine
 * reusable and testable. Catches every import spelling (static, side-effect, dynamic, require).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const engineRoot = fileURLToPath(new URL("../src/engine", import.meta.url));
// A pi-runtime module that the engine must never reach.
const FORBIDDEN_MODULE = /(?:@earendil-works\/|\.\.\/pi\/)/;
// The module specifier in any import form: `from "x"`, side-effect `import "x"`, dynamic
// `import("x")`, or `require("x")`.
const IMPORT_SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

const violations = [];
for (const file of walk(engineRoot)) {
	const source = readFileSync(file, "utf8");
	source.split("\n").forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comments mentioning pi
		const match = trimmed.match(IMPORT_SPECIFIER);
		if (match && FORBIDDEN_MODULE.test(match[1])) {
			violations.push(`${file}:${index + 1}: ${line.trim()}`);
		}
	});
}

if (violations.length > 0) {
	console.error("Engine boundary violations (src/engine must not import pi):");
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}
console.log("boundary OK: src/engine has no pi imports");
