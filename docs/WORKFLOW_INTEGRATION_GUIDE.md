# Integration guide

For application maintainers and external tool providers. Current implementation, 2026-10-26. See [architecture](KETCHUPE_V3_ARCHITECTURE.md) for ownership and [business tools](BUSINESS_TOOLS.md) for the Excel contract.

## Choose one extension point

| Need | Implement | Register |
| --- | --- | --- |
| Local XLSX inputs → questions → validated XLSX | `BusinessTool` | [business/registry.ts](../electron/business/registry.ts) |
| A new task with its own stages and persisted resume state | `AgentWorkflow` executor | [runtime.ts](../electron/agent/runtime.ts) |
| A read-only remote lookup used within ordinary chat | MCP schema + approved tool allowlist | `RuntimeOptions.readOnlyMcpServers` / `ToolRegistry.registerMcp` |

Only application-approved connections and tools are registered. Their descriptions and schemas enter the chat policy catalog automatically; users do not need to name the MCP provider. There is no arbitrary-server installation UI. A multi-step Excel task can remain one BusinessTool; it does not need a second workflow executor.

## Add a workflow

The exact types are [AgentWorkflow](../electron/agent/workflows.ts), [WorkflowRoute](../electron/agent/router.ts), and [RunHandle](../electron/agent/runLifecycle.ts).

1. Choose a unique route `id` and persisted `kind`. Provide a description, examples, and required inputs for routing.
2. Implement `start`, optional text `resume`, and `cancel`. Return a handle with `runId` and `done`. Collect missing inputs before executing.
3. Persist the run, messages, stage, and versioned resume payload. A waiting task must resume from the DB without a live Promise.
4. Register the executor in runtime and wire credentials, shutdown, cancellation, and telemetry filtering.
5. Reuse the existing chat UI for text questions. Structured actions require coordinated changes to shared types, IPC, preload, renderer API, and components. Add a launcher shortcut only if useful.

| Transition | Required behavior |
| --- | --- |
| Start | Create the run, user message, and start trace |
| Wait | Persist question and resume state; set `waiting_user`; emit `ask_user` |
| Resume | Validate owner/status/input, save the reply, set `running` |
| Complete | Save result with source/time, terminal state, trace, and event |
| Fail or cancel | Abort active work or terminate waiting state; persist and emit the outcome |

Use one AbortController per run, increasing event sequence numbers, duplicate-resume protection, and guards against late results after termination. Handle asynchronous errors inside the executor. Never persist tokens or signed URLs in messages, checkpoints, or trace. Refer to [WorkSourcesFlow](../electron/agent/workSourcesFlow.ts) for input persistence and [Harness](../electron/agent/harness.ts) for asynchronous execution.

## Connect an MCP provider

The provider owns domain logic, schemas, and server-side authorization. KetchupE owns conversation state, user questions, routing, and result presentation.

The current [McpConnection](../electron/agent/mcp.ts) uses Streamable HTTP, a separate client per server, a Bearer-token callback, and an explicit tool allowlist. There is no generic OAuth login or arbitrary-server installation UI. Compatibility is determined by the lockfile and integration tests.

The provider should deliver:

| Contract | Required information |
| --- | --- |
| Operations | Owner, development/production endpoint including trailing slash, deployed version, support contact |
| Authentication | Credential issuance, expiry/revocation, authenticated principal and access scope; deliver secrets separately |
| Schema | Stable names, input/output JSON Schema, business/schema version, currency/units, timezone, rounding |
| Examples | Valid, empty, invalid-input, denied, and temporary-failure responses; reproducible test data |
| Lifecycle | Timeout, cancellation semantics, rate/size limits, pagination/truncation, retry and duplicate handling |
| Results | Source and as-of time; file metadata, authenticated download, expiry and retention if applicable |
| Compatibility | Breaking-change notice and retirement policy |

Validate inputs and permissions on the server using the authenticated principal, never a model-supplied user ID. Prefer specific operations over arbitrary SQL or code execution. Return machine-readable `structuredContent` consistent with the declared output schema; adapters must handle `isError`, malformed output, and empty results explicitly. The client follows `listTools()` pagination and rejects repeated cursors.

### Wire a lookup into chat

Use [ToolRegistry](../electron/agent/toolRegistry.ts) for read-only tools. The registry validates JSON Schema inputs and declared outputs, propagates deadlines/cancellation, and keeps complete execution data separate from the bounded summary shown to the model. It reuses the MCP SDK's JSON Schema validator.

