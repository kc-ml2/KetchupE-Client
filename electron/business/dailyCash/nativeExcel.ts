import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { access } from "node:fs/promises";

export class ExcelExportError extends Error {}

const EXCEL_TIMEOUT_MS = 90_000, CLEANUP_TIMEOUT_MS = 10_000, OUTPUT_BUFFER_BYTES = 1024 * 1024;

// Arguments are passed as data, never interpolated into either script.
export const macExcelScript = `on fitDescriptions(targetSheet, fitRanges)
  set fitted to ""
  tell application id "com.microsoft.Excel"
    set probeBook to make new workbook
    try
      set probeSheet to worksheet 1 of probeBook
      repeat with areaName in paragraphs of fitRanges
        if (areaName as text) is not "" then
          set targetArea to range (areaName as text) of targetSheet
          set firstCell to cell 1 of targetArea
          set wasWrapped to wrap text of firstCell
          set targetWidth to width of targetArea
          if wasWrapped and not (merge cells of targetArea) then set targetWidth to width of firstCell
          set originalHeight to row height of targetArea
          unmerge used range of probeSheet
          clear range used range of probeSheet
          copy range targetArea destination range "A1" of probeSheet
          unmerge used range of probeSheet
          set sampleCell to range "A1" of probeSheet
          set wrap text of sampleCell to false
          autofit entire column of sampleCell
          set needsWrap to wasWrapped or (width of sampleCell > targetWidth)
          repeat 3 times
            set column width of sampleCell to (column width of sampleCell) * targetWidth / (width of sampleCell)
          end repeat
          if width of sampleCell > targetWidth then set column width of sampleCell to (column width of sampleCell) * (targetWidth - 1) / (width of sampleCell)
          set wrap text of sampleCell to needsWrap
          autofit entire row of sampleCell
          set requiredHeight to row height of sampleCell
          if requiredHeight >= 409 then error "설명이 Excel 최대 행 높이를 초과합니다."
          if (needsWrap and not wasWrapped) or requiredHeight > originalHeight + 0.1 then
            if needsWrap and not wasWrapped then
              merge targetArea
              set wrap text of targetArea to true
            end if
            if requiredHeight > originalHeight then set row height of targetArea to requiredHeight
            set fitted to fitted & (areaName as text) & linefeed
          end if
        end if
      end repeat
      close probeBook saving no
    on error messageText number messageNumber
      try
        close probeBook saving no
      end try
      error messageText number messageNumber
    end try
  end tell
  return fitted
end fitDescriptions

on run argv
  set bookPath to (POSIX file (item 1 of argv)) as text
  set sheetName to item 2 of argv
  set pdfPath to (POSIX file (item 3 of argv)) as text
  set operation to item 4 of argv
  set fitRanges to item 5 of argv
  set fitted to ""
  set targetBook to missing value
  set calculationBook to missing value
  set stageName to "Excel 자동화 설정"
  with timeout of 60 seconds
    tell application id "com.microsoft.Excel"
      set oldSecurity to automation security
      set oldEvents to enable events
      set oldCalculation to calculation
      set oldCalculateBeforeSave to calculate before save
      set oldAlerts to display alerts
      try
        set display alerts to false
        set automation security to msoAutomationSecurityForceDisable
        set enable events to false
        -- The first opened workbook can override Excel's calculation mode before we can disable it.
        set calculationBook to make new workbook
        set stageName to "수동 계산 설정"
        set calculation to calculation manual
        set stageName to "저장 전 계산 설정"
        set calculate before save to false
        set stageName to "통합문서 열기"
        set targetBook to open workbook workbook file name bookPath update links do not update links read only false ignore read only recommended true add to mru false
        close calculationBook saving no
        set calculationBook to missing value
        set stageName to "대상 시트 선택"
        set targetSheet to worksheet sheetName of targetBook
        if operation is "calculate" then
          set stageName to "시트 재계산"
          calculate targetSheet
          if fitRanges is not "" then
            set stageName to "설명 표시 영역 측정"
            set fitted to my fitDescriptions(targetSheet, fitRanges)
          end if
          set stageName to "통합문서 저장"
          save workbook as targetBook filename bookPath file format Excel XML file format
        else
          set stageName to "최종 XLSX의 PDF 출력"
          set enable calculation of targetSheet to false
          -- Mac Save As PDF includes every visible sheet, even when its receiver is a worksheet.
          set stageName to "다른 시트 숨기기"
          repeat with sheetIndex from 1 to count of worksheets of targetBook
            set otherSheet to worksheet sheetIndex of targetBook
            if name of otherSheet is not sheetName then set visible of otherSheet to false
          end repeat
          set stageName to "PDF 저장"
          save as targetSheet filename pdfPath file format PDF file format
        end if
        close targetBook saving no
        set targetBook to missing value
        set calculate before save to oldCalculateBeforeSave
        set calculation to oldCalculation
        set automation security to oldSecurity
        set enable events to oldEvents
        set display alerts to oldAlerts
      on error messageText number messageNumber
        with timeout of 5 seconds
          try
            set display alerts to oldAlerts
          end try
          try
            set automation security to oldSecurity
          end try
          try
            set enable events to oldEvents
          end try
          try
            close targetBook saving no
          end try
          try
            close calculationBook saving no
          end try
          try
            set calculate before save to oldCalculateBeforeSave
          end try
          try
            set calculation to oldCalculation
          end try
        end timeout
        error (stageName & ": " & messageText) number messageNumber
      end try
    end tell
  end timeout
  if operation is "calculate" and fitRanges is not "" then
    set fitFile to open for access (POSIX file ((item 1 of argv) & ".fit")) with write permission
    try
      set eof of fitFile to 0
      write fitted to fitFile as «class utf8»
      close access fitFile
    on error messageText number messageNumber
      close access fitFile
      error messageText number messageNumber
    end try
  end if
end run`;

