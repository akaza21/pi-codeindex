import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");

const temp = mkdtempSync(join(tmpdir(), "pi-codeindex-package-"));
const runNpm = (args, cwd) =>
	execFileSync(process.execPath, [npmCli, ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});

try {
	const [packed] = JSON.parse(
		runNpm(["pack", "--ignore-scripts", "--pack-destination", temp, "--json"], process.cwd()),
	);
	if (!packed?.filename) throw new Error("npm pack did not produce a tarball");

	const project = join(temp, "consumer");
	const sample = join(project, "sample");
	mkdirSync(sample, { recursive: true });
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "pi-codeindex-smoke", private: true, scripts: { codeindex: "codeindex" } }, null, 2),
	);
	writeFileSync(join(sample, "math.js"), "export function add(a, b) { return a + b; }\n");
	writeFileSync(
		join(sample, "app.js"),
		'import { add } from "./math.js"; export function run() { return add(1, 2); }\n',
	);

	runNpm(["install", "--no-audit", "--no-fund", join(temp, packed.filename)], project);
	const help = runNpm(["run", "--silent", "codeindex", "--", "--help"], project);
	const version = runNpm(["run", "--silent", "codeindex", "--", "--version"], project);
	const sync = runNpm(["run", "--silent", "codeindex", "--", "sync", "sample"], project);
	const search = runNpm(["run", "--silent", "codeindex", "--", "search", "add", "sample"], project);
	const callers = runNpm(["run", "--silent", "codeindex", "--", "callers", "add", "sample"], project);

	if (!help.includes("Usage:")) throw new Error("packed CLI help output was not recognized");
	if (version.trim() !== packed.version) throw new Error("packed CLI version did not match its manifest");
	if (!/^synced .+:/m.test(sync)) throw new Error("packed CLI sync did not complete");
	if (!search.includes("function add")) throw new Error("packed CLI search did not find the sample symbol");
	if (!callers.includes("run → add")) throw new Error("packed CLI callers did not find the sample call edge");

	console.log("packed CLI smoke test OK");
} finally {
	rmSync(temp, { recursive: true, force: true });
}
