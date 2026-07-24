#!/usr/bin/env node
// Runs the TypeScript CLI through jiti; the published package ships no compiled dist.
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The engine uses node:sqlite, which emits an ExperimentalWarning on every run. Drop just that one
// (keep every other warning) so a normal CLI run has clean stderr.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	const message = warning instanceof Error ? warning.message : String(warning);
	if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
	return emitWarning(warning, ...rest);
};

const jiti = createJiti(fileURLToPath(import.meta.url));
await jiti.import("./codeindex.ts");