export const windowsExcelScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Set-ExcelStage([string]$name) {
  $script:stageName = $name
  [Console]::Out.WriteLine('[KETCHUPE_EXCEL_STAGE] ' + $name)
}
$failed = $false
$excel = $null
$book = $null
$sheet = $null
$seed = $null
$owned = $false
try {
  Set-ExcelStage 'Excel 자동화 연결'
  $existing = @(Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $excel = New-Object -ComObject Excel.Application
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ExcelWindow { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }'
  [uint32]$excelProcessId = 0
  [void][ExcelWindow]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$excelProcessId)
  if (!$excelProcessId -or $existing -contains $excelProcessId) { throw 'Excel could not start a separate export process.' }
  $owned = $true
  $process = Get-Process -Id $excelProcessId
  @{ id = $excelProcessId; started = $process.StartTime.ToFileTimeUtc().ToString() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:KETCHUPE_EXCEL_PROCESS
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $excel.AutomationSecurity = 3
  $excel.EnableEvents = $false
  $excel.AskToUpdateLinks = $false
  Set-ExcelStage '임시 통합문서 생성'
  $seed = $excel.Workbooks.Add()
  $excel.Calculation = -4135
  $excel.CalculateBeforeSave = $false
  Set-ExcelStage '일보 파일 열기'
  $book = $excel.Workbooks.Open($env:KETCHUPE_EXCEL_INPUT, 0, $false)
  if ($book.ReadOnly) { throw 'Excel opened the temporary workbook as read-only.' }
  Set-ExcelStage '일보 시트 선택'
  $sheet = $book.Worksheets.Item($env:KETCHUPE_EXCEL_SHEET)
  if ($env:KETCHUPE_EXCEL_OPERATION -eq 'calculate') {
    Set-ExcelStage '일보 재계산'
    $sheet.Calculate()
    if ($env:KETCHUPE_EXCEL_FIT) {
      $fitted = @()
      $probeSheet = $seed.Worksheets.Item(1)
      foreach ($areaName in ($env:KETCHUPE_EXCEL_FIT -split ',')) {
        Set-ExcelStage ('집행내역 표시 영역 측정: ' + $areaName)
        $area = $sheet.Range($areaName)
        $first = $area.Cells.Item(1, 1)
        $wasWrapped = [bool]$first.WrapText
        $targetWidth = $area.Width
        if ($wasWrapped -and !$area.MergeCells) { $targetWidth = $first.Width }
        $originalHeight = $area.RowHeight
        $probeSheet.UsedRange.UnMerge()
        $probeSheet.UsedRange.Clear()
        $area.Copy($probeSheet.Range('A1'))
        $probeSheet.UsedRange.UnMerge()
        $sample = $probeSheet.Range('A1')
        $sample.WrapText = $false
        $sample.EntireColumn.AutoFit()
        $needsWrap = $wasWrapped -or $sample.Width -gt $targetWidth
        for ($i = 0; $i -lt 3; $i++) { $sample.ColumnWidth = $sample.ColumnWidth * $targetWidth / $sample.Width }
        if ($sample.Width -gt $targetWidth) { $sample.ColumnWidth = $sample.ColumnWidth * ($targetWidth - 1) / $sample.Width }
        $sample.WrapText = $needsWrap
        $sample.EntireRow.AutoFit()
        $requiredHeight = $sample.RowHeight
        if ($requiredHeight -ge 409) { throw 'Description exceeds Excel maximum row height.' }
        if (($needsWrap -and !$wasWrapped) -or $requiredHeight -gt $originalHeight + 0.1) {
          if ($needsWrap -and !$wasWrapped) { $area.Merge(); $area.WrapText = $true }
          if ($requiredHeight -gt $originalHeight) { $area.RowHeight = $requiredHeight }
          $fitted += $areaName
        }
      }
      [IO.File]::WriteAllText($env:KETCHUPE_EXCEL_INPUT + '.fit', ($fitted -join [Environment]::NewLine))
    }
    Set-ExcelStage '재계산한 XLSX 저장'
    $book.Save()
  } else {
    Set-ExcelStage '최종 XLSX의 PDF 출력'
    $sheet.EnableCalculation = $false
    $sheet.ExportAsFixedFormat(0, $env:KETCHUPE_EXCEL_PDF, 0, $true, $false)
  }
  Set-ExcelStage 'Excel 종료'
} catch {
  $failed = $true
  $cause = $_.Exception.GetBaseException()
  [Console]::Error.WriteLine(('[KETCHUPE_EXCEL_ERROR] {0} (0x{1:X8}): {2}' -f $stageName, $cause.HResult, $cause.Message))
} finally {
  if ($null -ne $book) { try { $book.Close($false) } catch {} }
  if ($null -ne $seed) { try { $seed.Close($false) } catch {} }
  if ($owned) { try { $excel.Quit() } catch {} }
  foreach ($item in @($sheet, $book, $seed, $excel)) {
    if ($null -ne $item) { try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item) } catch {} }
  }
}
if ($failed) { exit 1 }
exit 0
`;

// A timed-out PowerShell process cannot run finally; reclaim only the Excel instance it created.
export const windowsCleanupScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (Test-Path -LiteralPath $env:KETCHUPE_EXCEL_PROCESS) {
  $owner = Get-Content -LiteralPath $env:KETCHUPE_EXCEL_PROCESS -Raw | ConvertFrom-Json
  $process = Get-Process -Id $owner.id -ErrorAction SilentlyContinue
  if ($null -ne $process -and $process.ProcessName -eq 'EXCEL' -and $process.StartTime.ToFileTimeUtc().ToString() -eq $owner.started) { Stop-Process -InputObject $process -Force }
}
# A normally exited Excel is already gone; Get-Process must not leave the host exit code at 1.
exit 0
`;

