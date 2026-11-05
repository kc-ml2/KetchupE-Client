# Business tools and Daily Cash

Current implementation, 2026-11-05. `BusinessFlow` is the shared executor; `daily_cash` is one registered implementation. Their code has different responsibilities, but their documentation is kept together. Use the [integration guide](WORKFLOW_INTEGRATION_GUIDE.md) for other extension types.

## Shared contract

[BusinessTool](../electron/business/contracts.ts) declares an ID, version, routing description, input fields, optional `defaults(today)` and `uploadOnly`, and `execute`. Register it once in [registry.ts](../electron/business/registry.ts); runtime and the worker use the same registry. Do not also register a duplicate workflow.

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

Daily Cash's account-binding text field carries `accountRows` to display the unresolved account codes, names, currencies, balances, and maturities. Users select the report area (H: main-table closing amount, P: business-unit balance) and enter a row number; the card serializes the existing account-to-cell mapping internally. Currency, deposit/maturity, allowed-cell and duplicate-cell checks still run in the business tool. A report balance with no matching KC account requires corrected source files, not a guessed mapping.

## Execution and storage

- Inputs use registered native file references; tools receive bytes, not arbitrary paths or shell commands. Duplicate files within a field are rejected. Windows network-drive `realpath` failures with `EISDIR` retry Node's non-native resolver, including in the private-account-data guard before upload or registration, preserving canonical-path and symlink checks. Source files are modified only by tools declaring `updateSource`, after validation.
- Limits: 20 MiB per source file, 100 MiB total input, 30 fields, checkpoint JSON up to 1,000,000 characters, and 20 MiB per output file.
- Workbook loading does not reject files based on total sheet count or worksheet dimensions: annual Daily Cash history and distant cells are preserved. File size, worker memory, and execution-time limits still apply.
- The first accepted execution freezes initial values, file references, hashes, and tool version. Sources are re-read and hashes checked on subsequent submissions. Source or version changes require a new task.
- Questions and state live in `business_jobs` / `run_actions`. Waiting jobs survive restart; interrupted execution is cancelled without automatic replay.
- Each execution runs in an Electron utility process with an eight-minute limit for Daily Cash and a 120-second limit for other tools and 1 GiB V8 heap cap, not an RSS cap. Workbook inspection/output validation uses a separate process with the same heap cap and a 30-second limit. Cancellation discards results and allows native Daily Cash engines to clean up before terminating the worker. Tool errors and timeouts normally return to input for correction.
- Every business check must pass, and the XLSX must reopen successfully. Optional PNGs are also validated. File-format validation does not establish accounting correctness.
- Artifacts are saved without overwriting under `userData/business-output/<artifact-id>/`. Only validated, DB-registered artifacts appear in chat; opening rechecks their hashes. Audit records retain checks and applied external data, excluding credentials.
- Raw source workbooks are not sent to the routing model or telemetry. Requests and recent user messages do reach the routing model. Local workbook snapshots, historical code replay, and automatic artifact cleanup are not implemented; deleting a conversation does not delete output files.

For a new tool, implement parsing/calculation/checks, add golden-result tests, and register it. Bump the tool version when business rules change. [bankDaily.ts](../electron/business/bankDaily.ts) is a small test implementation; remove `bank_daily` from the registry before product release.

## Daily Cash

Entry point: [dailyCash.ts](../electron/business/dailyCash.ts). The tool prepares a daily cash report from the prior report, weekly plans and CAPER ERP cash status, asks the operator to resolve ambiguity, and returns XLSX plus PNG. The LLM routes the request; code performs calculations.

### Inputs and dates

| Field | Input |
| --- | --- |
| `workDate` | Work date, defaulting to today in Asia/Seoul; editable before first execution |
| `previousReport` | One report workbook containing the preceding closing sheet |
| `weeklyPlans` | One or more weekly plans covering the report and work dates |

Report date = the previous business day, excluding weekends and the maintained Korean holiday calendar. For work date 2026-10-15, use the 2026-10-14 KC closing balances and the latest report sheet before 2026-10-14. Reject a prior sheet more than seven days old; ask before carrying across a date gap. Never overwrite an existing report-date sheet.

Daily Cash is `uploadOnly`: files come only from the picker, are never prefilled from connected folders, and are kept for the current app session only (not registered as sources; a restart requires a new task). Only the work date defaults to today. KC cash status is fetched from ERP once per job and reused from its checkpoint during input/review. The query starts on the report date and ends the day before the next business day (Friday through Sunday). The checkpoint period must match the work date; a fresh ERP snapshot requires a new job. Weekly plan dates come from cells, not filenames. After execution starts, replacing sources requires a new task.

Development reads `CAPER_API_KEY` from the ignored `.env.caper.local` into the main process; utility workers inherit it. Packaged apps require a provisioned runtime environment variable. Keys are never bundled or saved in job data. See [ERP integration and sample verification](CAPER_ERP_INTEGRATION.md) for mapping, setup and limits.

### Business rules