For another MCP server, supply an account-scoped `McpServerConfig` through `RuntimeOptions.readOnlyMcpServers`, including an explicit `allowedTools` list reviewed by the application as read-only. Credentials remain in the token callback. Discovery publishes namespaced IDs (`server/tool`), descriptions and schemas; adding a provider does not require new policy or Harness branches. Server annotations do not grant permission. Discovery failures omit that connection's unavailable capabilities; the application logs discovery failure without remote error bodies. Startup discovers once; configuration changes require a new account runtime.

For an application-shipped local lookup, call `ToolRegistry.register` with the same descriptor and an `execute` implementation. Pass the registry to the Harness. Generic results use `data` for complete execution values and `summary` for bounded, credential-free model context. MCP results produce this summary through `sanitizeMcpResult`; local adapters own their summary contract. Full data is not automatically persisted or inserted into prompts.

[discoveryTools.ts](../electron/agent/discoveryTools.ts) registers MARU and Trolley adapters. Provider-specific downloads, document access checks and citation conversion remain specialized. The legacy policy tool names are accepted for compatibility, while new calls use:

```json
{"action":"SEARCH","search":{"tool":"call_tool","toolId":"catalog/find_products","arguments":{"query":"pump"}}}
```

This illustrates the search payload; decisions still require the other fields in `PolicyDecisionSchema`.

All policy strategies defer to model selection when registered tools exist, including requests with no provider name. A failed lookup becomes a tool-error observation and is excluded for the rest of that run; the next policy step may select another suitable read-only tool within the remaining budget. Invalid arguments remain repairable. This is model replanning, not a guarantee that two providers have equivalent datasets. The policy must preserve explicit source scope, avoid bypassing denied access, and explain incomplete results. No writes are exposed and no failed call is automatically retried by the registry.

Tool arguments, results and derived final answers from generic calls are excluded from central telemetry even in internal content mode. Local policy traces still contain the decision arguments: do not put credentials or signed URLs in arguments. Use connection authentication and opaque references instead.

BusinessTool workers do not receive runtime MCP clients: remote dependencies require explicit worker-safe wiring or a dedicated workflow.

### Files, long jobs, and writes

- A remote server cannot read a local PC path. Uploads require an explicit data/size/retention contract and implementation. A returned URI is not automatically downloaded; validate metadata, origin, size, hash, authorization, and expiry.
- General Harness tools have a default 30-second wait; BusinessFlow has a 120-second execution limit. Wire deadlines and abort signals in adapters. Disconnecting HTTP does not prove remote cancellation.
- Longer jobs need an explicit start/status/cancel/result API plus persisted job IDs and resume logic. Generic remote-job orchestration is not installed.
- BusinessTool execution restarts after each answer. For remote writes, first design user confirmation, idempotency keys, server deduplication, status lookup, and recovery in a dedicated workflow. MCP annotations are not enforcement.

## Acceptance checks

Verify connection/list/call; valid, empty, denied, malformed, and timeout responses; natural-language and explicit routing; missing-input prompts; same-run resume; restart recovery; cancellation and late results; secret redaction; and domain golden results. Cover file, pagination, and remote-job boundaries when present. A successful probe proves connectivity, not business correctness.

Run focused tests for the changed integration, then applicable project checks from the [README](../README.md). Existing examples: [workflows.test.ts](../electron/agent/workflows.test.ts), [router.test.ts](../electron/agent/router.test.ts), [trolley.test.ts](../electron/agent/trolley.test.ts), and [business/flow.test.ts](../electron/business/flow.test.ts).


## Experimental generated Excel analysis

`excel_work` is registered in runtime through `createExcelTool`, using BusinessFlow's existing input and artifact lifecycle. Its model client remains in main; parsing, guest code, HTML and XLSX exports run in `excel.worker.ts`. PDF export uses an app-owned template and an isolated renderer. Do not register generated code in `business/registry.ts` or run it in the Node/Electron host.

Business fields now support `select` with app-defined options. An optional `validateOutput` callback explicitly opts a tool into HTML/PDF output; XLSX outputs still go through workbook validation, and non-XLSX artifacts can never replace an original source. The progress callback is host-only and must not be serialized to a worker. Keep secrets out of report checkpoints and use source fingerprints when resuming exports.
