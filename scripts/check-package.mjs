import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this check through npm");

const stdout = execFileSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--dry-run", "--json"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});
const [report] = JSON.parse(stdout);
if (!report?.files) throw new Error("npm pack did not return a file manifest");

const files = new Set(report.files.map((entry) => entry.path));
const required = [
	"package.json",
	"README.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"SECURITY.md",
	"LICENSE",
	"LICENSES/Apache-2.0.txt",
	"THIRD_PARTY_NOTICES.md",
	"bin/codeindex.mjs",
	"bin/codeindex.ts",
	"docs/how-it-works.md",
	"src/pi/index.ts",
];
const missing = required.filter((path) => !files.has(path));
const forbidden = [...files].filter(
	(path) =>
		path.includes(":Zone.Identifier") ||
		path.startsWith("node_modules/") ||
		path.startsWith("test/") ||
		path.startsWith(".codeindex/") ||
		path === ".env" ||
		path.endsWith(".db"),
);

if (missing.length > 0 || forbidden.length > 0) {
	const problems = [
		...(missing.length > 0 ? [`missing required files: ${missing.join(", ")}`] : []),
		...(forbidden.length > 0 ? [`forbidden files: ${forbidden.join(", ")}`] : []),
	];
	throw new Error(`invalid npm package payload — ${problems.join("; ")}`);
}

console.log(`package payload OK: ${files.size} files, ${report.size} bytes`);
