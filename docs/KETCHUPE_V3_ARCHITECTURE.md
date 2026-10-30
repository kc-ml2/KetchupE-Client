# Architecture and code map

Current implementation, 2026-10-26. “v3” names the architecture; the release version lives in [package.json](../package.json).

KetchupE is an Electron desktop app for local document search, grounded answers, document drafting, deterministic Excel tasks, and experimental LLM-planned Excel analysis. Start with the [README](../README.md) for setup, the [integration guide](WORKFLOW_INTEGRATION_GUIDE.md) to add capabilities, or [business tools](BUSINESS_TOOLS.md) for Excel contracts and Daily Cash rules. Type definitions and tests are the source of truth; this document does not duplicate their schemas.

## Execution boundaries

```text
React → email authentication → session-bound preload IPC → account runtime / WorkflowDispatcher
                            ├─ chat → Harness → Tomato / MARU / Trolley / LiteLLM
                            ├─ doc → CanvasFlow → Tomato / LiteLLM
                            ├─ work_sources → WorkSourcesFlow → workbook worker
                            ├─ excel_work → BusinessFlow → LLM planner / QuickJS worker / PDF, HTML, XLSX
                            └─ business tool → BusinessFlow → business worker

Local state → accounts/<email-derived account id>/agent.sqlite
Search data → separate Tomato index and artifacts
Telemetry → durable outbox → service-owned OTLP gateway → Langfuse
```

| Component | Owns | Entry point |
| --- | --- | --- |
| Runtime / dispatcher | Dependency wiring, routing, start/resume/cancel | [runtime.ts](../electron/agent/runtime.ts), [workflows.ts](../electron/agent/workflows.ts) |
| Tool registry | Approved read-only capability catalog, schema validation and bounded execution | [toolRegistry.ts](../electron/agent/toolRegistry.ts), [discoveryTools.ts](../electron/agent/discoveryTools.ts) |
| Harness / policy | Bounded RAG execution / next-action decisions | [harness.ts](../electron/agent/harness.ts), [policy.ts](../electron/agent/policy.ts), [contracts.ts](../electron/agent/contracts.ts) |
| Tomato | Parsing, chunks, indexing, retrieval in a utility process | [tomato/](../electron/tomato/), [tomatoClient.ts](../electron/tomato/tomatoClient.ts) |
| Model client | LiteLLM transport, streaming, usage, cancellation | [modelClient.ts](../electron/agent/modelClient.ts), [liveModelClient.ts](../electron/agent/liveModelClient.ts) |
| Canvas | Reference selection, drafts, edits, document snapshots | [canvas/flow.ts](../electron/agent/canvas/flow.ts) |
| Work sources | Local workbook registration, mapping and extraction | [work/](../electron/work/), [workSourcesFlow.ts](../electron/agent/workSourcesFlow.ts) |
| Business tools | Input cards, checkpoints, worker execution, validated artifacts | [business/](../electron/business/) |
| Renderer | Conversations, input cards, draft editing, run status | [AgentPage.tsx](../src/Pages/AgentPage.tsx), [components/](../src/Features/Agent/components/), [hooks/](../src/Features/Agent/hooks/) |
| Persistence / IPC | Migrations, stored state, process boundary validation | [db/](../electron/db/), [ipc/](../electron/ipc/), [app-types/](../src/app-types/) |

Email authentication and credential provisioning live in `electron/auth/`; see [authentication](AUTHENTICATION.md). Only the active login is encrypted with Electron safeStorage. Temporary broker tokens stay in main-process memory. Account runtimes, SQLite, Tomato indexes, MARU caches, and output folders are isolated; legacy root-level stores are never adopted automatically. IPC calls/events carry a random session ID, and logout drains the old runtime before another account opens. The renderer does not directly access files, databases, or credentials. A workflow owns its lifecycle; a tool performs a bounded operation. MCP is a transport for remote tools, not a workflow engine.

## Run lifecycle

`Workspace → Thread → Run → Message / Step`. A thread has at most one `running` or `waiting_user` run; there is no global execution queue.

- New requests use an explicit mode, `$workflow_id`, or Clef choice-based routing over every registered capability. Explicit selections bypass the model. Routing uses LiteLLM `/v1/systemone` and `LITELLM_ROUTER_MODEL_ALIAS` (default `clef-flash`); generation keeps its existing model. Errors do not silently fall back to another workflow or model.
- Replies to a waiting run return to its persisted owner. A running run rejects another start; Canvas uses dedicated edit/resume actions.
- Waiting state survives restart. Runs interrupted while executing are cancelled at startup, not automatically replayed.
- Each executor owns cancellation and terminal events. The renderer accepts matching run IDs with increasing event sequence numbers.

