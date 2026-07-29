# Evaluation

From a source checkout, pi-codeindex can compare its compiler-free resolver with a compiler-produced SCIP index:

```bash
node scripts/scip-eval.mjs /path/to/repository /path/to/index.scip
```

The comparison reports coverage and accuracy separately. SCIP locations are translated from each document's declared UTF-8, UTF-16, or UTF-32 position encoding before comparison. “Comparable” means the SCIP reference points to an in-repository, non-local definition that pi-codeindex represents, both systems map the source location, and pi-codeindex emits at least one candidate there. Accuracy percentages below apply only to those locations; they are not whole-repository recall.

## Results

The syntactic and scoped resolvers were evaluated without optional typed resolution.

| Corpus | In-project SCIP references | Exactly comparable | Candidate recall | Deterministic top-1 | Unique-top-rank precision | Precision at score ≥0.9 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Microsoft TypeScript 5.6.3 | 224,320 | 33,944 (15.1%) | 99.1% | 77.2% | 98.8% | 98.6% |
| scip-go 0.2.7 | 1,140 | 290 (25.4%) | 100% | 95.5% | 100% | 100% |

The evaluation used pi-codeindex 0.1.0. All accuracy columns are conditional on exactly comparable locations; the first three columns expose that coverage boundary.

The TypeScript corpus used commit `d48a5cf89a62a62d6c6ed53ffa18f070d9458b85`, `scip-typescript` 0.4.0, and the TypeScript 5.6.3 compiler dependency. Of its 224,320 in-project global SCIP references, 75,888 targeted definitions representable by pi-codeindex; 73,434 unique oracle references mapped at 73,388 locations and 33,944 were exactly comparable. The average pi-codeindex candidate set at comparable locations was 1.51 and the maximum was 14.

There were 307 TypeScript candidate-set misses: 14 were class-versus-constructor representation differences and 293 selected another same-named declaration. No miss selected a differently named target. A deterministic single-target tie-break scores 77.2% because 7,428 misses are equal-ranked ties that still contain the compiler target. Deterministic top-1 measures forced single-answer selection; unique-top-rank precision measures only answers whose highest rank is unambiguous.

The Go corpus used commit `2e9ff3c2603a85daabe125c9f20075ec52df0731`, `scip-go` 0.2.7, and Go 1.25.12. It contained 1,140 in-project global references, 533 references to representable definitions, and 290 exactly comparable locations. All compiler targets appeared in the top-ranked candidate set. Thirteen deterministic single-target misses were equal-ranked ties.

## Metrics

- **Candidate recall:** the compiler target appears anywhere in pi-codeindex's candidate set.
- **Top-rank recall:** the compiler target appears among the highest-ranked candidates.
- **Unique-top-rank precision:** an unambiguous highest-ranked candidate equals the compiler target.
- **High-score precision:** a candidate emitted at heuristic resolution score 0.9 or higher equals the compiler target. The score is not a calibrated probability.

The harness also prints definition/reference coverage, local and external SCIP counts, role/provenance/resolution-score breakdowns, tied-candidate classifications, and representative disagreements. This keeps low mapping coverage, ambiguous candidates, and precise bindings from being blended into a single accuracy number.
