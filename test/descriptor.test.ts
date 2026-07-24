import { describe, expect, it } from "vitest";
import { descriptor, descriptorSuffix } from "../src/engine/model/descriptor.ts";
import { buildMoniker } from "../src/engine/model/moniker.ts";

describe("SCIP-style descriptors", () => {
	it("maps kinds to the right descriptor marker", () => {
		expect(descriptorSuffix("class")).toBe("#");
		expect(descriptorSuffix("interface")).toBe("#");
		expect(descriptorSuffix("enum")).toBe("#");
		expect(descriptorSuffix("function")).toBe("().");
		expect(descriptorSuffix("method")).toBe("().");
		expect(descriptorSuffix("module")).toBe("/");
		expect(descriptorSuffix("constant")).toBe("."); // term
	});

	it("falls back to a term for unknown kinds (safe default)", () => {
		expect(descriptorSuffix("whatever")).toBe(".");
		expect(descriptor("x", "whatever")).toBe("x.");
	});

	it("encodes the kind into the name", () => {
		expect(descriptor("Foo", "class")).toBe("Foo#");
		expect(descriptor("bar", "method")).toBe("bar().");
	});

	it("backtick-escapes names with reserved characters (SCIP)", () => {
		expect(descriptor("@ivar", "variable")).toBe("`@ivar`."); // Ruby instance var
		expect(descriptor("#secret", "method")).toBe("`#secret`()."); // TS private member
		expect(descriptor("with`tick", "type")).toBe("`with``tick`#"); // embedded backtick doubled
		expect(descriptor("plain_id$", "function")).toBe("plain_id$()."); // simple id stays bare
	});
});

describe("moniker scheme", () => {
	it("embeds the descriptor chain and start position", () => {
		expect(buildMoniker({ file: "app.ts", name: "Foo", kind: "class", startLine: 1, startCol: 0 })).toBe(
			"app.ts#Foo#@1:0",
		);
		expect(
			buildMoniker({ file: "app.ts", name: "bar", kind: "method", startLine: 3, startCol: 2, ownerType: "Foo" }),
		).toBe("app.ts#Foo#bar().@3:2");
		expect(buildMoniker({ file: "u.ts", name: "x", kind: "variable", startLine: 2, startCol: 4 })).toBe(
			"u.ts#x.@2:4",
		);
	});

	it("keeps same-name declarations distinct by position", () => {
		const a = buildMoniker({ file: "f.ts", name: "run", kind: "function", startLine: 1, startCol: 0 });
		const b = buildMoniker({ file: "f.ts", name: "run", kind: "function", startLine: 9, startCol: 0 });
		expect(a).not.toBe(b);
	});

	it("does not collide a member with a same-spelled top-level name (escaping disambiguates)", () => {
		const member = buildMoniker({
			file: "f.ts",
			ownerType: "A",
			name: "b",
			kind: "variable",
			startLine: 1,
			startCol: 0,
		});
		const topLevel = buildMoniker({ file: "f.ts", name: "A#b", kind: "variable", startLine: 1, startCol: 0 });
		expect(member).toBe("f.ts#A#b.@1:0");
		expect(topLevel).toBe("f.ts#`A#b`.@1:0");
		expect(member).not.toBe(topLevel);
	});
});
