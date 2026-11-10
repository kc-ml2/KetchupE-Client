# Architecture and code map

Current implementation, 2026-11-10. “v3” names the architecture; the release version lives in [package.json](../package.json).

KetchupE is an Electron desktop app for local document search, grounded answers, document drafting, deterministic Excel tasks, and experimental LLM-planned Excel analysis. Start with the [README](../README.md) for setup, the [integration guide](WORKFLOW_INTEGRATION_GUIDE.md) to add capabilities, or [business tools](BUSINESS_TOOLS.md) for Excel contracts and Daily Cash rules. Type definitions and tests are the source of truth; this document does not duplicate their schemas.

## Execution boundaries

```text
React → email authentication → session-bound preload IPC → request Harness (runtime wires dependencies)
                            ├─ chat → ChatWorkflow answer / handoff → LiteLLM
                            ├─ rag → ChatWorkflow → Tomato / MARU / Trolley / LiteLLM
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
| Runtime | Account resources, dependency wiring, shutdown | [runtime.ts](../electron/agent/runtime.ts) |
| Harness | Request identity, routing, start/resume/cancel, bounded workflow handoffs | [harness.ts](../electron/agent/harness.ts), [workflows.ts](../electron/agent/workflows.ts) |
| Tool registry | Approved read-only capability catalog, schema validation and bounded execution | [toolRegistry.ts](../electron/agent/toolRegistry.ts), [discoveryTools.ts](../electron/agent/discoveryTools.ts) |
| ChatWorkflow / policy | General answers, bounded RAG execution and handoff proposals | [chatWorkflow.ts](../electron/agent/chatWorkflow.ts), [policy.ts](../electron/agent/policy.ts), [contracts.ts](../electron/agent/contracts.ts) |
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

- New requests use an explicit mode, `$workflow_id`, or Clef choice-based routing over every registered capability. Explicit selections bypass the model. Routing uses LiteLLM `/v1/systemone` and `LITELLM_ROUTER_MODEL_ALIAS` (default `clef-flash`); generation keeps its existing model. Routing errors do not fall back to another workflow or model. Generation requests rejected with an invalid-model HTTP 400/404 refresh the same account’s `/models` list and try at most two alternatives, preferring `ketchupe`, `loki` (case preserved), then `odin`, and excluding Clef and known non-chat aliases. Other errors and partial streams are never replayed across models. The successful model is recorded in usage; model failures display a friendly retry message.
- Replies to a waiting run return to its persisted owner. A running run rejects another start; Canvas uses dedicated edit/resume actions.
- Waiting state survives restart. Runs interrupted while executing are cancelled at startup, not automatically replayed.
- Each executor owns cancellation and terminal events. The renderer accepts matching run IDs with increasing event sequence numbers.

| Route ID | Stored kind | Executor |
| --- | --- | --- |
| `routing` | `routing` | Harness authorization and initial routing; cancellable before executor selection |
| `chat` | `chat` | ChatWorkflow answer or handoff; no retrieval in this executor |
| `rag` | `agent` | ChatWorkflow retrieval and read-only tools (also owns legacy agent runs) |
| `doc` | `canvas` | CanvasFlow |
| `work_sources` | `work_sources` | WorkSourcesFlow |
| `daily_cash` | Same as route ID | BusinessFlow |
| `excel_work` | `excel_work` | BusinessFlow with model planning and isolated execution |

## Request ownership and workflow correction

Runtime creates the Harness and domain executors once per account. The Harness controls execution: it creates a `routing` run and its user message synchronously, then authorizes context and invokes Clef. Executors adopt that same run through `startWorkflowRun`; they never create a second request or duplicate the initial message. Routing has its own trace spans and 30-second timeout. It is cancellable with the same run ID as later execution. Routing spans record duration and alias; the choice endpoint does not currently provide token usage to this client.

ChatWorkflow can yield a schema-validated `HANDOFF` before answering, including after a retrieval observation or a resumed clarification. The Harness validates the destination, preserves the original goal and history, and starts the registered replacement. Domain input forms and validation remain mandatory. Tool/network/authentication failures never trigger automatic workflow fallback.

The **작업 변경** control lets a user correct any running or waiting workflow, including Canvas and BusinessFlow. The old executor is cancelled and drained before the correction is classified (or its explicit `$workflow_id` is applied). A correction is appended to history and the new executor receives the original goal plus that correction. Failed correction routing leaves a failed request with its history intact; it does not replay the old executor. Structured edits and submissions are blocked during transfer, and old action IDs are invalidated. Completed runs cannot be switched. Once an original-file write begins, switching is refused; no rollback of external effects is implied.

A request may switch at most twice and cannot revisit a selected workflow. The selected-workflow trace persists this limit across restarts. Each executor keeps its own domain budget; routing is separately timed and workflow transitions are bounded. This is correction of a misrouted request, not a general workflow graph or automatic multi-task composition engine.

All executor events pass through the Harness, which assigns one increasing renderer sequence per request. `workflow_changed` moves the UI between text/input-card and Canvas views, clearing stale streaming text and controls. Multiple trace writers allocate sequence numbers from SQLite. Any locally restricted stage keeps the combined request out of central telemetry; tool-derived handoff reasons are omitted and other reasons follow the configured content mode.

## RAG, retrieval, and context

Clef separates general answers, evidence-based lookups, and execution requests. Routing receives up to six recent user/assistant messages (2,000 characters each) with persisted workflow kinds; result filenames already present in assistant messages remain in that context. `chat` uses a general-knowledge answer prompt and no retrieval. With the application workflow catalog it first chooses ANSWER or HANDOFF through the generation model, allowing a wrong chat selection to reach RAG or another executor. Bare greetings and standalone clients without a workflow catalog keep the direct-answer path. `rag` retains the grounded-answer prompt and the bounded ChatWorkflow loop. Catalog-enabled execution uses model selection even under fixed/gated policy variants; this adds policy calls compared with those standalone fast paths. Explicit `$chat` and `$rag` select these paths directly; persisted `agent` runs still resume through `rag`.

Dedicated execution workflows take precedence. Excel execution requests without a dedicated workflow go to `excel_work`, which collects files and clarifies calculation criteria. Planning-only discussion stays in `chat`. This uses the current editable Excel executor; saving, scheduling, or registering user-created workflows is not implemented.

The policy proposes `SEARCH`, `ASK`, `VERIFY`, `ANSWER`, `STOP`, or `HANDOFF`; ChatWorkflow validates the decision, executes local actions, and yields handoffs to the request Harness. Policy code does not own I/O. `llm`, `always-search`, and `gated` strategies share the same execution contracts.

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

Reports can include sections, up to 20 tables and 10 bar/line/scatter/pie charts, with optional scatter regression. PDF is static; dashboard HTML permits only the app-authored, CSP-hashed table filter. XLSX charts are native OOXML charts referencing result cells. PDF/HTML/XLSX/PNG/PPTX outputs are validated before publication (up to 14 files including chart/page PNG previews, 20MiB per file and 60MiB total). Selected samples and computed summaries reach the configured model server. Current fixtures validate the runtime, not actual model reasoning quality, business correctness or installed Microsoft Excel compatibility.

Internal plan steps stay in progress/audit data and are omitted from exported files and the chat result preview. Reports retain business assumptions and source evidence.

3.0.19 adds a structured `chart` plan compiled into a fixed QuickJS program. HTML/PDF render the full numeric X series with independent left/right Y axes, preserved acquisition order, and breaks at missing measurements. Chart datasets are separate from visible report tables; the common Excel limits are in [limits.ts](../electron/excel/limits.ts): 20,000 input rows/line points, 5,000 table rows, and 500 bar/pie points, with separate serialized-size and execution budgets. Advanced chart datasets/dual axes are explicitly rejected for XLSX; legacy native XLSX charts remain supported.

Clarification keys increase beyond `answer3`; only the pending question is added to the input card. Up to 12 question/answer records retain correction history in the checkpoint. The legacy duplicate-key reader applies current input only to the last matching question. A fully specified option can execute without another model call, while free-text revisions use the small revision interpreter described below. New revisions cannot finish from an old computed summary.

Consecutive source IDs/worksheet rows share compact provenance ranges. Completed checkpoints contain a plan and bounded result summary, not the full dataset. Fixed chart plans can be replayed after export failure only after source checks; arbitrary generated code retains its small result snapshot instead because replay could change nondeterministic calculations. Exact-query profiles can be reused, and the initial model preview is limited to 20,000 characters with higher priority for named sheets and an inventory of every sheet. Explicit inspection still reads the original data.

BusinessFlow records local-only phase durations, attempts, model alias/usage/finish reason, row count and error codes through a strict trace callback. A truncated model response is distinguished from a contract error. See [the implementation and validation record](EXCEL_WORK_ISSUES_AND_IMPROVEMENT_PLAN.md#11-구현-및-검증-기록-2026-11-10) for the actual TGA worker and live-model measurements and remaining limits.


### 3.0.20 result revisions and image exports

Chart display settings live in a separate cumulative `view`, not in the sandbox's `chartSpec`. The small revision interpreter receives only chart identities, confirmed view, the current utterance and pending questions; it returns a bounded display patch, a question, an unsupported explanation or an explicit calculation-change decision. Only calculation changes enter the full planner. Format-only form changes need no model. Partial resolved settings survive questions, and successful view changes survive subsequent runs and restarts.

No new snapshot store is added. Completed checkpoints retain the calculation plan/chartRequest, view and a result hash. QuickJS freezes Date to the plan's execution timestamp and random to a fixed seed. Replays recheck source fingerprints and the complete result hash before publication; legacy arbitrary code without replay metadata is not silently replayed. This checks reproducibility, not business correctness. The last valid chartRequest survives failed candidate execution.

PNG previews and downloadable images share the same verified artifact. Chromium captures the shared SVG after a second paint; bounded table reports use PDF page images. PptxGenJS places those images in slides with editable titles and descriptions. The UI groups artifacts by result revision, preserves the last preview while processing, displays applied changes, and sends an explicit artifact ID when revising an older result. BusinessFlow verifies that the selected artifact belongs to the same thread and completed workflow. The existing checkpoint and audit JSON store version metadata without a DB schema migration.

See [implementation and measurements](EXCEL_REVISION_HITL_AND_EXPORT_PLAN.md#11-3020-구현-및-검증-기록-2026-11-10) for scope, replay compatibility, live TGA revision timings and remaining Windows/PowerPoint validation.
