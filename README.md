# KetchupE v3.0

An Electron desktop app that runs local document search, grounded answers, document drafting and Excel tasks in a single conversation. **Workflows manage a task's progress, input waits, resumption and completion; tools perform the actual work such as search, lookup and calculation.**

This document is the entry point to the current code (2026-11-09). v3.0 names the architecture and is separate from the release version in `package.json`.

## What it does

| Workflow ID / stored kind | Capability                                                                                                  | Executor                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `chat` / same | Answers general questions and revises supplied text without retrieval | `ChatWorkflow` (answer / handoff) |
| `rag` / `agent` | Answers with citations from local documents and connected MCP servers | `ChatWorkflow` (retrieval and tools) |
| `doc` / `canvas`          | Reference search → draft → review and edit → finalize                                                       | `CanvasFlow`                       |
| `work_sources` / same     | Connects local XLSX sources, maps columns and validates extraction                                          | `WorkSourcesFlow`                  |
| `daily_cash` / same       | Checks and reconciles sources, then produces the daily cash report XLSX and PNG                             | `BusinessFlow` + `dailyCashTool`   |
| `excel_work` / same       | Experimental: analyzes one or more workbooks from a natural-language request and produces PDF, HTML or XLSX | `BusinessFlow` + `createExcelTool` |

Clef-flash routes natural-language requests using each registered capability's description, examples, required inputs, and recent user/assistant messages with their workflow kinds. General questions use `chat`; requests needing document or service evidence use `rag`. Dedicated workflows take priority for execution, while Excel tasks without a dedicated workflow use the interactive `excel_work` executor. You can also select one explicitly with `$doc`, `$daily_cash` or `$work_sources`. The Work tab holds shortcuts to the main capabilities. **Contract drafting starts with the question "Which contract would you like help drafting?" and runs only after the user answers.**