| Route ID | Stored kind | Executor |
| --- | --- | --- |
| `chat` | `agent` | Harness |
| `doc` | `canvas` | CanvasFlow |
| `work_sources` | `work_sources` | WorkSourcesFlow |
| `daily_cash`, `bank_daily` | Same as route ID | BusinessFlow |
| `excel_work` | `excel_work` | BusinessFlow with model planning and isolated execution |

## RAG, retrieval, and context

The policy proposes `SEARCH`, `ASK`, `VERIFY`, `ANSWER`, or `STOP`; the Harness validates the decision and executes it. Policy code does not own I/O. `llm`, `always-search`, and `gated` strategies share the same execution contracts.

1. Select active collections, recent messages, and confirmed memory.
2. Build policy state, including the registered capability descriptions and schemas, and validate the next action against availability and remaining budget. Provider names are not required in user requests.
3. Execute retrieval or verification, ask for missing information, answer with citations, or stop.
4. Persist observations, usage, evidence, decisions, and the terminal outcome.

`ASK` saves state and exits the loop. Resume restores policy state, remaining budget, and context from trace, plus evidence locators from citations. It continues the same run.

Tomato uses KorDoc parsing, FTS5/BM25, multilingual E5 embeddings, and reciprocal-rank fusion. Keyword search remains available before embeddings are ready. Active collections constrain search; content hashes and parser/chunker fingerprints drive reindexing. Filesystem watchers reconcile missed changes. Vector search uses an in-process HNSW index per collection (`electron/tomato/hnsw.ts`, pure TypeScript, no native dependency): exact flat scan below 2,000 vectors, approximate search above, persisted next to the SQLite index (`hnsw-<collection>.json` + `.f32`) and reconciled against SQLite by content hash on every search. Embeddings never truncate: a chunk longer than the model's 512-token input is split into ≤480-token windows that each repeat the title/breadcrumb header, and the window vectors are pooled by a token-weighted mean into one 384-d unit vector, so the `embeddings` schema is unchanged. The embedding profile string carries the window size; changing it re-embeds every chunk.

Memory selection uses pinned confirmed entries, relevant confirmed entries, then recent messages. Model-proposed memory needs user confirmation. The answer stores a snapshot of applied memory; editing memory later does not rewrite that history. UI message pagination and model context limits are independent.

Answers stream provisionally before final citation validation. A valid citation identifies evidence; it does not prove every claim is correct. Defaults and limits belong in [contracts.ts](../electron/agent/contracts.ts), not a second configuration table here.

## Remote services and observability

- **MARU:** storage browsing/search and authorized document download. Every accessible storage except those turned off in the Files tab (on by default; turned-off ones too when the question mentions MARU) are searched in the same `search_local_docs` step as local collections: the question is reduced to up to three literal keywords, `find_storage` runs per keyword × storage with `include_content`, and about 1,000 characters around the first hit of the best-matching files become citable evidence. MARU matching is literal (ripgrep over files and pre-extracted PDF/Office/HWP text), not semantic. Opening a citation renews the exact document URL, checks HTTPS/origin/size, caches locally, and indexes through Tomato. Signed URLs stay out of prompts and trace.
- **Trolley:** capability checks and Operation listing only. Listing an Operation does not enable its execution.
- **LiteLLM:** configured model transport. It does not own local state or business calculations.
- **Telemetry:** local SQLite remains authoritative. The outbox retries delivery to the service-owned gateway; desktop builds do not contain Langfuse secrets. Content modes are `ops`, `redacted_eval`, and `internal_full`; redaction is not a guarantee that all personal data is removed. Trolley content is excluded from central telemetry.

Generic read-only MCP tools register through `RuntimeOptions.readOnlyMcpServers` with an explicit application-reviewed allowlist. The policy uses `call_tool` with a namespaced ID and schema-validated arguments; MARU/Trolley discovery uses the same executor. All strategies use model selection when tools are registered, so `always-search` and `gated` no longer skip capability selection based on provider-name keywords. This adds policy model calls relative to those fast paths. On failure, the policy can select another suitable tool within the remaining budget; failed tool IDs are excluded for that run. This is bounded replanning, not guaranteed provider equivalence or remote-write failover.

