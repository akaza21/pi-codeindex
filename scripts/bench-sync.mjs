#!/usr/bin/env node
/**
 * Measures fresh-process full sync and single-file incremental sync in a temporary repository copy.
 * Reports wall time, peak process RSS, and SQLite database size.
 *
 * Usage: node scripts/bench-sync.mjs <repoRoot> [maxFiles] [--typed]
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// node:sqlite emits an ExperimentalWarning on every run; drop just that one for clean stderr.
// Must be installed before the engine (and its node:sqlite import) loads, so import it dynamically.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	const message = warning instanceof Error ? warning.message : String(warning);
	if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
	return emitWarning(warning, ...rest);
};
const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[2] === "--worker") {
	await runWorker(
		process.argv[3],
		process.argv[4],
		process.argv[5],
		process.argv[6],
		process.argv[7],
		process.argv[8],
	);
	process.exit(0);
}

const rawArgs = process.argv.slice(2);
const typed = rawArgs.includes("--typed");
const positional = rawArgs.filter((arg) => arg !== "--typed");
const [repoRoot, maxFilesArg, ...unexpected] = positional;
if (!repoRoot) {
	console.error("usage: bench-sync.mjs <repoRoot> [maxFiles] [--typed]");
	process.exit(2);
}
if (unexpected.length > 0) {
	console.error(`unexpected argument "${unexpected[0]}"`);
	process.exit(2);
}
const maxFiles = maxFilesArg === undefined ? undefined : Number(maxFilesArg);
if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) {
	console.error(`maxFiles must be a positive integer, got "${maxFilesArg}"`);
	process.exit(2);
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const gitCommit = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
const cpu = cpus()[0]?.model ?? "unknown CPU";

/** Run a function and report the process RSS high-water mark. */
async function timed(fn) {
	const start = performance.now();
	const result = await fn();
	const ms = performance.now() - start;
	// Node reports maxRSS in KiB on supported platforms.
	const peakRss = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
	return { ms, peakRss, result };
}

async function runWorker(phase, repo, dbPath, target, maxFilesValue, typedValue) {
	const { openIndex } = await import("../src/engine/index.ts");
	const workerMaxFiles = maxFilesValue ? Number(maxFilesValue) : undefined;
	const { store, indexer } = openIndex({
		root: repo,
		dbPath,
		typed: typedValue === "typed",
		...(workerMaxFiles === undefined ? {} : { maxFiles: workerMaxFiles }),
	});
	try {
		const measured = await timed(() => (phase === "full" ? indexer.sync() : indexer.sync({ only: [target] })));
		const status = store.status();
		console.log(
			JSON.stringify({
				ms: measured.ms,
				peakRss: measured.peakRss,
				status,
				sync: measured.result,
				target: store
					.allFiles()
					.map((file) => file.path)
					.sort()[0],
			}),
		);
	} finally {
		store.close();
	}
}

function runPhase(phase, repo, dbPath, target, fileCap, typedMode) {
	const args = [
		scriptPath,
		"--worker",
		phase,
		repo,
		dbPath,
		target ?? "",
		fileCap?.toString() ?? "",
		typedMode ? "typed" : "",
	];
	const child = spawnSync(process.execPath, args, {
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
	});
	if (child.status !== 0) {
		throw new Error(`benchmark ${phase} worker failed:\n${child.stderr || child.stdout}`);
	}
	const line = child.stdout.trim().split(/\r?\n/).at(-1);
	if (!line) throw new Error(`benchmark ${phase} worker returned no result`);
	return JSON.parse(line);
}

// Exclude Git metadata from the temporary repository copy.
const work = mkdtempSync(join(tmpdir(), "bench-sync-"));
const repo = join(work, "repo");
try {
	cpSync(repoRoot, repo, {
		recursive: true,
		filter: (src) => !src.split(sep).some((part) => part === ".git" || part === ".codeindex"),
	});
	const dbPath = join(repo, ".codeindex", "index.db");
	mkdirSync(join(repo, ".codeindex"), { recursive: true });

	const full = runPhase("full", repo, dbPath, undefined, maxFiles, typed);
	const dbSize = statSync(dbPath).size;
	const target = full.target;
	if (!target) throw new Error("no indexed files — nothing to benchmark");

	// A newline changes the content without assuming the target language's comment syntax.
	appendFileSync(join(repo, target), "\n");
	const incremental = runPhase("incremental", repo, dbPath, target, maxFiles, typed);
	const dbSizeAfter = statSync(dbPath).size;

	console.log(`repo:        ${repoRoot}`);
	if (gitCommit) console.log(`revision:    ${gitCommit}`);
	console.log(`runtime:     Node ${process.version}, ${platform()} ${release()}`);
	console.log(`machine:     ${cpu}, ${mb(totalmem())} RAM`);
	console.log(`resolver:    ${typed ? "typed TypeScript + syntactic fallback" : "compiler-free"}`);
	console.log(
		`indexed:     ${full.status.files} files, ${full.status.symbols} symbols, ${full.status.occurrences} occurrences`,
	);
	if (full.sync.truncated) console.log(`file cap:    ${maxFiles} (reached)`);
	console.log("");
	console.log("phase                         wall        peak RSS");
	console.log(`fresh-process full sync      ${full.ms.toFixed(0).padStart(7)}ms   ${mb(full.peakRss).padStart(9)}`);
	console.log(
		`fresh-process incremental    ${incremental.ms.toFixed(0).padStart(7)}ms   ${mb(incremental.peakRss).padStart(9)}`,
	);
	console.log("");
	console.log(`index.db:    ${mb(dbSize)} (after incremental: ${mb(dbSizeAfter)})`);
	console.log(`edited file: ${target}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
