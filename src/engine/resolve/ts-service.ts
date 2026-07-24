/**
 * In-process TypeScript type service. Wraps the `typescript` compiler's
 * LanguageService — a pure-JS, in-process type checker, the reason typed resolution is
 * feasible for TS/JS without any external toolchain or server.
 *
 * `typescript` is an optional dependency: if it is not installed (or fails to load),
 * `isAvailable()` is false and the typed resolver disables itself, degrading to the
 * scope-graph and syntactic resolvers.
 *
 * Cost note: the dominant cost is building the program, and adding a root file rebuilds
 * it. Register the whole working set once with `preload()` so the program is built a
 * single time; per-reference `definitions()` calls are then cheap (sub-millisecond).
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

type Ts = typeof import("typescript");
type LanguageService = import("typescript").LanguageService;

interface TsDefinition {
	/** Absolute file path of the definition. */
	file: string;
	/** 1-based line, 0-based column of the definition name. */
	line: number;
	col: number;
}

export class TsTypeService {
	private readonly root: string;
	private readonly ts: Ts | null;
	private service: LanguageService | undefined;
	private readonly files = new Set<string>();
	private readonly fileVersions = new Map<string, number>();

	constructor(root: string) {
		this.root = root;
		let ts: Ts | null = null;
		try {
			ts = require("typescript") as Ts;
		} catch {
			ts = null;
		}
		this.ts = ts;
	}

	isAvailable(): boolean {
		return this.ts !== null;
	}

	/**
	 * Register a batch of files as program roots up front. Done before the first query so
	 * the program is built once over the whole set, rather than rebuilt as each file is
	 * added on demand (which is O(files) program rebuilds and the real cost of typed resolution).
	 */
	preload(absFiles: Iterable<string>): void {
		for (const file of absFiles) this.addFile(file);
	}

	/** Replace the working set and compiler service for a new index snapshot. */
	reset(absFiles: Iterable<string>): void {
		this.service?.dispose();
		this.service = undefined;
		this.files.clear();
		this.fileVersions.clear();
		this.preload(absFiles);
	}

	/** Definitions for the symbol at (line,col) in `absFile`; [] when unavailable. */
	definitions(absFile: string, line: number, col: number): TsDefinition[] {
		const ts = this.ts;
		if (!ts) return [];
		const service = this.ensureService(ts);
		this.addFile(absFile);
		const program = service.getProgram();
		const source = program?.getSourceFile(absFile);
		if (!program || !source) return [];
		let position: number;
		try {
			position = ts.getPositionOfLineAndCharacter(source, line - 1, col);
		} catch {
			return [];
		}
		const out: TsDefinition[] = [];
		const seen = new Set<string>();
		const checker = program.getTypeChecker();
		const add = (defSource: import("typescript").SourceFile | undefined, start: number): void => {
			if (!defSource) return;
			const lc = ts.getLineAndCharacterOfPosition(defSource, start);
			const key = `${defSource.fileName}:${lc.line}:${lc.character}`;
			if (seen.has(key)) return;
			seen.add(key);
			out.push({ file: defSource.fileName, line: lc.line + 1, col: lc.character });
		};
		const addAliased = (at: import("typescript").SourceFile, start: number): void => {
			const symbol = checker.getSymbolAtLocation(nodeAtPosition(at, start));
			if (!symbol || (symbol.flags & ts.SymbolFlags.Alias) === 0) return;
			const target = checker.getAliasedSymbol(symbol);
			for (const declaration of target.getDeclarations() ?? []) {
				const named = declaration as import("typescript").NamedDeclaration;
				add(declaration.getSourceFile(), named.name?.getStart() ?? declaration.getStart());
			}
		};
		// Type definitions unwrap import aliases to the exported declaration, while ordinary
		// definitions preserve method/overload navigation. Consider both and de-duplicate.
		const definitions = [
			...(service.getDefinitionAtPosition(absFile, position) ?? []),
			...(service.getTypeDefinitionAtPosition(absFile, position) ?? []),
		];
		for (const def of definitions) {
			const defSource = program.getSourceFile(def.fileName);
			add(defSource, def.textSpan.start);
			if (defSource) addAliased(defSource, def.textSpan.start);
		}
		// LanguageService definitions for an imported identifier can stop at the local import
		// specifier. Unwrap that alias through the checker so the index can map the exported
		// declaration rather than a non-symbol import token.
		addAliased(source, position);
		return out;
	}

	private ensureService(ts: Ts): LanguageService {
		if (this.service) return this.service;
		const options = this.compilerOptions(ts);
		const host: import("typescript").LanguageServiceHost = {
			getScriptFileNames: () => [...this.files],
			getScriptVersion: (file) => String(this.fileVersions.get(file) ?? 0),
			getScriptSnapshot: (file) => {
				const text = ts.sys.readFile(file);
				return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
			},
			getCurrentDirectory: () => this.root,
			getCompilationSettings: () => options,
			getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
			fileExists: ts.sys.fileExists,
			readFile: ts.sys.readFile,
			readDirectory: ts.sys.readDirectory,
			directoryExists: ts.sys.directoryExists,
			getDirectories: ts.sys.getDirectories,
		};
		this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
		return this.service;
	}

	/** Use the repository tsconfig when present, falling back to safe NodeNext defaults. */
	private compilerOptions(ts: Ts): import("typescript").CompilerOptions {
		const defaults: import("typescript").CompilerOptions = {
			allowJs: true,
			checkJs: false,
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			allowImportingTsExtensions: true,
			noEmit: true,
			skipLibCheck: true,
		};
		const configPath = join(this.root, "tsconfig.json");
		if (!ts.sys.fileExists(configPath)) return defaults;
		const read = ts.readConfigFile(configPath, ts.sys.readFile);
		if (read.error) return defaults;
		const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, this.root, undefined, configPath);
		// When a project config exists, let TypeScript choose the normal defaults for any
		// omitted module settings instead of imposing NodeNext (which can invalidate otherwise
		// valid extensionless `paths` aliases). Only add the options required by this no-emit service.
		return {
			allowJs: true,
			checkJs: false,
			skipLibCheck: true,
			...parsed.options,
			noEmit: true,
		};
	}

	/** Register a queried file as a program root; TS pulls in its imports via resolution. */
	private addFile(absFile: string): void {
		if (!this.files.has(absFile)) {
			this.files.add(absFile);
			this.fileVersions.set(absFile, 0);
		}
	}
}

/** Smallest compiler node containing a source position (public-API alternative to TS internals). */
function nodeAtPosition(root: import("typescript").Node, position: number): import("typescript").Node {
	let best = root;
	const visit = (node: import("typescript").Node): void => {
		if (position < node.getFullStart() || position >= node.getEnd()) return;
		best = node;
		node.forEachChild(visit);
	};
	root.forEachChild(visit);
	return best;
}
