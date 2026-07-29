#!/usr/bin/env node
/**
 * Compares syntactic reference targets with an external SCIP index.
 *
 * Usage: node scripts/scip-eval.mjs <repoRoot> <index.scip>
 *
 * Reports model coverage, exact-location candidate recall, deterministic top-1 precision,
 * confidence/provenance/role breakdowns, and representative disagreements. The local index is
 * created in a temporary directory.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestScip, openIndex } from "../src/engine/index.ts";
import { PROVENANCE_RANK } from "../src/engine/model/types.ts";
import { createScipRangeDecoder } from "../src/engine/scip/position.ts";
import { scipIndexType } from "../src/engine/scip/schema.ts";

const [repoRoot, scipPath] = process.argv.slice(2);
if (!repoRoot || !scipPath) {
	console.error("usage: scip-eval.mjs <repoRoot> <index.scip>");
	process.exit(2);
}

const HIGH_CONFIDENCE = 0.9;
const EXAMPLE_LIMIT = 12;
const SYMBOL_ROLE_DEFINITION = 0x1;
const LOCAL_SYMBOL_PREFIX = "local ";

const bytes = readFileSync(scipPath);
const decoded = scipIndexType().decode(bytes);
const tmp = mkdtempSync(join(tmpdir(), "scip-eval-"));
const { store, indexer } = openIndex({ root: repoRoot, dbPath: join(tmp, "i.db") });

try {
	const started = Date.now();
	await indexer.sync();
	const syncMs = Date.now() - started;
	const snapshot = store.snapshot();
	const sourceCache = new Map();
	const readSource = (relativePath) => {
		if (sourceCache.has(relativePath)) return sourceCache.get(relativePath);
		let source;
		if (snapshot.fileIdByPath(relativePath) !== undefined) {
			try {
				source = readFileSync(join(repoRoot, relativePath), "utf8");
			} catch {
				// Missing/unreadable source reduces mapping coverage; it must not trigger a guessed coordinate.
			}
		}
		sourceCache.set(relativePath, source);
		return source;
	};

	// Identify the subset of SCIP's global model represented by local indexed symbols. Raw SCIP
	// references also include document-local bindings and external dependencies, neither of which
	// can map to a repository-local pi-codeindex symbol.
	const globalDefinitions = new Set();
	const mappedDefinitions = new Map();
	let rawOccurrences = 0;
	let rawDefinitions = 0;
	for (const document of decoded.documents ?? []) {
		const embedded = Object.hasOwn(document, "text") ? document.text : undefined;
		const source = embedded ?? (document.relativePath ? readSource(document.relativePath) : undefined);
		const decodeRange = createScipRangeDecoder(document.positionEncoding ?? 0, source);
		for (const occurrence of document.occurrences ?? []) {
			rawOccurrences++;
			if (!isDefinition(occurrence)) continue;
			rawDefinitions++;
			if (!occurrence.symbol || isLocalSymbol(occurrence.symbol)) continue;
			globalDefinitions.add(occurrence.symbol);
			const range = decodeRange(occurrence);
			if (!range || !document.relativePath) continue;
			const moniker = snapshot.symbolAtName(document.relativePath, range[0], range[1]);
			if (moniker) mappedDefinitions.set(occurrence.symbol, moniker);
		}
	}

	let localReferences = 0;
	let externalReferences = 0;
	let inProjectReferences = 0;
	let referencesToMappedDefinitions = 0;
	for (const document of decoded.documents ?? []) {
		for (const occurrence of document.occurrences ?? []) {
			if (isDefinition(occurrence)) continue;
			if (!occurrence.symbol || isLocalSymbol(occurrence.symbol)) {
				localReferences++;
			} else if (!globalDefinitions.has(occurrence.symbol)) {
				externalReferences++;
			} else {
				inProjectReferences++;
				if (mappedDefinitions.has(occurrence.symbol)) referencesToMappedDefinitions++;
			}
		}
	}

	// Use the production SCIP mapper for the oracle facts. It intentionally deduplicates identical
	// (file, range, target) references and rejects malformed ranges.
	const oracle = ingestScip(snapshot, bytes, { readSource });
	const oracleByLocation = new Map();
	for (const occurrence of oracle) addToSet(oracleByLocation, locationKey(occurrence), occurrence.symbol);

	// Keep the best row per target at a source location. Candidate order matches the store's public
	// precision ordering, with the moniker as a deterministic final tie-break for this evaluation.
	const candidatesByLocation = new Map();
	const candidateLines = new Set();
	for (const occurrence of store.allOccurrences()) {
		if (occurrence.provenance === "scip") continue;
		const key = locationKey(occurrence);
		let targets = candidatesByLocation.get(key);
		if (!targets) {
			targets = new Map();
			candidatesByLocation.set(key, targets);
		}
		const existing = targets.get(occurrence.symbol);
		if (!existing || compareCandidates(occurrence, existing) < 0) targets.set(occurrence.symbol, occurrence);
		candidateLines.add(`${occurrence.file}|${occurrence.range[0]}`);
	}

	let sameLineLocations = 0;
	let comparableLocations = 0;
	let candidateRecall = 0;
	let topRankRecall = 0;
	let top1Exact = 0;
	let top1Equivalent = 0;
	let top1EquivalentOnly = 0;
	let oracleInTopRankTie = 0;
	let oracleBelowTopRank = 0;
	let top1SameNameDifferentSite = 0;
	let top1DifferentTargetName = 0;
	let uniqueTopRankLocations = 0;
	let uniqueTopRankExact = 0;
	let uniqueTopRankEquivalent = 0;
	let equivalentOnly = 0;
	let sameNameDifferentSite = 0;
	let differentTargetName = 0;
	let totalCandidates = 0;
	let maxCandidates = 0;
	let highConfidenceLocations = 0;
	let highConfidenceExact = 0;
	let highConfidenceEquivalent = 0;
	const disagreementExamples = [];
	const byProvenance = new Map();
	const byRole = new Map();
	const byConfidence = new Map();

	for (const [key, expected] of oracleByLocation) {
		const [file, line] = splitLocationKey(key);
		if (candidateLines.has(`${file}|${line}`)) sameLineLocations++;
		const targetMap = candidatesByLocation.get(key);
		if (!targetMap) continue;
		const candidates = [...targetMap.values()].sort(compareCandidates);
		if (candidates.length === 0) continue;
		comparableLocations++;
		totalCandidates += candidates.length;
		maxCandidates = Math.max(maxCandidates, candidates.length);

		const exactCandidate = candidates.some((candidate) => expected.has(candidate.symbol));
		if (exactCandidate) candidateRecall++;
		const topConfidence = candidates[0].confidence;
		const topRanked = candidates.filter(
			(candidate) =>
				candidate.confidence === topConfidence && provenanceRank(candidate) === provenanceRank(candidates[0]),
		);
		const topRankExact = topRanked.some((candidate) => expected.has(candidate.symbol));
		if (topRankExact) topRankRecall++;

		const top = candidates[0];
		const exact = expected.has(top.symbol);
		const representationEquivalent =
			!exact && [...expected].some((symbol) => constructorClassEquivalent(snapshot, symbol, top.symbol));
		if (topRanked.length === 1) {
			uniqueTopRankLocations++;
			if (exact) uniqueTopRankExact++;
			if (exact || representationEquivalent) uniqueTopRankEquivalent++;
		}
		if (exact) top1Exact++;
		if (exact || representationEquivalent) {
			top1Equivalent++;
			if (representationEquivalent) top1EquivalentOnly++;
		} else if (topRankExact) {
			oracleInTopRankTie++;
		} else if (exactCandidate) {
			oracleBelowTopRank++;
		} else if (sameTargetName(snapshot, expected, [top])) {
			top1SameNameDifferentSite++;
		} else {
			top1DifferentTargetName++;
		}

		if (top.confidence >= HIGH_CONFIDENCE) {
			highConfidenceLocations++;
			if (exact) highConfidenceExact++;
			if (exact || representationEquivalent) highConfidenceEquivalent++;
		}

		addBreakdown(byProvenance, top.provenance, exact, representationEquivalent);
		addBreakdown(byRole, top.role, exact, representationEquivalent);
		addBreakdown(byConfidence, confidenceBand(top.confidence), exact, representationEquivalent);

		if (exactCandidate) continue;
		if (
			candidates.some((candidate) =>
				[...expected].some((symbol) => constructorClassEquivalent(snapshot, symbol, candidate.symbol)),
			)
		) {
			equivalentOnly++;
			continue;
		}
		if (sameTargetName(snapshot, expected, candidates)) {
			sameNameDifferentSite++;
			continue;
		}
		differentTargetName++;
		if (disagreementExamples.length < EXAMPLE_LIMIT) {
			disagreementExamples.push(
				`  ${file}:${line}  scip=${[...expected].slice(0, 3).join(", ")}  syntactic=${candidates
					.slice(0, 3)
					.map((candidate) => candidate.symbol)
					.join(", ")}`,
			);
		}
	}

	const rawReferences = rawOccurrences - rawDefinitions;
	console.log(`repo: ${repoRoot}`);
	console.log(`pi-codeindex: ${store.status().files} files, ${store.status().symbols} symbols, sync ${syncMs}ms`);
	console.log(
		`raw .scip: ${decoded.documents?.length ?? 0} documents, ${rawOccurrences} occurrences (${rawDefinitions} defs, ${rawReferences} refs)`,
	);
	console.log("SCIP reference model:");
	console.log(`  document-local / empty: ${localReferences}`);
	console.log(`  external:               ${externalReferences}`);
	console.log(`  in-project global:      ${inProjectReferences}`);
	console.log(
		`definition coverage: ${mappedDefinitions.size}/${globalDefinitions.size} global symbols (${pct(mappedDefinitions.size, globalDefinitions.size)})`,
	);
	console.log(
		`in-project reference coverage: ${referencesToMappedDefinitions}/${inProjectReferences} (${pct(referencesToMappedDefinitions, inProjectReferences)})`,
	);
	console.log(
		`mapped oracle facts: ${oracle.length} unique references at ${oracleByLocation.size} locations (${pct(oracle.length, rawReferences)} of all SCIP refs)`,
	);
	console.log(
		`location coverage: ${comparableLocations}/${oracleByLocation.size} exact (${pct(comparableLocations, oracleByLocation.size)}), ${sameLineLocations}/${oracleByLocation.size} same-line (${pct(sameLineLocations, oracleByLocation.size)})`,
	);
	console.log(
		`candidate recall: ${candidateRecall}/${comparableLocations} (${pct(candidateRecall, comparableLocations)}); top-rank recall: ${topRankRecall}/${comparableLocations} (${pct(topRankRecall, comparableLocations)})`,
	);
	console.log(
		`top-1 precision: ${top1Exact}/${comparableLocations} exact (${pct(top1Exact, comparableLocations)}), ${top1Equivalent}/${comparableLocations} including class/constructor equivalence (${pct(top1Equivalent, comparableLocations)})`,
	);
	console.log(
		`unique top-rank precision: ${uniqueTopRankExact}/${uniqueTopRankLocations} exact (${pct(uniqueTopRankExact, uniqueTopRankLocations)}), ${uniqueTopRankEquivalent}/${uniqueTopRankLocations} equivalent (${pct(uniqueTopRankEquivalent, uniqueTopRankLocations)})`,
	);
	console.log(
		`high-score top-1 (>= ${HIGH_CONFIDENCE}): ${highConfidenceExact}/${highConfidenceLocations} exact (${pct(highConfidenceExact, highConfidenceLocations)}), ${highConfidenceEquivalent}/${highConfidenceLocations} equivalent (${pct(highConfidenceEquivalent, highConfidenceLocations)})`,
	);
	console.log(
		`candidate set size: ${average(totalCandidates, comparableLocations)} average, ${maxCandidates} maximum at exact-comparable locations`,
	);
	const top1Errors = comparableLocations - top1Exact;
	console.log("top-1 error classification:");
	console.log(`  class / constructor representation: ${top1EquivalentOnly} (${pct(top1EquivalentOnly, top1Errors)})`);
	console.log(`  oracle in tied top-ranked set:       ${oracleInTopRankTie} (${pct(oracleInTopRankTie, top1Errors)})`);
	console.log(`  oracle target below top rank:        ${oracleBelowTopRank} (${pct(oracleBelowTopRank, top1Errors)})`);
	console.log(
		`  same name, different declaration:   ${top1SameNameDifferentSite} (${pct(top1SameNameDifferentSite, top1Errors)})`,
	);
	console.log(
		`  different target name:              ${top1DifferentTargetName} (${pct(top1DifferentTargetName, top1Errors)})`,
	);

	printBreakdown("top-1 by provenance", byProvenance);
	printBreakdown("top-1 by role", byRole);
	printBreakdown("top-1 by resolution score", byConfidence);

	const misses = comparableLocations - candidateRecall;
	console.log(`\nexact-location candidate misses: ${misses}`);
	console.log(`  class / constructor representation: ${equivalentOnly} (${pct(equivalentOnly, misses)})`);
	console.log(
		`  same name, different declaration:   ${sameNameDifferentSite} (${pct(sameNameDifferentSite, misses)})`,
	);
	console.log(`  different target name:              ${differentTargetName} (${pct(differentTargetName, misses)})`);
	if (disagreementExamples.length > 0) {
		console.log("different-target-name examples:");
		for (const example of disagreementExamples) console.log(example);
	}
	console.log(
		"\nPrecision is conditional on exact locations represented by both systems; coverage and precision must be reported together.",
	);
} finally {
	store.close();
	rmSync(tmp, { recursive: true, force: true });
}

function isDefinition(occurrence) {
	return ((occurrence.symbolRoles ?? 0) & SYMBOL_ROLE_DEFINITION) !== 0;
}

function isLocalSymbol(symbol) {
	return symbol.startsWith(LOCAL_SYMBOL_PREFIX);
}

function locationKey(occurrence) {
	return `${occurrence.file}|${occurrence.range[0]}|${occurrence.range[1]}`;
}

function splitLocationKey(key) {
	const last = key.lastIndexOf("|");
	const secondLast = key.lastIndexOf("|", last - 1);
	return [key.slice(0, secondLast), Number(key.slice(secondLast + 1, last))];
}

function addToSet(map, key, value) {
	let values = map.get(key);
	if (!values) {
		values = new Set();
		map.set(key, values);
	}
	values.add(value);
}

function provenanceRank(candidate) {
	return PROVENANCE_RANK[candidate.provenance] ?? 0;
}

function compareCandidates(a, b) {
	return b.confidence - a.confidence || provenanceRank(b) - provenanceRank(a) || a.symbol.localeCompare(b.symbol);
}

function constructorClassEquivalent(snapshot, aMoniker, bMoniker) {
	const a = snapshot.symbolByMoniker(aMoniker);
	const b = snapshot.symbolByMoniker(bMoniker);
	if (!a || !b || a.fileId !== b.fileId) return false;
	return (
		(a.name === "constructor" && b.kind === "class" && a.ownerType === b.name) ||
		(b.name === "constructor" && a.kind === "class" && b.ownerType === a.name)
	);
}

function sameTargetName(snapshot, expected, candidates) {
	const expectedNames = new Set([...expected].map((moniker) => symbolName(snapshot, moniker)));
	return candidates.some((candidate) => expectedNames.has(symbolName(snapshot, candidate.symbol)));
}

function symbolName(snapshot, moniker) {
	return snapshot.symbolByMoniker(moniker)?.name ?? trailingIdentifier(moniker);
}

function trailingIdentifier(moniker) {
	return ((moniker.split("@")[0] || "").split(/[#/]/).filter(Boolean).pop() || "")
		.replace(/\(.*$/, "")
		.replace(/\.+$/, "");
}

function confidenceBand(confidence) {
	if (confidence >= HIGH_CONFIDENCE) return `>=${HIGH_CONFIDENCE}`;
	if (confidence >= 0.5) return "0.5-0.89";
	return "<0.5";
}

function addBreakdown(map, label, exact, equivalent) {
	const row = map.get(label) ?? { total: 0, exact: 0, equivalent: 0 };
	row.total++;
	if (exact) row.exact++;
	if (exact || equivalent) row.equivalent++;
	map.set(label, row);
}

function printBreakdown(label, rows) {
	console.log(`${label}:`);
	for (const [name, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
		console.log(
			`  ${name}: ${row.exact}/${row.total} exact (${pct(row.exact, row.total)}), ${row.equivalent}/${row.total} equivalent (${pct(row.equivalent, row.total)})`,
		);
	}
}

function pct(numerator, denominator) {
	return denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function average(total, count) {
	return count === 0 ? "n/a" : (total / count).toFixed(2);
}
