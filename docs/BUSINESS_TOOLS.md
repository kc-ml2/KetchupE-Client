# Business tools and Daily Cash

Current implementation, 2026-10-16. `BusinessFlow` is the shared executor; `daily_cash` is one registered implementation. Their code has different responsibilities, but their documentation is kept together. Use the [integration guide](WORKFLOW_INTEGRATION_GUIDE.md) for other extension types.

## Shared contract

[BusinessTool](../electron/business/contracts.ts) declares an ID, version, routing description, input fields, optional `suggest(files, today)`, and `execute`. Register it once in [registry.ts](../electron/business/registry.ts); runtime and the worker use the same registry. Do not also register a duplicate workflow.

`execute` receives:

- `values`: string values keyed by field name.
- `files`: arrays of `{ bytes, fingerprint, name }`, including single-file fields.
- `checkpoint`: persisted JSON from the preceding input request.
- `signal`: cancellation.

| Return status | Payload | Executor behavior |
| --- | --- | --- |
| `needs_input` | `question`, `fields`, optional `checkpoint` | Save state and show the next input card |
| `completed` | `summary`, XLSX `file`, nonempty `checks`, optional PNG `image` and `externalData` | Validate, save, register, then expose artifacts |
| `failed` | `message` | Reopen the input card with previous answers |

After an answer, execution starts again from the beginning with accumulated values and the checkpoint. Reuse cached external observations. Keep calculations deterministic; do not perform payments, postings, or other irreversible remote writes in this contract.

Fields support `file`, `date`, `text`, `number`, and `movements`. `multiple: true` permits multiple files. `confirm` is a field property: the confirmation button submits its exact value. `movements` submits `{changes, add}` JSON. New field types require changes to [shared types](../src/app-types/BusinessTool.types.ts), `BusinessFlow.validateFields`, and [BusinessToolCard](../src/Features/Agent/components/BusinessToolCard.tsx).

## Execution and storage

- Inputs use registered native file references; tools receive bytes, not arbitrary paths or shell commands. Duplicate files within a field are rejected. Source files are not modified.
- Limits: 20 MiB per source file, 100 MiB total input, 30 fields, checkpoint JSON up to 1,000,000 characters, and 20 MiB per output file.
- The first accepted execution freezes initial values, file references, hashes, and tool version. Sources are re-read and hashes checked on subsequent submissions. Source or version changes require a new task.
- Questions and state live in `business_jobs` / `run_actions`. Waiting jobs survive restart; interrupted execution is cancelled without automatic replay.
- Each execution runs in an Electron utility process with a 120-second limit and 512 MiB V8 heap cap, not an RSS cap. Cancellation terminates the worker. Tool errors and timeouts normally return to input for correction.
- Every business check must pass, and the XLSX must reopen successfully. Optional PNGs are also validated. File-format validation does not establish accounting correctness.
- Artifacts are saved without overwriting under `userData/business-output/<artifact-id>/`. Only validated, DB-registered artifacts appear in chat; opening rechecks their hashes. Audit records retain checks and applied external data, excluding credentials.
- Raw source workbooks are not sent to the routing model or telemetry. Requests and recent user messages do reach the routing model. Source snapshots, historical code replay, and automatic artifact cleanup are not implemented; deleting a conversation does not delete output files.

For a new tool, implement parsing/calculation/checks, add golden-result tests, and register it. Bump the tool version when business rules change. [bankDaily.ts](../electron/business/bankDaily.ts) is a small test implementation; remove `bank_daily` from the registry before product release.

## Daily Cash

Entry point: [dailyCash.ts](../electron/business/dailyCash.ts). The tool prepares a daily cash report from local workbooks, asks the operator to resolve ambiguity, and returns XLSX plus PNG. The LLM routes the request; code performs calculations.

### Inputs and dates

| Field | Input |
| --- | --- |
| `workDate` | Work date, defaulting to today in Asia/Seoul; editable before first execution |
| `previousReport` | One report workbook containing the preceding closing sheet |
| `weeklyPlans` | One or more weekly plans covering the report and work dates |
| `cashStatus` | One KC cash-status workbook for the report date |

Report date = work date minus one calendar day. For work date 2026-10-15, use the 2026-10-14 KC closing balances and the latest report sheet before 2026-10-14. Reject a prior sheet more than seven days old; ask before carrying across a date gap. Never overwrite an existing report-date sheet.

Connected search folders also supply business files. `suggest` prefills candidates by filename; users confirm or replace them in the input card. The KC filename date must match the report date; ask if absent and reject if different. Weekly plan dates come from cells, not filenames. After execution starts, replacing sources requires a new task.

### Business rules

