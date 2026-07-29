import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End-to-end CLI checks run the shipped entry (bin/codeindex.mjs) and assert real stdout/stderr.
function cli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
	const res = spawnSync(process.execPath, ["bin/codeindex.mjs", ...args], { cwd, encoding: "utf8" });
	return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

describe("standalone CLI", () => {
	let dir: string;
	const project = process.cwd();
	const packageVersion = JSON.parse(readFileSync(join(project, "package.json"), "utf8")).version as string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-cli-"));
		writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) { return a + b; }\n");
		writeFileSync(
			join(dir, "app.ts"),
			'import { add } from "./math.ts";\nexport class Calculator { run() { return add(1, 2); } }\n',
		);
		cli(["sync", dir], project);
	});

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("supports conventional help and version flags without opening an index", () => {
		for (const flag of ["-h", "--help"]) {
			const result = cli([flag], project);
			expect(result).toMatchObject({ status: 0, stderr: "" });
			expect(result.stdout).toContain("Usage:");
		}
		for (const flag of ["-v", "--version"]) {
			const result = cli([flag], project);
			expect(result).toMatchObject({ status: 0, stderr: "", stdout: `${packageVersion}\n` });
		}
	});

	it("a normal run emits no ExperimentalWarning on stderr", () => {
		const { stderr } = cli(["status", dir], project);
		expect(stderr).not.toMatch(/ExperimentalWarning/);
	});

	it("`files <repo>` lists the repo's files (lone existing dir is the root, not a pattern)", () => {
		const { stdout } = cli(["files", dir], project);
		expect(stdout).toContain("math.ts");
		expect(stdout).toContain("app.ts");
	});

	it("`files --limit N` returns exactly N", () => {
		const { stdout } = cli(["files", dir, "--limit", "1"], project);
		expect(stdout.trim().split("\n")).toHaveLength(1);
	});

	it("`callers <repo> --moniker <m>` resolves via an external repo + moniker", () => {
		const moniker = /\[id: ([^\]]+)\]/.exec(cli(["def", "add", dir], project).stdout)?.[1];
		expect(moniker).toBeTruthy();
		const { stdout } = cli(["callers", dir, "--moniker", moniker as string], project);
		expect(stdout).toContain("app.ts");
	});

	it("`match` finds code by AST shape", () => {
		const { stdout } = cli(
			["match", "(function_declaration name: (identifier) @n)", dir, "--lang", "typescript"],
			project,
		);
		expect(stdout).toContain("n=add");
	});

	it("`explore` prints definition and relationship context", () => {
		const { stdout } = cli(["explore", "add", dir], project);
		expect(stdout).toContain("function add");
		expect(stdout).toContain("return a + b");
		expect(stdout).toContain("callers");
	});

	it("`status --verify` reports changed/new/deleted counts", () => {
		const { stdout } = cli(["status", dir, "--verify"], project);
		const status = JSON.parse(stdout);
		expect(status).toMatchObject({ changed: 0, new: 0, deleted: 0 });
	});

	it("empty results print (no results)", () => {
		expect(cli(["search", "NoSuchZzz", dir], project).stdout).toContain("(no results)");
	});

	it("an empty moniker query says so instead of exiting silently", () => {
		const { stdout } = cli(["callers", dir, "--moniker", "bogus#nope@9:9"], project);
		expect(stdout).toContain("no indexed declaration matches moniker");
	});

	it("rejects zero for limit, depth, and budget flags", () => {
		for (const [command, flag] of [
			["search", "--limit"],
			["impact", "--depth"],
			["explore", "--budget"],
		] as const) {
			const result = cli([command, "add", dir, flag, "0"], project);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("expects a positive integer");
		}
	});

	it("rejects a non-positive file cap", () => {
		const result = cli(["sync", dir, "--max-files", "0"], project);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("expects a positive integer");
	});

	it("rejects resource flags above their public ceilings", () => {
		for (const [command, flag, value, ceiling] of [
			["search", "--limit", "501", "500"],
			["impact", "--depth", "11", "10"],
			["explore", "--budget", "50001", "50,000"],
			["sync", "--max-files", "100001", "100,000"],
		] as const) {
			const result = cli([command, "add", dir, flag, value], project);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`must not exceed ${ceiling}`);
		}
	});
});
