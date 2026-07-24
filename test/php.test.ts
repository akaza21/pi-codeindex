import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openIndex, type Store } from "../src/engine/index.ts";

// End-to-end PHP support: namespaces/interfaces/classes/methods/functions, ownerType, receiver
// method calls ($obj->m()), bare function calls, and precise extends/implements edges.
describe("PHP support", () => {
	let dir: string;
	let store: Store;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "codeindex-php-"));
		writeFileSync(
			join(dir, "shapes.php"),
			[
				"<?php",
				"namespace Geo;",
				"class Base {}",
				"interface IShape { public function area(): float; }",
				"class Circle extends Base implements IShape {",
				"    private float $r;",
				"    public function __construct(float $r) { $this->r = $r; }",
				"    public function area(): float { return scale($this->r); }",
				"}",
				"function scale(float $v): float { return $v * 3.14; }",
				"function run(): float { $c = new Circle(2.0); return $c->area(); }",
				"",
			].join("\n"),
		);
		const opened = openIndex({ root: dir, dbPath: join(dir, "i.db") });
		store = opened.store;
		await opened.indexer.sync();
	});

	afterAll(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("attaches method ownerType (area is a method owned by Circle)", () => {
		expect(store.definitions("area", 5).some((s) => s.kind === "method" && s.ownerType === "Circle")).toBe(true);
	});

	it("resolves a receiver method call ($c->area()) and a bare function call (scale())", () => {
		expect(store.callers("area", 10).some((h) => h.enclosing === "run")).toBe(true);
		expect(store.callers("scale", 10).some((h) => h.enclosing === "area")).toBe(true);
	});

	it("captures precise extends and implements edges", () => {
		const supers = store.supertypes("Circle", 5).map((h) => h.name);
		expect(supers).toContain("Base");
		expect(supers).toContain("IShape");
	});
});