Above the input box you can see running and waiting tasks, and continue, stop, or correct the selected task with **작업 변경**. Corrections keep the same request and history; the previous executor stops before a replacement starts. For the daily cash report, an input card in the conversation confirms source files and reference values, and asks any follow-up questions. Code performs the calculations, and only results that pass validation are delivered. See the [daily cash documentation](docs/BUSINESS_TOOLS.md#daily-cash) for detailed business rules and open items.

## Architecture

```text
React UI → typed preload IPC → request Harness (created by the account runtime)
                               ├─ chat → ChatWorkflow → LiteLLM
                               ├─ rag → ChatWorkflow → Tomato / MARU / Trolley / LiteLLM
                               ├─ doc → CanvasFlow → Tomato / LiteLLM
                               ├─ work_sources → source connection and mapping / workbook worker
                               ├─ excel_work → BusinessFlow → LLM planner / QuickJS worker / PDF, HTML, XLSX
                               └─ business tool → BusinessFlow → business worker

Product state and run history → local SQLite
Observability → telemetry outbox → service-owned OTLP gateway → Langfuse
```

- **Tomato**: parses, chunks and indexes folders, and provides FTS5 and vector search. Vector search uses an in-process HNSW (ANN) index per collection; long chunks are split into windows that fit the model's 512-token limit and pooled into one vector. Keyword search is used until embeddings are ready. Local folders, rclone-synced folders and Notion exports are treated as the same kind of collection.
- **Runtime**: supplies account-scoped databases, model clients, tools, workers and shutdown.
- **Harness**: owns the request before routing, invokes Clef, starts/resumes/cancels registered workflows and validates bounded handoffs. A request can switch at most twice without revisiting a workflow; source writes cannot be replayed by switching.
- **ChatWorkflow**: validates `SEARCH / ASK / VERIFY / ANSWER / STOP / HANDOFF`, manages evidence and domain budgets, and yields workflow changes to the Harness. General chat skips retrieval but can request a handoff when the original route was wrong.
- **Canvas**: keeps reference-template selection and document editing as separate state. Document versions are stored as full snapshots with undo/redo.
- **BusinessFlow**: shared handling of input cards, pinned source hashes and tool versions, follow-up questions and checkpoints, worker execution, output validation and result storage.
- **LiteLLM**: talks to the configured model server. It does not own app state, the database or business calculations.

Work is organized as `Workspace → Thread → Run → Message / Step`. A conversation has at most one `running` or `waiting_user` run. After an input wait the same run resumes; a new request after completion starts a new run. On restart, waiting tasks are restored and tasks that were executing are cancelled. Generic automatic re-execution and exactly-once processing are not guaranteed.

## Development

Requires Node.js **22.5 or later** (`node:sqlite`). Uses React 19, TypeScript, Vite 6 and Electron 39. [package.json](package.json) and the lockfile are the source of truth for exact dependency versions.

```bash
npm install
npm run dev                  # Vite + Electron
npm run build                # TypeScript checks + bundle
npm run build:electron       # package installers
npx vitest run               # run tests once
npm run typecheck:electron
```

After company email authentication, the app receives per-user LiteLLM and MARU keys from the credential broker. Development runs use the same login; shared service keys are never injected into the app. See [authentication and credentials](docs/AUTHENTICATION.md) for authentication, storage, account isolation and operational checks.

App model names are configured in `llm.config.yaml`, not `.env`. Use `.env` only for optional service settings and standalone diagnostic scripts (see `.env.sample`). App LiteLLM/MARU credentials come from email authentication. Never commit API keys or tokens.

```dotenv
# 모델 선택은 llm.config.yaml에서 설정합니다.
TROLLEY_API_KEY=<optional service user key>
TROLLEY_MCP_ENDPOINT=https://trolley.ml2-alpha.com/mcp/
```

Only the standalone diagnostic scripts below use `LITELLM_API_KEY`/`LITELLM_BASE_URL` and `MARU_API_TOKEN`/`MARU_MCP_ENDPOINT`. These values do not affect app login or connections.

```bash
npm run smoke:litellm
npm run probe:maru
npm run probe:trolley
```

Model names are configured in `llm.config.yaml`: `decision.default: clef-flash`, `generation.default: loki`, and `generation.document: loki`. Existing Clef routing keeps `/v1/systemone`; all chat API calls (including policy, verification and Excel planning) use generation, with Canvas using document. Both roles use only the logged-in broker URL/key. Missing document overrides use generation.default; unknown configuration keys/categories fail validation. Failed model requests never switch models. YAML is bundled into Electron main: restart development or rebuild the release after editing it.

To switch accounts, log out and authenticate again. MARU currently supports storage browsing and search with cited content, plus document download and indexing; Trolley supports capability and Operation listing. Trolley Operation execution is not connected. Follow the [integration guide for external teams](docs/WORKFLOW_INTEGRATION_GUIDE.md) to connect a new MCP server.

## Finding code

| To change                                  | Start at                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow routing and registration          | [router.ts](electron/agent/router.ts), [workflows.ts](electron/agent/workflows.ts), [runtime.ts](electron/agent/runtime.ts)                                   |
| RAG decisions, execution and evidence      | [policy.ts](electron/agent/policy.ts), [chatWorkflow.ts](electron/agent/chatWorkflow.ts), [tools.ts](electron/agent/tools.ts)                                           |
| MCP connections and per-server adapters    | [mcp.ts](electron/agent/mcp.ts), [maru.ts](electron/agent/maru.ts), [trolley.ts](electron/agent/trolley.ts)                                                   |
| Document drafting and editing              | [canvas/flow.ts](electron/agent/canvas/flow.ts)                                                                                                               |
| Adding an Excel business task              | [business/contracts.ts](electron/business/contracts.ts), [business/registry.ts](electron/business/registry.ts), [business/flow.ts](electron/business/flow.ts) |
| Natural-language Excel work (`excel_work`) | [excel/](electron/excel/), [excel.worker.ts](electron/workers/excel.worker.ts)                                                                                |
| Search and source file handling            | [tomato/](electron/tomato/), [work/](electron/work/), [workers/](electron/workers/)                                                                           |
| Conversation, task state and input cards   | [AgentPage.tsx](src/Pages/AgentPage.tsx), [Agent components](src/Features/Agent/components/), [Agent hooks](src/Features/Agent/hooks/)                        |
| Database, IPC and observability            | [db/](electron/db/), [ipc/](electron/ipc/), [telemetry.ts](electron/agent/telemetry.ts)                                                                       |

## Data and operational boundaries

- `agent.sqlite` is the source of truth for conversations, runs, memory, traces and business inputs. Tomato manages its own index and artifacts. The renderer never accesses files, the database or keys directly; it uses typed IPC.
- Local storage does not mean fully offline. Selected evidence and conversations go to LiteLLM, and observability data goes to the OTLP gateway according to the configured content mode. The first embedding model download also needs network access.
- Business source XLSX files are read locally and never modified. Validated results are saved as new files in `userData/accounts/<account id>/business-output`. Keeping copies of sources and automatically cleaning up result files when a conversation is deleted are not currently guaranteed.
- Search collection selection is not an ACL. Access is rechecked when a conversation that used MARU documents is loaded or reused, and when a cited original is opened. Content already shown on screen, or copied or exported by the user, cannot be remotely erased.
- Central collection uses [telemetry-gateway.ts](scripts/telemetry-gateway.ts). The desktop app contains no Langfuse secret. The default `ops` mode HMACs free text and identifiers but does not guarantee removal of all personal data.
- There is no automatic installation of arbitrary MCP servers, no external code or SKILL execution, no multi-agent delegation and no global execution queue. Installer signing, fresh-install verification and external benchmark evaluation and promotion are separate scopes.

## Documentation

| Purpose                                            | Guide                                                         |
| -------------------------------------------------- | ------------------------------------------------------------- |
| Architecture, lifecycle, code map, limitations     | [Architecture and code map](docs/KETCHUPE_V3_ARCHITECTURE.md) |
| Add a workflow or connect an external MCP provider | [Integration guide](docs/WORKFLOW_INTEGRATION_GUIDE.md)       |
| Excel execution contract and Daily Cash rules      | [Business tools and Daily Cash](docs/BUSINESS_TOOLS.md)       |
| Natural-language Excel work design and status      | [Excel work plan](execl%20workflow.md)                        |

## License

MIT
