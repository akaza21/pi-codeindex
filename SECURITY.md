# Security policy

## Supported versions

Before 1.0, security fixes are made on the latest released minor version. Users should upgrade to the newest available release before reporting a problem that may already be fixed.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's [private vulnerability reporting](../../security/advisories/new) for this repository and include:

- the affected version and platform;
- the smallest reproduction you can provide;
- the expected and observed impact;
- whether untrusted source code, file paths, SCIP input, or tree-sitter queries are involved; and
- any mitigation you have already tested.

Reports are reviewed privately. Confirmed issues are fixed and disclosed in coordination with the reporter.

## Security model

pi-codeindex reads source files beneath the selected workspace, stores a local cache in `.codeindex/`, and makes no network calls or telemetry requests itself. Tool results returned to pi can still become part of the context sent to the model provider configured by the user. Review that provider's data-handling policy before indexing sensitive code.

The index is a cache, not a sandbox. The process has the same filesystem permissions as the user running pi or the CLI. Treat repositories, SCIP files, and structural queries from untrusted sources with the same care as other local developer-tool input.
