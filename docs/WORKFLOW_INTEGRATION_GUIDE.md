# Integration guide

For application maintainers and external tool providers. Current implementation, 2026-10-16. See [architecture](KETCHUPE_V3_ARCHITECTURE.md) for ownership and [business tools](BUSINESS_TOOLS.md) for the Excel contract.

## Choose one extension point

| Need | Implement | Register |
| --- | --- | --- |
| Local XLSX inputs → questions → validated XLSX | `BusinessTool` | [business/registry.ts](../electron/business/registry.ts) |
| A new task with its own stages and persisted resume state | `AgentWorkflow` executor | [runtime.ts](../electron/agent/runtime.ts) |
| A remote lookup used within ordinary chat | Typed MCP adapter + Harness tool | Adapter, tool contract, policy, Harness, runtime |

An MCP endpoint does not automatically appear in routing, policy, or the UI. Only application-shipped implementations are registered. A multi-step Excel task can remain one BusinessTool; it does not need a second workflow executor.

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

Validate inputs and permissions on the server using the authenticated principal, never a model-supplied user ID. Prefer specific operations over arbitrary SQL or code execution. Return machine-readable `structuredContent` consistent with the declared output schema; adapters must handle `isError`, malformed output, and empty results explicitly. The current client reads one `listTools()` response; add pagination support before relying on later pages.

### Wire a lookup into chat

| File / area | Change |
| --- | --- |
| Server adapter + [runtime.ts](../electron/agent/runtime.ts) | Credentials, allowlist, connection lifecycle, availability |
| [tools.ts](../electron/agent/tools.ts) | Typed dependency and validated result |
| [contracts.ts](../electron/agent/contracts.ts) | Decision schema, availability state, observation/source types |
| [policy.ts](../electron/agent/policy.ts) | When to use it, arguments, failure semantics, prompt version |
| [harness.ts](../electron/agent/harness.ts) | Execution, budget, timeout, cancellation, evidence, start/resume context |
| Telemetry + tests | Content policy and behavior for `llm`, `always-search`, and `gated` |

Follow [Trolley](../electron/agent/trolley.ts) or [MARU](../electron/agent/maru.ts). MCP result sanitization limits model context; do not use truncated context as authoritative financial input. BusinessTool workers do not receive runtime MCP clients: remote dependencies require explicit worker-safe wiring or a dedicated workflow.

### Files, long jobs, and writes

- A remote server cannot read a local PC path. Uploads require an explicit data/size/retention contract and implementation. A returned URI is not automatically downloaded; validate metadata, origin, size, hash, authorization, and expiry.
- General Harness tools have a default 30-second wait; BusinessFlow has a 120-second execution limit. Wire deadlines and abort signals in adapters. Disconnecting HTTP does not prove remote cancellation.
- Longer jobs need an explicit start/status/cancel/result API plus persisted job IDs and resume logic. Generic remote-job orchestration is not installed.
- BusinessTool execution restarts after each answer. For remote writes, first design user confirmation, idempotency keys, server deduplication, status lookup, and recovery in a dedicated workflow. MCP annotations are not enforcement.

## Acceptance checks

Verify connection/list/call; valid, empty, denied, malformed, and timeout responses; natural-language and explicit routing; missing-input prompts; same-run resume; restart recovery; cancellation and late results; secret redaction; and domain golden results. Cover file, pagination, and remote-job boundaries when present. A successful probe proves connectivity, not business correctness.

Run focused tests for the changed integration, then applicable project checks from the [README](../README.md). Existing examples: [workflows.test.ts](../electron/agent/workflows.test.ts), [router.test.ts](../electron/agent/router.test.ts), [trolley.test.ts](../electron/agent/trolley.test.ts), and [business/flow.test.ts](../electron/business/flow.test.ts).
