import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SelectiveWorkbook } from "../../work/selectiveWorkbook.ts";

export class LibreOfficeExportError extends Error {}

/** User-installed LibreOffice; no dependency on the development machine's bundled runtime. */
export async function libreOfficeExecutable() {
  const filenames = process.platform === "win32" ? ["soffice.com", "soffice.exe"] : ["soffice"];
  const directories = process.platform === "darwin" ? ["/Applications/LibreOffice.app/Contents/MacOS", join(homedir(), "Applications/LibreOffice.app/Contents/MacOS")]
    : process.platform === "win32" ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((p): p is string => !!p).map(p => join(p, "LibreOffice", "program")) : [];
  const candidates = [...(process.env.KETCHUPE_LIBREOFFICE_PATH ? [process.env.KETCHUPE_LIBREOFFICE_PATH] : []), ...directories.flatMap(dir => filenames.map(file => join(dir, file))), ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap(dir => filenames.map(file => join(dir, file)))];
  for (const path of candidates) { try { await access(path, constants.X_OK); return path; } catch { /* Try the next installation path. */ } }
  throw new LibreOfficeExportError("LibreOffice를 찾을 수 없습니다. LibreOffice를 설치하거나 KETCHUPE_LIBREOFFICE_PATH에 실행 파일 경로를 지정하세요.");
}

