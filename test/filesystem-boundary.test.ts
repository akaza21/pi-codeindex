import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../src/engine/index.ts";
import { discoverRepos } from "../src/pi/workspace.ts";

describe("filesystem root boundaries", () => {
	it("refuses reads, stats, and walks outside the selected repository", () => {
		const parent = mkdtempSync(join(tmpdir(), "codeindex-root-boundary-"));
		const root = join(parent, "root");
		const outside = join(parent, "outside.ts");
		mkdirSync(root);
		writeFileSync(join(root, "inside.ts"), "export const inside = 1;\n");
		writeFileSync(outside, "export const outside = 1;\n");
		const fs = new NodeFileSystem(root);
		try {
			expect(fs.readFile(join(root, "inside.ts"))).toContain("inside");
			expect(fs.readFile(outside)).toBeUndefined();
			expect(fs.stat(outside)).toBeUndefined();
			expect(fs.exists(outside)).toBe(false);
			expect([...fs.walk(parent)]).toEqual([]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("filesystem symlink boundaries", () => {
	it("does not index file or directory symlinks", () => {
		const parent = mkdtempSync(join(tmpdir(), "codeindex-symlink-"));
		const root = join(parent, "root");
		const outside = join(parent, "outside");
		mkdirSync(root);
		mkdirSync(outside);
		writeFileSync(join(root, "inside.ts"), "export const inside = 1;\n");
		writeFileSync(join(outside, "outside.ts"), "export const outside = 1;\n");
		symlinkSync(outside, join(root, "linked-dir"), "dir");
		symlinkSync(join(outside, "outside.ts"), join(root, "linked-file.ts"), "file");

		try {
			const walked = [...new NodeFileSystem(root).walk(root)].map((path) => path.slice(root.length + 1));
			expect(walked).toEqual(["inside.ts"]);
			expect(new NodeFileSystem(root).stat(join(root, "linked-file.ts"))).toBeUndefined();
			expect(new NodeFileSystem(root).readFile(join(root, "linked-file.ts"))).toBeUndefined();
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("does not discover repositories through directory symlinks", () => {
		const parent = mkdtempSync(join(tmpdir(), "codeindex-workspace-link-"));
		const root = join(parent, "workspace");
		const outside = join(parent, "outside-repo");
		mkdirSync(root);
		mkdirSync(join(outside, ".git"), { recursive: true });
		symlinkSync(outside, join(root, "linked-repo"), "dir");
		try {
			expect(discoverRepos(root)).toEqual([]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("supports a repository root selected through a directory symlink", () => {
		const parent = mkdtempSync(join(tmpdir(), "codeindex-symlink-root-"));
		const realRoot = join(parent, "real-root");
		const selectedRoot = join(parent, "selected-root");
		mkdirSync(realRoot);
		writeFileSync(join(realRoot, "inside.ts"), "export const inside = 1;\n");
		symlinkSync(realRoot, selectedRoot, "dir");
		try {
			const walked = [...new NodeFileSystem(selectedRoot).walk(selectedRoot)];
			expect(walked).toEqual([join(selectedRoot, "inside.ts")]);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});
