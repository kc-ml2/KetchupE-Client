import BusinessToolCard, {
  BusinessArtifacts,
} from "@Features/Agent/components/BusinessToolCard";
import { useContext, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { IoSend } from "react-icons/io5";
import { FaStopCircle } from "react-icons/fa";
import {
  LuBrain,
  LuCirclePause,
  LuFileText,
  LuFolderSearch,
  LuSettings,
} from "react-icons/lu";
import Sidebar from "@Features/Sidebar/components/Sidebar";
import NavRail from "@Features/Sidebar/components/NavRail";
import WorkflowLauncher from "@Features/Agent/components/WorkflowLauncher";
import type { AppTab } from "@app-types/Navigation.types";
import { useAgentApi } from "@Features/Agent/hooks/useAgentApi";
import { useThreadMessages } from "@Features/Agent/hooks/useThreadMessages";
import {
  ThreadsContext,
  type ThreadsContextType,
} from "@Contexts/ThreadsContext";
import { WORKSPACE_ID } from "@Contexts/ThreadsProvider";
import { useAgentRun, phaseLabel } from "@Features/Agent/hooks/useAgentRun";
import {
  useCanvasRun,
  canvasPhaseLabel,
} from "@Features/Agent/hooks/useCanvasRun";
import { useCollections } from "@Features/Agent/hooks/useCollections";
import { useMemories } from "@Features/Agent/hooks/useMemories";
import AgentMessages from "@Features/Agent/components/AgentMessages";
import CanvasPanel from "@Features/Agent/components/CanvasPanel";
import MissingTermsForm from "@Features/Agent/components/MissingTermsForm";
import AnchorChoicePrompt from "@Features/Agent/components/AnchorChoicePrompt";
import CollectionPanel from "@Features/Agent/components/CollectionPanel";
import MemoryPanel from "@Features/Agent/components/MemoryPanel";
import ModelSettingsForm from "@Features/Agent/components/ModelSettingsForm";
import WorkSourcePanel from "@Features/Agent/components/WorkSourcePanel";
// import { guideCopy } from "@config/guideCopy";

const TAB_TITLES: Record<AppTab, string> = {
  home: "케찹이",
  settings: "모델 설정",
  work: "업무",
  upload: "파일 업로드",
  context: "컨텍스트",
};

const AgentPage = (): React.JSX.Element => {
  const api = useAgentApi();
  const navigate = useNavigate();
  const location = useLocation();
  const { threadId } = useParams<{ threadId: string }>();
  const selectedId = threadId ?? null;
  const { createThread } = useContext(ThreadsContext) as ThreadsContextType;
  const { messages, hasMore, reload, loadOlder } = useThreadMessages(
    api,
    selectedId,
  );
  const {
    view,
    attach: attachAgent,
    resume,
  } = useAgentRun(api, selectedId, () => void reload());
  const canvasRun = useCanvasRun(api, selectedId, () => void reload());
  const canvas = canvasRun.view;
  const collectionsState = useCollections(api, WORKSPACE_ID);
  const memoriesState = useMemories(api, WORKSPACE_ID);
  const [tab, setTab] = useState<AppTab>("home");
  const [modelConfigurable, setModelConfigurable] = useState(false);
  const [input, setInput] = useState("");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memoryStatus, setMemoryStatus] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [dismissedActionId, setDismissedActionId] = useState<string | null>(
    null,
  );
  const [startError, setStartError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Wraps whichever inline prompt (business input card or anchor choice) is waiting, so 이어가기 can bring it into view.
  const promptRef = useRef<HTMLDivElement>(null);
  const [stopping, setStopping] = useState(false);
  const awaitingContractRequest =
    location.state?.workflow === "doc" &&
    !view.runId &&
    !canvas.runId &&
    messages.length === 0;

  useEffect(() => {
    if (awaitingContractRequest) inputRef.current?.focus();
  }, [awaitingContractRequest, location.key]);

  useEffect(() => {
    void api?.getWorkspace().then((workspace) => {
      setMemoryEnabled(workspace.memoryEnabled);
    });
  }, [api]);

  useEffect(() => {
    void api?.getModelSettings().then((settings) => {
      setModelConfigurable(settings.configurable);
    });
  }, [api]);

  // Any navigation (thread pick, 새 질문, workflow start) brings the chat screen back.
  useEffect(() => {
    setTab("home");
  }, [location.key]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    messages,
    view.streamingText,
    view.phase,
    view.action,
    starting,
    canvas.phase,
  ]);

  if (!api) {
    return (
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 items-center justify-center text-sm text-[#71717A]">
          케찹이는 데스크톱 앱에서만 사용할 수 있습니다.
        </div>
      </div>
    );
  }

  const canvasActive = Boolean(canvas.runId);
  const busy = starting || stopping || view.isRunning || canvas.isBusy;
  const agentPending = view.isRunning || view.waitingQuestion !== null;
  const canvasPending = canvas.isBusy || canvas.interrupt !== null;
  const activeRunId = agentPending
    ? view.runId
    : canvasPending
      ? canvas.runId
      : null;

  const stopWorkflow = async () => {
    if (stopping) return;
    if (awaitingContractRequest && !starting) {
      setInput("");
      navigate(location.pathname, { replace: true, state: null });
      return;
    }
    if (!activeRunId) return;
    setStopping(true);
    setStartError(null);
    try {
      await api.cancelRun(activeRunId);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(false);
    }
  };

  const continueWorkflow = () => {
    if (view.action?.type === "work_sources") setDismissedActionId(null);
    else if (
      view.action?.type === "business_tool" ||
      canvas.interrupt?.type === "awaiting_anchor_choice"
    ) {
      promptRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      promptRef.current?.focus({ preventScroll: true });
    } else {
      if (canvas.interrupt?.type === "awaiting_edit") canvasRun.reopen();
      inputRef.current?.focus();
    }
  };

  const toggleMemory = async (enabled: boolean) => {
    setMemoryEnabled(enabled);
    setMemoryStatus(null);
    try {
      await api.setMemoryEnabled(WORKSPACE_ID, enabled);
    } catch (cause) {
      setMemoryEnabled(!enabled);
      setMemoryStatus(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    if (canvasActive && canvas.interrupt?.type === "awaiting_edit") {
      setInput("");
      await canvasRun.sendFeedback(text);
      return;
    }
    if (canvasActive && canvas.interrupt?.type === "awaiting_anchor_choice")
      return;
    if (view.waitingQuestion !== null) {
      setInput("");
      await resume(text);
      return;
    }
    setInput("");
    await startRequest(
      text,
      awaitingContractRequest ? "doc" : "auto",
      selectedId,
    );
  };

  /** mode "auto" lets registered workflow descriptions pick the route; any other mode is a workflow ID. */
  const startRequest = async (
    text: string,
    mode: string,
    threadId: string | null,
  ) => {
    setStartError(null);
    setStarting(true);
    try {
      let target = threadId;
      if (!target) {
        target = (await createThread())?.id ?? null;
        if (target)
          navigate(`/agent/${target}`, {
            state: awaitingContractRequest ? { workflow: "doc" } : null,
          });
      }
      if (!target) return;
      const started = await api.startRun({
        threadId: target,
        workspaceId: WORKSPACE_ID,
        text,
        mode,
      });
      if (started.kind === "canvas") canvasRun.attach(started.runId);
      else attachAgent(started.runId, started.action, started.status);
      void reload(target);
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  const placeholder = (() => {
    if (awaitingContractRequest)
      return "계약서 종류와 주요 조건을 입력해 주세요";
    if (canvas.interrupt?.type === "awaiting_anchor_choice")
      return "위에서 참고할 표준 양식을 선택해 주세요";
    if (canvas.actionContexts.length > 1)
      return `선택한 ${canvas.actionContexts.length}개 블록에 적용할 내용을 입력하세요`;
    if (canvas.actionContexts[0]?.op === "edit")
      return "선택한 블록을 어떻게 수정할지 입력하세요";
    if (canvas.actionContexts[0]?.op === "add")
      return "선택한 블록 아래에 추가할 내용을 입력하세요";
    if (canvas.interrupt?.type === "awaiting_edit")
      return "문서 전체에 대한 수정 의견을 입력하세요 (재작성)";
    if (view.waitingQuestion !== null)
      return "에이전트의 질문에 답해 주세요...";
    return "무엇을 도와드릴까요? 예: 계약서 초안 작성, 일일자금일보 작성";
  })();
  const errorText = startError ?? view.error ?? canvas.error ?? null;
  const responsePersisted = Boolean(
    !view.isRunning &&
    view.runId &&
    view.streamingText &&
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.runId === view.runId &&
        message.content === view.streamingText,
    ),
  );
  const streamingText = responsePersisted ? "" : view.streamingText;
  const workflowStatus = (() => {
    if (stopping) return "작업을 중단하는 중...";
    if (starting) return "요청을 준비하는 중...";
    if (view.isRunning) return phaseLabel(view.phase) || "작업 중...";
    if (canvas.isBusy)
      return canvasPhaseLabel(canvas.phase) || "문서를 처리하는 중...";
    if (view.action) return `${view.action.title} · 입력 대기`;
    if (canvas.interrupt?.type === "awaiting_anchor_choice")
      return "계약서 작성 · 참고 문서 선택 대기";
    if (canvas.interrupt?.type === "awaiting_edit")
      return "문서 작성 · 초안 검토 및 수정 대기";
    if (view.waitingQuestion !== null)
      return "답변 대기 · 아래에 답변을 입력해 주세요";
    if (awaitingContractRequest) return "계약서 작성 · 요청 입력 대기";
    return "진행 중인 업무가 없습니다";
  })();
  const canContinue =
    !busy && (awaitingContractRequest || agentPending || canvasPending);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden font-['Inter',sans-serif]">
      <NavRail tab={tab} onChange={setTab} />
      <Sidebar />

      <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-white dark:bg-[#0F0F0F]">
        <div className="flex items-center gap-3 h-[60px] px-6 border-b border-[#E4E4E7] dark:border-[#27272A]">
          <span className="text-lg font-semibold text-[#18181B] dark:text-[#FAFAFA]">
            {TAB_TITLES[tab]}
          </span>
          {tab === "home" && (
            <span className="text-xs text-[#71717A]">
              현재 질문은 이 대화에만 적용됩니다.
            </span>
          )}
        </div>

        {tab !== "home" && (
          <div
            role="tabpanel"
            className="flex-1 overflow-y-auto px-6 md:px-8 py-6"
          >
            <div className="mx-auto w-full max-w-3xl">
              {tab === "work" && (
                <>
                  <p className="mb-4 text-sm text-[#71717A]">
                    실행할 업무를 고르면 새 대화에서 안내합니다.
                  </p>
                  <WorkflowLauncher
                    disabled={busy}
                    onStart={(workflow) => {
                      setTab("home");
                      if (workflow.mode === "doc") {
                        setInput("");
                        setStartError(null);
                        navigate("/agent", { state: { workflow: "doc" } });
                        return;
                      }
                      void startRequest(workflow.label, workflow.mode, null);
                    }}
                  />
                </>
              )}
              {tab === "upload" && (
                <>
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-[#18181B] dark:text-[#FAFAFA]">
                    <LuFolderSearch className="h-4 w-4" />
                    검색 폴더
                  </h3>
                  <p className="mb-4 text-xs leading-relaxed text-[#71717A]">
                    활성화한 폴더만 검색하며, 답변에는 실제 인용한 문서가
                    표시됩니다. 일일자금일보 같은 Excel 업무도 이 폴더에서 전일
                    일보·주간계획·자금현황표를 파일명으로 찾아 미리 채웁니다.
                  </p>
                  <CollectionPanel
                    collections={collectionsState.collections}
                    error={collectionsState.error}
                    onAdd={() => void collectionsState.add()}
                    onRemove={(name) => void collectionsState.remove(name)}
                    onSync={(name) => void collectionsState.sync(name)}
                    onToggle={(name, active) =>
                      void collectionsState.setActive(name, active)
                    }
                  />
                </>
              )}
              {tab === "context" && (
                <section>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-[#18181B] dark:text-[#FAFAFA]">
                      <LuBrain className="h-4 w-4" />
                      저장된 컨텍스트
                    </h3>
                    <label className="flex items-center gap-1.5 text-xs text-[#71717A]">
                      <input
                        type="checkbox"
                        checked={memoryEnabled}
                        onChange={(event) =>
                          void toggleMemory(event.target.checked)
                        }
                      />
                      사용
                    </label>
                  </div>
                  <p className="mb-4 mt-1 text-xs leading-relaxed text-[#71717A]">
                    {memoryEnabled
                      ? "고정한 항목은 항상, 나머지는 관련 질문에서 사용합니다."
                      : "꺼져 있어 저장된 컨텍스트를 답변에 사용하지 않습니다."}
                  </p>
                  {memoryStatus && (
                    <p className="mb-3 text-xs text-[#DC2626]">
                      {memoryStatus}
                    </p>
                  )}
                  <MemoryPanel
                    memories={memoriesState.memories}
                    onAdd={memoriesState.add}
                    onUpdate={memoriesState.update}
                    onPin={memoriesState.setPinned}
                    onConfirm={memoriesState.confirm}
                    onDelete={memoriesState.remove}
                  />
                </section>
              )}
              {tab === "settings" && (
                <>
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-[#18181B] dark:text-[#FAFAFA]">
                    <LuSettings className="h-4 w-4" />
                    모델 연결
                  </h3>
                  {modelConfigurable ? (
                    <>
                      <p className="mb-4 text-xs leading-relaxed text-[#71717A]">
                        LiteLLM 게이트웨이와 사용할 모델을 지정합니다. 기본
                        모델은 loki입니다.
                      </p>
                      <ModelSettingsForm api={api} />
                    </>
                  ) : (
                    <p className="text-xs text-[#71717A]">
                      이 배포판은 모델 연결이 고정되어 있어 변경할 수 없습니다.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <div className={tab === "home" ? "flex flex-1 min-h-0" : "hidden"}>
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            <div className="flex-1 overflow-y-auto px-6 md:px-8 py-4">
              <div className="mx-auto w-full max-w-3xl">
                <AgentMessages
                  initialPrompt={
                    awaitingContractRequest
                      ? "어떤 계약서 작성을 도와드릴까요?"
                      : undefined
                  }
                  messages={messages}
                  streamingText={streamingText}
                  streamingRunId={view.runId}
                  streamingCitations={responsePersisted ? [] : view.citations}
                  streamingAppliedContext={
                    responsePersisted ? { memories: [] } : view.appliedContext
                  }
                  progressText={null}
                  hasMore={hasMore}
                  onLoadOlder={() => void loadOlder()}
                  onOpenCitation={(runId, evidenceId) =>
                    void api.openCitation(runId, evidenceId)
                  }
                />
                {view.action?.type === "business_tool" && view.runId && (
                  <div
                    ref={promptRef}
                    tabIndex={-1}
                    aria-label={`${view.action.title} 입력 대기`}
                  >
                    <BusinessToolCard
                      key={view.action.id}
                      api={api}
                      runId={view.runId}
                      action={view.action}
                    />
                  </div>
                )}
                {canvas.interrupt?.type === "awaiting_anchor_choice" && (
                  <div ref={promptRef} tabIndex={-1} aria-label="참고 문서 선택">
                    <AnchorChoicePrompt
                      candidates={canvas.interrupt.candidates}
                      selectedIds={canvas.selectedAnchorIds}
                      disabled={canvas.isBusy}
                      onToggle={canvasRun.toggleAnchor}
                      onSubmit={(action) =>
                        void canvasRun.submitAnchorChoice(action)
                      }
                    />
                  </div>
                )}
                {canvas.canvas && canvasRun.showMissingTermsForm && (
                  <MissingTermsForm
                    terms={canvas.canvas.missing_terms}
                    disabled={canvas.isBusy}
                    onSubmit={canvasRun.submitMissingTerms}
                  />
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="px-6 md:px-8 pb-4">
              <div className="mx-auto w-full max-w-3xl">
                {errorText && (
                  <div className="mb-2 text-xs text-[#DC2626]">{errorText}</div>
                )}
                {canvas.actionContexts.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {canvas.actionContexts.map((context) => (
                      <span
                        key={
                          context.op === "edit"
                            ? `edit:${context.block_id}`
                            : `add:${context.after_block_id}`
                        }
                        className="inline-flex items-center gap-2 rounded-full border border-[#0066FF] bg-[#EFF6FF] px-3 py-1 text-xs font-medium text-[#0066FF] dark:bg-[#0B1B33]"
                      >
                        {context.label}{" "}
                        {context.op === "edit" ? "수정" : "아래 추가"}
                        <button
                          type="button"
                          onClick={() => canvasRun.removeContext(context)}
                          className="rounded-full hover:bg-[#0066FF] hover:text-white w-4 h-4 leading-none"
                          title="선택 해제"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {canvas.canvas && canvas.hidden && (
                  <button
                    type="button"
                    onClick={canvasRun.reopen}
                    className="inline-flex items-center gap-1 mb-2 rounded border border-[#D4D4D8] dark:border-[#52525B] p-2 bg-white dark:bg-[#18181B] text-sm text-black dark:text-white"
                  >
                    <LuFileText aria-hidden />
                    {canvas.canvas.title || "문서"} 다시 열기
                  </button>
                )}
                {selectedId && (
                  <BusinessArtifacts
                    api={api}
                    threadId={selectedId}
                    running={view.isRunning}
                  />
                )}
                <div
                  role="group"
                  aria-label="워크플로 상태"
                  className="flex flex-wrap items-center gap-3 mb-2 rounded-lg border border-[#E4E4E7] dark:border-[#27272A] bg-[#F4F4F5] dark:bg-[#1F1F1F] px-3 py-2 text-sm"
                >
                  <LuCirclePause
                    aria-hidden
                    className="w-4 h-4 shrink-0 text-[#0066FF]"
                  />
                  <span
                    role="status"
                    className="flex-1 font-medium text-[#18181B] dark:text-[#FAFAFA]"
                  >
                    {workflowStatus}
                  </span>
                  {canContinue && (
                    <button
                      type="button"
                      onClick={continueWorkflow}
                      className="rounded bg-[#0066FF] px-3 py-1 font-medium text-white"
                    >
                      이어가기
                    </button>
                  )}
                  {(activeRunId || awaitingContractRequest || starting) && (
                    <button
                      type="button"
                      disabled={stopping || (!activeRunId && starting)}
                      onClick={() => void stopWorkflow()}
                      className="rounded px-3 py-1 text-[#DC2626] hover:bg-[#FEE2E2] dark:hover:bg-[#3B1111] disabled:opacity-40"
                    >
                      작업 중단
                    </button>
                  )}
                </div>
                <form
                  onSubmit={submit}
                  className="flex items-end gap-2 p-2 rounded-xl border border-[#E4E4E7] dark:border-[#27272A]"
                >
                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void submit(event);
                      }
                    }}
                    placeholder={placeholder}
                    disabled={canvas.interrupt?.type === "awaiting_anchor_choice"}
                    rows={2}
                    className="flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none text-[#18181B] dark:text-[#FAFAFA]"
                  />
                  {busy ? (
                    <button
                      type="button"
                      disabled={stopping || !activeRunId}
                      onClick={() => void stopWorkflow()}
                      className="p-2 text-[#DC2626]"
                      title="중단"
                    >
                      <FaStopCircle className="w-5 h-5" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!input.trim()}
                      className="p-2 text-[#0066FF] disabled:opacity-40"
                      title="보내기"
                    >
                      <IoSend className="w-5 h-5" />
                    </button>
                  )}
                </form>
              </div>
            </div>
          </div>

          {canvas.canvas && !canvas.hidden && (
            <CanvasPanel
              canvas={canvas.canvas}
              changedBlockIds={canvas.changedBlockIds}
              canUndo={
                canvas.interrupt?.type === "awaiting_edit" &&
                canvas.interrupt.can_undo
              }
              canRedo={
                canvas.interrupt?.type === "awaiting_edit" &&
                canvas.interrupt.can_redo
              }
              onClose={canvasRun.close}
              activeActionContexts={canvas.actionContexts}
              onEditBlock={canvasRun.startEditBlock}
              onAddBlockAfter={canvasRun.startAddBlockAfter}
              onDeleteBlock={canvasRun.deleteBlock}
              onUpdateBlockContent={canvasRun.updateBlockContent}
              onChangeVersion={canvasRun.changeVersion}
              onFinalize={canvasRun.finalize}
              onOpenSource={(documentId) =>
                canvas.canvas &&
                void api.openCanvasSource(canvas.canvas.canvas_id, documentId)
              }
            />
          )}
        </div>
      </div>

      {view.action?.type === "work_sources" &&
        view.runId &&
        view.action.id !== dismissedActionId && (
          <WorkSourcePanel
            key={view.action.id}
            api={api}
            request={{ runId: view.runId, actionId: view.action.id }}
            onClose={() => setDismissedActionId(view.action!.id)}
          />
        )}
    </div>
  );
};

export default AgentPage;