| Area | Rule |
| --- | --- |
| Carry-forward | Copy prior H-column closing amounts to new D-column opening amounts, preserving fractional won. Missing formula caches are unknown, not zero. Truly empty non-formula cells are zero. Ask for up to 20 missing values; otherwise require an Excel-recalculated and saved source. |
| KC balances | Use account balance column O, not book balance column M. Find headers and the `환종별합계 KRW` total by labels. Use report labels/formulas for moving sections rather than assuming fixed total rows. |
| Reconciliation | Opening + actual inflow − actual outflow must match closing balance. Ask for actual totals when book movements disagree; never invent a balancing transaction. Use Decimal precision 30 and permit only differences strictly below one won while retaining fractional source values. |
| Deposits | Match bank, currency, explicit maturity date, and principal; equal candidates bind in order and require operator review. Reconcile confirmed KRW maturity principal against prior deposits and subscription principal against KC inflows, including one pooled subscription covering several new accounts. Interest is reviewed separately and never added to principal. At maturity, reduce the full prior principal; a remaining KC balance needs clarification. New deposits require KC start date = report date, future maturity, zero opening, and inflow = closing with no outflow. Allocate unused same-currency template rows, show the bank and start/maturity dates, and unhide changed rows; expand the source template if no slots remain. Do not invent missing rates or receiving accounts. |
| Business divisions | Bind account code + currency to the existing O/P auxiliary table. Read merged-cell master values only. |
| Weekly plans | Read `세부계획(원화,외화)` and actual B-column dates. Keep `지주현금` inflows/outflows in the holding-cash execution table. Separately extract KRW `사업예만` maturity principal, `사업예불` subscriptions, and `사업현금` deposit-maturity interest for operator confirmation. Exclude `사업부문 현금유입/유출` (including `현급유입`) and totals regardless of category. The foreign-currency section after `지주-현금입금` is not parsed. Reject overlapping dates across plan versions; ask when a required date has no plan. |
| Execution details | Left table = report-date actuals; right table = work-date plans. Operators adjust amounts, mark unexecuted rows as zero, and add missing transactions. Actual cash closing must reconcile to KC KRW cash. |
| FX | Fetch Hana's final published rate for the report date; convert JPY per 100 yen to per yen. Store date, round, publication time, source, and response hash in the checkpoint/audit. Confirm a different publication date. After retry failure, request operator-verified rates and mark them as manual; never estimate. |
| Other assets | Carry receivables, savings, and trusts only after confirmation of no change. Changes to those categories are outside v1. New accounts may bind only to allowed existing cells with compatible currency/type; new term deposits use verified empty slots. Other template changes require updated inputs or rules. |
| Final review | Confirm the hash of applied accounts, rates, actual/plan differences, maturities, and sources. The button submits the code; changes require a new confirmation. Approval does not become a permanent mapping or future approval. |

Deposit execution edits (`depositEdits`) use the same editable movement table as cash actuals, but remain separate from holding-cash reconciliation. Principal mismatches require correction; confirmed interest and new account details participate in the final review hash and audit.

Movement edits use one-based indices from the original plan list. `changes` can include `index`, `amount`, optional `description` and `party`; `add` supplies `direction` (`in`/`out`), description, party, and amount. The table UI edits existing amounts; description/party changes are supported by the JSON contract.

### Output and code map

The selected source XLSX is updated in place with only the `YYMMDD` report sheet added; a result copy is also kept in the app. Audit details remain in the app’s business artifact record, not an extra worksheet. The app checks the source fingerprint before replacement and stops if the file changed during the workflow. It copies layout/merges, fills and recalculates the new sheet, and validates total KRW against KC before saving. The PNG includes visible cells through the O/P division table and its final row; it is a custom rendering, not an Excel screenshot. Themes, conditional formatting, and print pagination are not fully reproduced.

| Change | File |
| --- | --- |
| Questions, input suggestions, execution order, final review | [dailyCash.ts](../electron/business/dailyCash.ts) |
| KC parsing and differences | [cashStatus.ts](../electron/business/dailyCash/cashStatus.ts) |
| Weekly-plan parsing | [weekly.ts](../electron/business/dailyCash/weekly.ts) |
| Account binding, layout, calculations, workbook output | [report.ts](../electron/business/dailyCash/report.ts) |
| Dates, Decimal arithmetic, cell values | [values.ts](../electron/business/dailyCash/values.ts) |
| Hana rate lookup | [hana.ts](../electron/business/dailyCash/hana.ts) |
| PNG rendering | [image.ts](../electron/business/dailyCash/image.ts) |
| Shared execution and process lifecycle | [flow.ts](../electron/business/flow.ts), [workerClient.ts](../electron/business/workerClient.ts) |

Account targets and some template positions remain hardcoded. Foreign-currency term deposits currently assume USD; other currencies need explicit support. Hana uses public HTML parsing and can break when the page changes.

### Validation and demo

Synthetic regression tests cover duplicate maturities, pooled subscriptions into new accounts, interest and division-summary exclusion, consecutive-day carry-forward, movements, reconciliation, workbook integrity, and PNG bounds. They do not establish correctness on a matched real-world source set. The October report/weekly-plan examples support targeted parsing and KRW deposit checks; a full real-world comparison still requires the matching KC cash-status workbook and confirmed actuals.

```sh
npx vitest run electron/business/flow.test.ts electron/business/bankDaily.test.ts electron/business/dailyCash.test.ts
npx vite-node scripts/daily-cash-demo.ts fixtures/daily-cash
npx vite-node scripts/bank-fixture.ts fixtures
```

The offline demo generates synthetic inputs, review text, XLSX, and PNG with fixed test rates. Expected cash: 100,000 + 10,000 − 1,000 = 109,000; after next-day plans, 107,000. Generated `fixtures/` files are ignored by Git; tests generate their own data in memory. App execution uses the live rate lookup and operator confirmation.