Connection semantics live in [mcp.ts](../electron/agent/mcp.ts); server semantics live in [maru.ts](../electron/agent/maru.ts) and [trolley.ts](../electron/agent/trolley.ts). Telemetry behavior lives in [telemetry.ts](../electron/agent/telemetry.ts) and [telemetry-gateway.ts](../scripts/telemetry-gateway.ts).

## Constraints and unfinished validation

- Local storage does not mean offline operation: selected context reaches LiteLLM, configured telemetry reaches the gateway, and initial embedding downloads require network access.
- Collection selection and workspace IDs are not authorization boundaries. MARU references are persisted per thread; history loading, context reuse, and citation opening recheck remote access. Downloaded MARU indexes (`maru_*`) are excluded from local collection searches; MARU storages are searched remotely instead. Existing on-screen content and user-copied memory/exports cannot be remotely erased. Real broker/MARU group authorization still requires live integration validation.
- Filesystem artifacts and SQLite are not one atomic transaction. Source hashes do not preserve old source content. A model alias does not pin an immutable model checkpoint.
- Outbox delivery is at least once; central deduplication is required. Retry count and outbox storage are not globally bounded. No production throughput, latency SLO, or region-failure guarantee has been established.
- Arbitrary MCP installation UI, user-supplied code/SKILL execution, multi-agent delegation, and generic remote writes are not implemented.
- General tools refactoring is at stage 1: schema-driven read-only registration and intent-based selection. The next stages are a versioned workflow graph/validator, durable node execution, deterministic code generation, and natural-language graph planning. Existing executing runs still cancel on restart; no graph compiler or durable runner is installed.
- External benchmarks own datasets, runners, scoring, and profile promotion. Reproducible evaluation requires a pinned client commit, frozen corpus, profiles, and controlled model responses/checkpoints.
- Signed installers, fresh-install checks, live service authorization, and real financial golden-data validation are separate from local unit tests. Daily Cash's remaining validation is tracked in [business tools](BUSINESS_TOOLS.md#validation-and-demo).


## Experimental Excel work

The Work launcher exposes **엑셀 작업하기** (`excel_work`, v0.4). The planner can inspect file/sheet/cell ranges, execute JavaScript in QuickJS, inspect computed tables, re-read evidence or recalculate, then explicitly finish. Only selected file bytes reach the worker; no guest file, network, shell or module APIs are exposed. Timeouts are 5 seconds per calculation, 30 seconds per worker and 15 minutes per submission. Each resume starts a fresh submission timeout; waiting for user input does not count. See [the evolving plan](../execl%20workflow.md), sections 16–17, for the current contract and remaining limits.

Model previews preserve every sheet identity and compact large samples with an explicit truncation flag. Inspections read the original workbook; older inspection details are evicted as the preview budget fills and can be read again. Identical or fully covered explicit ranges reuse retained observations without worker calls or repair errors. Explicit row bounds exclude matches outside the range. Permission-only generation questions are redirected to execution, while unresolved business criteria can still be clarified. Large preview metadata no longer rejects the workbook or asks users to split files. New job forms hide the revision field until a revision is present.

Range inputs support optional IDs, ending rows, headerless data, multiple regions on one sheet and a subset of selected files. Hidden sheets are labeled rather than discarded. Raw values retain non-midnight timestamps; metadata preserves SSF display formatting, formulas, date serials, direct colors and cell errors. Conditional formatting rules are provided without evaluating their final appearance. Formula caches remain the source of computed formula values; no recalculation engine is included.

BusinessFlow owns file fingerprints, input persistence, cancellation and output validation. The Excel-only editable option accepts waiting chat answers, invalidates stale state on request/file-selection changes, and allows a new run to revise a previous completed result. Existing artifacts stay immutable. Retained source paths whose content changed still fail fingerprint checks. Other deterministic business tools retain their fixed-input behavior.

Reports can include sections, up to 20 tables and 10 bar/line/scatter/pie charts, with optional scatter regression. PDF is static; dashboard HTML permits only the app-authored, CSP-hashed table filter. XLSX charts are native OOXML charts referencing result cells. Up to three PDF/HTML/XLSX files are validated before publication. Selected samples and computed summaries reach the configured model server. Current fixtures validate the runtime, not actual model reasoning quality, business correctness or installed Microsoft Excel compatibility.

Internal plan steps stay in progress/audit data and are omitted from exported files and the chat result preview. Reports retain business assumptions and source evidence.