| Area | Rule |
| --- | --- |
| Carry-forward | Copy prior H-column closing amounts to new D-column opening amounts, preserving fractional won. Missing formula caches are unknown, not zero. Truly empty non-formula cells are zero. Ask for up to 20 missing values; otherwise require an Excel-recalculated and saved source. |
| KC balances | Fetch `erp_cash_status_kc` through REST. Use `BLNC_AMT` for bank balances; use `AM_FINAL` / `AM_FINAL2` for book balances. Sum only KRW bank balances for the total. Require success, complete row count, no truncation, unique account/currency keys and consistent ledger arithmetic. Use report labels/formulas for moving sections. |
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

The selected source XLSX is updated in place with only the `YYMMDD` report sheet added; a result copy is also kept in the app. Audit details remain in the app’s business artifact record, not an extra worksheet. The app checks the source fingerprint before replacement and stops if the file changed during the workflow.

ExcelJS fills a copy of the prior report while preserving every cell's style, including blank merged children, alignment, row heights and existing formulas. Rate headings also keep their original wrap/height settings. Carry-forward equality checks are recognized by their opening-balance operand and dated-sheet reference. The referenced historical sheet is loaded to verify that the referenced cell is actually a planned opening or actual closing balance before retargeting to the previous report's closing balance; no fixed D236 address is used. Missing sheets, unrelated cells and external-workbook rollover references fail validation instead of being guessed. Already-deleted checks need an intact source template. The print area follows populated columns through the report/side-table end, with one page across and as many vertical pages as necessary.

Desktop Microsoft Excel first recalculates and saves a temporary copy. Validated formula caches (including dates in either Excel date system) and explicitly measured description-layout adjustments are copied into the preserved archive to form the final XLSX. Excel then opens those exact final bytes in manual calculation mode, disables calculation on the target sheet, and exports that sheet to PDF without saving the workbook. The bytes must remain unchanged after export. PDFium rasterizes every PDF page into a single vertical PNG; the app no longer approximates spreadsheet layout in SVG. Historical worksheets and template styles survive native saving. Changed inputs/formulas, missing/error formula results, false carry-forward checks, and post-calculation account/total mismatches stop publication.

**Runtime requirements:** Excel is primary; use activated desktop Excel with permission to edit/save on Windows or macOS, plus the template's fonts. macOS also requires permission for KetchupE to automate Excel; installation alone is insufficient when Excel is in view-only mode. Windows uses a separate COM instance; macOS closes only the uniquely named temporary workbook and allows one Daily Cash job at a time. Cancellation discards output while allowing native cleanup. Macro/embedded-object/automatic-connection workbooks and unresolved external references in the new sheet are rejected.

Native Excel installation, activation/view-only, automation or export failures automatically restart from the pristine prepared workbook in locally installed LibreOffice. Validation failures and cancellation never trigger that retry. LibreOffice is discovered in standard installation directories or PATH, with optional `KETCHUPE_LIBREOFFICE_PATH` pointing to its executable; it is not bundled or downloaded by the app. Missing LibreOffice or a failed fallback produces an actionable failure, not a completed artifact. The result summary and audit identify `outputEngine` and `fallbackReason`. Linux can use the LibreOffice path, but is not a packaged/tested target.

LibreOffice runs with an isolated temporary profile, disabled document macros/link updates and only the selected report print range. It marks only the new report's formulas for recalculation, retaining saved historical balances, and passes the same validation before cache import. Only equivalent singleton `SUM(A1:A1)` → `SUM(A1)` serialization and numeric `1` for recognized successful rollover checks are accepted in LibreOffice mode; source formulas remain unchanged. Since Calc may evaluate volatile formulas during import, PDF export opens the final XLSX and restores its cached results as constants in the in-memory print view. Boolean constants are evaluated before printing; the view is never saved. This keeps delivered XLSX formulas intact and PNG values fixed to its caches. Private profiles/process trees are cleaned up. Daily Cash allows up to eight minutes for both engine attempts; other jobs keep two minutes. PDF comments are suppressed without deleting XLSX notes. Engine/font differences can still affect pagination and appearance. The Mac 25.8.7 sample used substitute fonts because its CoreText font list did not include the template's Malgun Gothic; Excel-bundled fonts are not automatically available to the regular Mac LibreOffice build. Install the template fonts for matching typography.

| Change | File |
| --- | --- |
| Questions, input suggestions, execution order, final review | [dailyCash.ts](../electron/business/dailyCash.ts) |
| ERP retrieval, period and account normalization | [erp.ts](../electron/business/dailyCash/erp.ts) |
| Reference XLSX parsing and differences | [cashStatus.ts](../electron/business/dailyCash/cashStatus.ts) |
| Weekly-plan parsing | [weekly.ts](../electron/business/dailyCash/weekly.ts) |
| Account binding, layout, calculations, workbook output | [report.ts](../electron/business/dailyCash/report.ts) |
| Dates, Decimal arithmetic, cell values | [values.ts](../electron/business/dailyCash/values.ts) |
| Hana rate lookup | [hana.ts](../electron/business/dailyCash/hana.ts) |
| Native Excel recalculation/PDF export | [nativeExcel.ts](../electron/business/dailyCash/nativeExcel.ts) |
| LibreOffice fallback | [libreOffice.ts](../electron/business/dailyCash/libreOffice.ts) |
| PDF rasterization and temporary files | [image.ts](../electron/business/dailyCash/image.ts) |
| Historical archive preservation and formula-cache import | [selectiveWorkbook.ts](../electron/work/selectiveWorkbook.ts) |
| Shared execution and process lifecycle | [flow.ts](../electron/business/flow.ts), [workerClient.ts](../electron/business/workerClient.ts) |

