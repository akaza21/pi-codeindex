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
	const extensionSmoke = `
		import { join } from "node:path";
		import { createJiti } from "jiti";
		const jiti = createJiti(import.meta.url);
		const loaded = await jiti.import("@akaza21/pi-codeindex/src/pi/index.ts");
		const createExtension = loaded.default;
		const tools = new Map();
		const handlers = new Map();
		createExtension({
			registerTool: (tool) => tools.set(tool.name, tool),
			on: (event, handler) => handlers.set(event, handler),
			registerCommand() {},
			registerShortcut() {},
			registerFlag() {},
		});
		if (!tools.has("codeindex_status") || !tools.has("codeindex_sync")) {
			throw new Error("packed pi extension did not register its tools");
		}
		if (!handlers.has("session_start") || !handlers.has("session_shutdown")) {
			throw new Error("packed pi extension did not register its lifecycle");
		}
		const ctx = { cwd: join(process.cwd(), "sample") };
		await handlers.get("session_start")({}, ctx);
		await handlers.get("session_shutdown")({}, ctx);
	`;
	execFileSync(process.execPath, ["--input-type=module", "-e", extensionSmoke], {
		cwd: project,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});

	if (!help.includes("Usage:")) throw new Error("packed CLI help output was not recognized");
	if (version.trim() !== packed.version) throw new Error("packed CLI version did not match its manifest");
	if (!/^synced .+:/m.test(sync)) throw new Error("packed CLI sync did not complete");
	if (!search.includes("function add")) throw new Error("packed CLI search did not find the sample symbol");
	if (!callers.includes("run → add")) throw new Error("packed CLI callers did not find the sample call edge");

	console.log("packed CLI and pi extension smoke test OK");
} finally {
	rmSync(temp, { recursive: true, force: true });
}
