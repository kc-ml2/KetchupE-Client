# Architecture and code map

Current implementation, 2026-10-16. “v3” names the architecture; the release version lives in [package.json](../package.json).

KetchupE is an Electron desktop app for local document search, grounded answers, document drafting, and deterministic Excel tasks. Start with the [README](../README.md) for setup, the [integration guide](WORKFLOW_INTEGRATION_GUIDE.md) to add capabilities, or [business tools](BUSINESS_TOOLS.md) for Excel contracts and Daily Cash rules. Type definitions and tests are the source of truth; this document does not duplicate their schemas.

## Execution boundaries

```text
React → typed preload IPC → Electron main / WorkflowDispatcher
                            ├─ chat → Harness → Tomato / MARU / Trolley / LiteLLM
                            ├─ doc → CanvasFlow → Tomato / LiteLLM
                            ├─ work_sources → WorkSourcesFlow → workbook worker
                            └─ business tool → BusinessFlow → business worker

Local state → agent.sqlite
Search data → separate Tomato index and artifacts
Telemetry → durable outbox → service-owned OTLP gateway → Langfuse
```

| Component | Owns | Entry point |
| --- | --- | --- |
| Runtime / dispatcher | Dependency wiring, routing, start/resume/cancel | [runtime.ts](../electron/agent/runtime.ts), [workflows.ts](../electron/agent/workflows.ts) |
| Harness / policy | Bounded RAG execution / next-action decisions | [harness.ts](../electron/agent/harness.ts), [policy.ts](../electron/agent/policy.ts), [contracts.ts](../electron/agent/contracts.ts) |
| Tomato | Parsing, chunks, indexing, retrieval in a utility process | [tomato/](../electron/tomato/), [tomatoClient.ts](../electron/tomato/tomatoClient.ts) |
| Model client | LiteLLM transport, streaming, usage, cancellation | [modelClient.ts](../electron/agent/modelClient.ts), [liveModelClient.ts](../electron/agent/liveModelClient.ts) |
| Canvas | Reference selection, drafts, edits, document snapshots | [canvas/flow.ts](../electron/agent/canvas/flow.ts) |
| Work sources | Local workbook registration, mapping and extraction | [work/](../electron/work/), [workSourcesFlow.ts](../electron/agent/workSourcesFlow.ts) |
| Business tools | Input cards, checkpoints, worker execution, validated artifacts | [business/](../electron/business/) |
| Renderer | Conversations, input cards, draft editing, run status | [AgentPage.tsx](../src/Pages/AgentPage.tsx), [components/](../src/Features/Agent/components/), [hooks/](../src/Features/Agent/hooks/) |
| Persistence / IPC | Migrations, stored state, process boundary validation | [db/](../electron/db/), [ipc/](../electron/ipc/), [app-types/](../src/app-types/) |

The renderer does not directly access files, databases, or credentials. A workflow owns its lifecycle; a tool performs a bounded operation. MCP is a transport for remote tools, not a workflow engine.

## Run lifecycle

`Workspace → Thread → Run → Message / Step`. A thread has at most one `running` or `waiting_user` run; there is no global execution queue.

- New requests use an explicit mode, `$workflow_id`, or Clef choice-based routing over every registered capability. Explicit selections bypass the model. Routing uses LiteLLM `/v1/systemone` and `LITELLM_ROUTER_MODEL_ALIAS` (default `clef`); generation keeps its existing model. Errors do not silently fall back to another workflow or model.
- Replies to a waiting run return to its persisted owner. A running run rejects another start; Canvas uses dedicated edit/resume actions.
- Waiting state survives restart. Runs interrupted while executing are cancelled at startup, not automatically replayed.
- Each executor owns cancellation and terminal events. The renderer accepts matching run IDs with increasing event sequence numbers.

| Route ID | Stored kind | Executor |
| --- | --- | --- |
| `chat` | `agent` | Harness |
| `doc` | `canvas` | CanvasFlow |
| `work_sources` | `work_sources` | WorkSourcesFlow |
| `daily_cash`, `bank_daily` | Same as route ID | BusinessFlow |

## RAG, retrieval, and context