/** Finish the native script's cleanup even after cancellation; the caller must discard its output. */
export async function exportWithExcel(input: string, sheet: string, pdf: string, signal: AbortSignal, operation: "calculate" | "pdf", textFitRanges: string[] = []) {
  signal.throwIfAborted();
  let failedStage: string | undefined;
  let timeoutMs = EXCEL_TIMEOUT_MS;
  try {
    const execute = promisify(execFile);
    if (process.platform === "darwin") {
      await execute("/usr/bin/osascript", ["-e", macExcelScript, input, sheet, pdf, operation, textFitRanges.join("\n")], { timeout: EXCEL_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES });
    } else if (process.platform === "win32") {
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const env = { ...process.env, KETCHUPE_EXCEL_INPUT: input, KETCHUPE_EXCEL_SHEET: sheet, KETCHUPE_EXCEL_PDF: pdf, KETCHUPE_EXCEL_PROCESS: `${input}.process`, KETCHUPE_EXCEL_OPERATION: operation, KETCHUPE_EXCEL_FIT: textFitRanges.join(",") };
      const args = (script: string) => ["-NoProfile", "-NonInteractive", "-Sta", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
      let failure: unknown;
      try {
        await execute(powershell, args(windowsExcelScript), { timeout: EXCEL_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES, windowsHide: true, env });
      } catch (error) { failure = error; }
      try {
        await execute(powershell, args(windowsCleanupScript), { timeout: CLEANUP_TIMEOUT_MS, maxBuffer: OUTPUT_BUFFER_BYTES, windowsHide: true, env });
      } catch (error) {
        if (!failure) { failure = error; failedStage = "Excel 프로세스 정리"; timeoutMs = CLEANUP_TIMEOUT_MS; }
      }
      if (failure) throw failure;
    } else throw new Error("Microsoft Excel 출력은 Windows와 macOS에서 지원합니다.");
    await access(operation === "calculate" ? input : pdf);
  } catch (error) {
    signal.throwIfAborted();
    const native = error as { stderr?: string; stdout?: string; killed?: boolean; code?: string | number } | undefined;
    const stage = native?.stdout?.match(/\[KETCHUPE_EXCEL_STAGE\] ([^\r\n]+)/g)?.at(-1)?.replace("[KETCHUPE_EXCEL_STAGE] ", "") ?? failedStage;
    const stderr = native?.stderr?.trim() ?? "";
    const message = error instanceof Error ? error.message.split("\n")[0] : "";
    const detail = native?.killed ? `실행 제한 시간(${timeoutMs / 1000}초)을 초과했습니다.`
      : stderr && !stderr.startsWith("#< CLIXML") && !stderr.startsWith("#<CLIXML") ? stderr.replace("[KETCHUPE_EXCEL_ERROR] ", "")
      : native?.code === "ENOENT" ? "Excel 자동화 실행 프로그램을 찾을 수 없습니다."
      : message.startsWith("Command failed:") ? `자동화 실행이 종료되었습니다 (종료 코드: ${native?.code ?? "알 수 없음"}).` : message;
    throw new ExcelExportError(`Microsoft Excel 재계산·출력에 실패했습니다.${stage ? ` 실패 단계: ${stage}.` : ""} ${detail}`);
  }
  signal.throwIfAborted();
}