// A private user library runs our fixed script. Input workbook macros and link updates are disabled.
export const libreOfficeScript = `Option Explicit
Sub FitDescriptions(sheet As Object)
  On Error GoTo FailedFit
  Dim probeDoc As Object
  Dim probeArgs(0) As New com.sun.star.beans.PropertyValue
  Dim probeSheet As Object, area As Object, probe As Object, sample As Object, first As Object
  Dim probeColumn As Object, probeRow As Object, targetRow As Object
  Dim ranges, item, properties, targetWidth As Long, needed As Long, originalHeight As Long
  Dim wasWrapped As Boolean, needsWrap As Boolean, channel As Integer, failure As Integer
  If Environ("KETCHUPE_LO_FIT") = "" Then Exit Sub
  probeArgs(0).Name = "Hidden" : probeArgs(0).Value = True
  probeDoc = StarDesktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, probeArgs())
  probeSheet = probeDoc.Sheets.getByIndex(0)
  probeColumn = probeSheet.Columns.getByIndex(0)
  probeRow = probeSheet.Rows.getByIndex(0)
  channel = FreeFile
  Open Environ("KETCHUPE_LO_INPUT") & ".fit" For Output As #channel
  ranges = Split(Environ("KETCHUPE_LO_FIT"), ",")
  For Each item In ranges
    area = sheet.getCellRangeByName(item)
    first = area.getCellByPosition(0, 0)
    wasWrapped = first.IsTextWrapped
    targetWidth = area.Size.Width
    If wasWrapped And Not area.IsMerged Then targetWidth = first.Size.Width
    targetRow = area.Rows.getByIndex(0)
    originalHeight = targetRow.Height
    probe = probeSheet.getCellRangeByPosition(0, 0, area.Columns.Count - 1, 0)
    probe.merge(False)
    probe.clearContents(1023)
    sample = probe.getCellByPosition(0, 0)
    properties = Array("CharFontName", "CharHeight", "CharWeight", "CharPosture", "CharFontNameAsian", "CharHeightAsian", "CharWeightAsian", "CharPostureAsian", "CharFontNameComplex", "CharHeightComplex", "CharWeightComplex", "CharPostureComplex", "ParaIndent", "HoriJustify", "VertJustify", "RotateAngle", "ShrinkToFit", "ParaLeftMargin", "ParaRightMargin", "ParaTopMargin", "ParaBottomMargin")
    sample.setPropertyValues(properties, first.getPropertyValues(properties))
    sample.setString(first.String)
    sample.IsTextWrapped = False
    probeColumn.OptimalWidth = True
    needsWrap = wasWrapped Or probeColumn.Width > targetWidth
    probeColumn.Width = targetWidth
    sample.IsTextWrapped = needsWrap
    probeRow.OptimalHeight = True
    needed = probeRow.Height
    If needed * 72 / 2540 >= 409 Then Error 5
    If (needsWrap And Not wasWrapped) Or needed > originalHeight + 4 Then
      If needsWrap And Not wasWrapped Then
        area.merge(True)
        area.IsTextWrapped = True
      End If
      If needed > originalHeight Then targetRow.Height = needed
      Print #channel, item
    End If
  Next item
  Close #channel
  probeDoc.close(True)
  Exit Sub
FailedFit:
  failure = Err
  On Error Resume Next
  Close #channel
  probeDoc.close(True)
  On Error GoTo 0
  Error failure
End Sub

Sub ExportReport
  On Error GoTo Failed
  Dim doc As Object, sheet As Object, selection As Object, controller As Object
  Dim args(4) As New com.sun.star.beans.PropertyValue
  Dim saveArgs(1) As New com.sun.star.beans.PropertyValue
  Dim filters(1) As New com.sun.star.beans.PropertyValue
  Dim channel As Integer, stage As String
  Dim cacheDoc As Object, cells As Object, entry As Object, cell As Object, i As Long
  stage = "통합문서 열기"
  args(0).Name = "Hidden" : args(0).Value = True
  args(1).Name = "MacroExecutionMode" : args(1).Value = 0
  args(2).Name = "UpdateDocMode" : args(2).Value = 0
  args(3).Name = "ReadOnly" : args(3).Value = (Environ("KETCHUPE_LO_OPERATION") = "pdf")
  args(4).Name = "Silent" : args(4).Value = True
  doc = StarDesktop.loadComponentFromURL(ConvertToURL(Environ("KETCHUPE_LO_INPUT")), "_blank", 0, args())
  doc.enableAutomaticCalculation(False)
  sheet = doc.Sheets.getByName(Environ("KETCHUPE_LO_SHEET"))
  If Environ("KETCHUPE_LO_OPERATION") = "calculate" Then
    stage = "시트 재계산·저장"
    ' Historical reports supply saved balances; only the new report's formulas are dirtied.
    cells = sheet.queryContentCells(16).getCells().createEnumeration()
    Do While cells.hasMoreElements()
      cell = cells.nextElement()
      cell.setFormula(cell.getFormula())
    Loop
    doc.calculate()
    stage = "설명 표시 영역 측정"
    FitDescriptions(sheet)
    saveArgs(0).Name = "FilterName" : saveArgs(0).Value = "Calc MS Excel 2007 XML"
    saveArgs(1).Name = "Overwrite" : saveArgs(1).Value = True
    doc.storeAsURL(ConvertToURL(Environ("KETCHUPE_LO_OUTPUT")), saveArgs())
  Else
    stage = "최종 XLSX 계산값 고정"
    cacheDoc = CreateUnoService("com.sun.star.xml.dom.DocumentBuilder").parseURI(ConvertToURL(Environ("KETCHUPE_LO_CACHES")))
    cells = cacheDoc.getElementsByTagName("cell")
    For i = 0 To cells.getLength() - 1
      entry = cells.item(i)
      cell = sheet.getCellRangeByName(entry.getAttribute("address"))
      Select Case entry.getAttribute("type")
        Case "number"
          cell.setValue(Val(entry.getAttribute("value")))
        Case "boolean"
          cell.setFormula("=" & UCase(entry.getAttribute("value")) & "()")
        Case "string"
          cell.setString(entry.getAttribute("value"))
      End Select
    Next i
    doc.calculate()
    stage = "선택 시트 PDF 출력"
    selection = sheet.getCellRangeByName(Environ("KETCHUPE_LO_RANGE"))
    stage = "시트 활성화"
    controller = doc.getCurrentController()
    controller.setActiveSheet(sheet)
    controller.select(selection)
    stage = "PDF 내보내기"
    filters(0).Name = "Selection" : filters(0).Value = selection
    filters(1).Name = "ExportNotes" : filters(1).Value = False
    saveArgs(0).Name = "FilterName" : saveArgs(0).Value = "calc_pdf_Export"
    saveArgs(1).Name = "FilterData" : saveArgs(1).Value = filters()
    doc.storeToURL(ConvertToURL(Environ("KETCHUPE_LO_OUTPUT")), saveArgs())
  End If
  doc.close(True)
  StarDesktop.terminate()
  Exit Sub
Failed:
  channel = FreeFile
  Open Environ("KETCHUPE_LO_ERROR") For Output As #channel
  Print #channel, stage & ": " & Error$ & " (" & Err & ")"
  Close #channel
  On Error Resume Next
  doc.close(True)
  StarDesktop.terminate()
End Sub`;

/** Stop only this private profile's process tree on cancellation or timeout. */
async function run(executable: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal, timeout = 90000) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "", failure: Error | undefined;
    let stopping: Promise<unknown> | undefined;
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8192); });
    const stop = (error: Error) => {
      if (stopping) return;
      failure = error;
      stopping = (async () => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          await promisify(execFile)(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { timeout: 10000, windowsHide: true });
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; } }
      })();
      stopping.catch(() => child.kill());
    };
    const abort = () => stop(new Error("업무 실행이 중단되었습니다."));
    const timer = setTimeout(() => stop(new Error("LibreOffice 출력 시간이 초과되었습니다.")), timeout);
    signal.addEventListener("abort", abort, { once: true });
    const finish = async (error?: Error) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      try { await stopping; } catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
      if (failure || error) reject(failure ?? error); else resolve();
    };
    child.once("error", error => { void finish(error); });
    child.once("close", code => { void finish(code === 0 ? undefined : new Error(`LibreOffice 종료 코드 ${code}: ${stderr}`)); });
    if (signal.aborted) abort();
  });
  signal.throwIfAborted();
}