The policy proposes `SEARCH`, `ASK`, `VERIFY`, `ANSWER`, or `STOP`; the Harness validates the decision and executes it. Policy code does not own I/O. `llm`, `always-search`, and `gated` strategies share the same execution contracts.

1. Select active collections, recent messages, and confirmed memory.
2. Build policy state and validate the next action against availability and remaining budget.
3. Execute retrieval or verification, ask for missing information, answer with citations, or stop.
4. Persist observations, usage, evidence, decisions, and the terminal outcome.

`ASK` saves state and exits the loop. Resume restores policy state, remaining budget, and context from trace, plus evidence locators from citations. It continues the same run.

Tomato uses KorDoc parsing, FTS5/BM25, multilingual E5 embeddings, and reciprocal-rank fusion. Keyword search remains available before embeddings are ready. Active collections constrain search; content hashes and parser/chunker fingerprints drive reindexing. Filesystem watchers reconcile missed changes. Vector search uses an in-process HNSW index per collection (`electron/tomato/hnsw.ts`, pure TypeScript, no native dependency): exact flat scan below 2,000 vectors, approximate search above, persisted next to the SQLite index (`hnsw-<collection>.json` + `.f32`) and reconciled against SQLite by content hash on every search. Embeddings never truncate: a chunk longer than the model's 512-token input is split into ≤480-token windows that each repeat the title/breadcrumb header, and the window vectors are pooled by a token-weighted mean into one 384-d unit vector, so the `embeddings` schema is unchanged. The embedding profile string carries the window size; changing it re-embeds every chunk.

Memory selection uses pinned confirmed entries, relevant confirmed entries, then recent messages. Model-proposed memory needs user confirmation. The answer stores a snapshot of applied memory; editing memory later does not rewrite that history. UI message pagination and model context limits are independent.

Answers stream provisionally before final citation validation. A valid citation identifies evidence; it does not prove every claim is correct. Defaults and limits belong in [contracts.ts](../electron/agent/contracts.ts), not a second configuration table here.

## Remote services and observability

- **MARU:** storage browsing/search and authorized document download. The adapter renews the exact document URL, checks HTTPS/origin/size, caches locally, and indexes through Tomato. Signed URLs stay out of prompts and trace.
- **Trolley:** capability checks and Operation listing only. Listing an Operation does not enable its execution.
- **LiteLLM:** configured model transport. It does not own local state or business calculations.
- **Telemetry:** local SQLite remains authoritative. The outbox retries delivery to the service-owned gateway; desktop builds do not contain Langfuse secrets. Content modes are `ops`, `redacted_eval`, and `internal_full`; redaction is not a guarantee that all personal data is removed. Trolley content is excluded from central telemetry.

Connection semantics live in [mcp.ts](../electron/agent/mcp.ts); server semantics live in [maru.ts](../electron/agent/maru.ts) and [trolley.ts](../electron/agent/trolley.ts). Telemetry behavior lives in [telemetry.ts](../electron/agent/telemetry.ts) and [telemetry-gateway.ts](../scripts/telemetry-gateway.ts).

## Constraints and unfinished validation

- Local storage does not mean offline operation: selected context reaches LiteLLM, configured telemetry reaches the gateway, and initial embedding downloads require network access.
- Collection selection and workspace IDs are not authorization boundaries. MARU checks remote access, but credential changes and revoked access are not yet enforced across all local history, resume, and citation reuse paths. Cross-user isolation and revocation need end-to-end validation before shared deployment.
- Filesystem artifacts and SQLite are not one atomic transaction. Source hashes do not preserve old source content. A model alias does not pin an immutable model checkpoint.
- Outbox delivery is at least once; central deduplication is required. Retry count and outbox storage are not globally bounded. No production throughput, latency SLO, or region-failure guarantee has been established.
- Arbitrary MCP installation, user-supplied code/SKILL execution, multi-agent delegation, and generic remote writes are not implemented.
- External benchmarks own datasets, runners, scoring, and profile promotion. Reproducible evaluation requires a pinned client commit, frozen corpus, profiles, and controlled model responses/checkpoints.
- Signed installers, fresh-install checks, live service authorization, and real financial golden-data validation are separate from local unit tests. Daily Cash's remaining validation is tracked in [business tools](BUSINESS_TOOLS.md#validation-and-demo).