Account targets and some template positions remain hardcoded. Foreign-currency term deposits currently assume USD; other currencies need explicit support. Hana uses public HTML parsing and can break when the page changes.

### Validation and demo

Synthetic regression tests cover duplicate maturities, pooled subscriptions into new accounts, interest and division-summary exclusion, consecutive-day carry-forward, movements, reconciliation, workbook integrity, and PNG bounds. The 2026-10-15 work-date sample was also exercised against live ERP data: all 50 bank balances matched the provided KC workbook and all report reconciliations passed. Against the supplied 261014 reference, 606 of 609 numeric positions matched; the remaining three reflect a 7,500-won source-plan difference, documented in the [validation report](CAPER_ERP_INTEGRATION.md). The actual transaction used in this replay came from the reference sheet, not an unattended inference.

```sh
npx vitest run electron/business/flow.test.ts electron/business/bankDaily.test.ts electron/business/dailyCash.test.ts electron/business/dailyCash/erp.test.ts
npx vitest run electron/business/dailyCash/report.test.ts electron/business/dailyCash/image.test.ts electron/business/dailyCash/nativeExcel.test.ts electron/business/workerClient.test.ts electron/work/calculatedWorkbook.test.ts
npx vite-node scripts/daily-cash-demo.ts fixtures/daily-cash
npx vite-node scripts/bank-fixture.ts fixtures
```

The demo uses a synthetic ERP snapshot and fixed test rates, but requires activated desktop Excel or installed LibreOffice for XLSX/PDF/PNG output. Expected cash: 100,000 + 10,000 − 1,000 = 109,000; after next-day plans, 107,000. Generated `fixtures/` files are ignored by Git; tests generate their own data in memory. App execution uses live ERP/rate lookups and operator confirmation.

Native-export regression tests mock the OS automation boundary and cover fallback from calculation/PDF failure, pristine-input retries, cancellation, missing engines and actual-engine metadata. PDF rasterization uses real multi-page PDF data. Tests compare every template cell's style and every row height after saving, including empty merged ranges with distinct child fonts/borders/alignment/number formats. They also cover varying historical row locations, ambiguous-reference rejection, exact equality between PDF input bytes and the delivered XLSX, cache validation, financial reconciliation and cleanup. The opt-in `KETCHUPE_TEST_LIBREOFFICE=1` integration test checks native calculation, sheet/range selection, frozen volatile/boolean/text results and unchanged source bytes on full LibreOffice; macOS LibreOffice 25.8.7 passed this test. The 2026-11-05 Mac Excel run was blocked by view-only licensing. Successful Mac Excel PDF export, Windows COM/LibreOffice execution and signed-installer automation permission still require validation on activated machines. New payment descriptions are measured by the selected native engine against their allocated description area, ending before the amount column. Only overflowing text gains wrapping and, when needed, a horizontal merge into empty adjacent description cells; rows only grow to the measured height. Already wrapped text uses its existing display width. Original fonts, alignment attributes, blank child-cell styles and unaffected rows are retained. No text-length threshold, fixed cell address or font shrinking is used. Populated neighbors, conflicting merges and descriptions exceeding Excel's maximum row height fail validation instead of being silently clipped. Tests exercise unmerged and merged descriptions, short/already-wrapped rows, exact source text and final-PDF rendering. Layout changes are imported before the final XLSX is printed, so XLSX and PNG share the fitted layout.


### Annual Daily Cash workbooks (v3.0.1)

Daily Cash reads the workbook sheet-name index and parses the latest dated report before the report date, regardless of tab order. When rollover formulas reference older reports, only those referenced sheets are additionally parsed to verify their balance locations. Historical worksheet XML and its related parts remain in the original ZIP archive; the completed report is appended with its own strings and remapped styles. Output validation also loads only the new report sheet. The complete XLSX is still read/written on disk, and shared string/style metadata is loaded; this is selective worksheet parsing, not a partial file transfer. The existing 20 MiB per-file limit remains.

Regression fixtures cover 366 full report sheets → 367 sheets, byte-for-byte preservation of every old worksheet, repeated appends, formulas, shared strings, custom number formats, dates, hidden tabs, named ranges, print areas, comments, hyperlinks, and conditional formatting. Structured Excel tables in the new report template are rejected before saving to avoid duplicate workbook-global table names; historical tables and other archived parts are preserved.

Daily Cash correction inputs never ask users to write JSON. `cashRows` on a text field renders account details and labeled incoming/outgoing totals; serialization remains internal. Missing previous amounts use labeled numeric cell fields. Invalid legacy previous-value answers require an explicit reset before re-entry. More than 20 missing formula results require recalculating and saving the source in Excel.