const escaped = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;").replaceAll("\t", "&#9;");

export async function exportWithLibreOffice(input: string, sheet: string, pdf: string, signal: AbortSignal, operation: "calculate" | "pdf", textFitRanges: string[] = []) {
  signal.throwIfAborted();
  const executable = await libreOfficeExecutable();
  const source = operation === "pdf" ? (await (await SelectiveWorkbook.open(await readFile(input))).loadSheet(sheet)).getWorksheet(sheet)! : undefined;
  const printArea = source?.pageSetup.printArea ?? "";
  if (operation === "pdf" && (!printArea || !/^\$?[A-Z]+\$?[1-9]\d*:\$?[A-Z]+\$?[1-9]\d*$/.test(printArea))) throw new LibreOfficeExportError("LibreOffice 출력에 필요한 단일 인쇄 영역을 확인하세요.");
  const caches: string[] = [];
  // Calc may evaluate volatile formulas while importing. Freeze only the in-memory print view to the final file's caches.
  source?.eachRow(row => row.eachCell(cell => {
    if (!cell.formula || (cell.isMerged && cell.master.address !== cell.address)) return;
    const cached: unknown = cell.result;
    const value = cached instanceof Date ? cached.getTime() / 86400000 + 25569 - (source.workbook.properties.date1904 ? 1462 : 0) : cached;
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new LibreOfficeExportError(`${cell.address}: 최종 XLSX의 수식 저장 결과가 없어 PDF를 출력할 수 없습니다.`);
    caches.push(`<cell address="${cell.address}" type="${typeof value}" value="${escaped(String(value))}"/>`);
  }));
  const profile = await mkdtemp(join(dirname(input), "libreoffice-"));
  try {
    const profileArg = `-env:UserInstallation=${pathToFileURL(profile).href}`;
    // First-run initialization overwrites the default Basic library, so install our script afterwards.
    await run(executable, [profileArg, "--headless", "--nologo", "--terminate_after_init"], process.env, signal, 15000);
    const basic = join(profile, "user", "basic");
    await mkdir(join(basic, "Standard"), { recursive: true });
    await writeFile(join(basic, "script.xlc"), '<?xml version="1.0"?><library:libraries xmlns:library="http://openoffice.org/2000/library"><library:library library:name="Standard" library:link="false"/></library:libraries>');
    await writeFile(join(basic, "Standard", "script.xlb"), '<?xml version="1.0"?><library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false"><library:element library:name="KetchupE"/></library:library>');
    await writeFile(join(basic, "Standard", "KetchupE.xba"), `<?xml version="1.0"?><script:module xmlns:script="http://openoffice.org/2000/script" script:name="KetchupE" script:language="StarBasic"><![CDATA[${libreOfficeScript}]]></script:module>`);
    await writeFile(join(profile, "user", "registrymodifications.xcu"), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Setup/Office"><prop oor:name="ooSetupInstCompleted" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>1</value></prop></item><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
    const output = operation === "calculate" ? join(profile, "calculated.xlsx") : pdf;
    const errorFile = join(profile, "error.txt");
    const cacheFile = join(profile, "caches.xml");
    await writeFile(cacheFile, `<?xml version="1.0"?><cells>${caches.join("")}</cells>`);
    const env = { ...process.env, KETCHUPE_LO_INPUT: input, KETCHUPE_LO_SHEET: sheet, KETCHUPE_LO_OUTPUT: output, KETCHUPE_LO_OPERATION: operation, KETCHUPE_LO_ERROR: errorFile, KETCHUPE_LO_RANGE: printArea, KETCHUPE_LO_CACHES: cacheFile, KETCHUPE_LO_FIT: textFitRanges.join(",") };
    if (process.platform === "darwin") {
      const fonts = ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library/Fonts"), "/Applications/Microsoft Excel.app/Contents/Resources/DFonts"];
      const config = join(profile, "fonts.conf");
      await writeFile(config, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${fonts.map(dir => `<dir>${escaped(dir)}</dir>`).join("")}<cachedir>${escaped(join(profile, "font-cache"))}</cachedir></fontconfig>`);
      Object.assign(env, { FONTCONFIG_FILE: config });
    }
    await run(executable, [profileArg, "--headless", "--nologo", "--nodefault", "--norestore", "macro:///Standard.KetchupE.ExportReport"], env, signal);
    const detail = await readFile(errorFile, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; });
    if (detail) throw new Error(detail.trim());
    await access(output);
    if (operation === "calculate") await rename(output, input);
  } catch (error) {
    signal.throwIfAborted();
    throw new LibreOfficeExportError(`LibreOffice 재계산·출력에 실패했습니다. ${error instanceof Error ? error.message : String(error)}`);
  } finally { await rm(profile, { recursive: true, force: true }); }
}
