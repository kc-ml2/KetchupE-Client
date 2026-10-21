import { useMemo } from "react";
import { LuCopy } from "react-icons/lu";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { Root } from "hast";
import type {
  AppliedContext,
  CitationSummary,
  MemoryKind,
  MessageRecord,
} from "@app-types/Agent.types";

const CITATION = /\[\[(e\d+)\]\]/g;
const CITE_HREF = "#cite-";

/** `[[e1]]` → `[e1](#cite-e1)` so the markdown renderer hands it to the link component as a chip. */
const withCitationLinks = (text: string): string =>
  text.replace(CITATION, `[$1](${CITE_HREF}$1)`);

const chip =
  "inline-flex items-center mx-0.5 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-[#E6F0FF] text-[#0066FF] dark:bg-[#1E293B] align-middle";
const border = "border-[#D4D4D8] dark:border-[#3F3F46]";
const codeBg = "bg-black/5 dark:bg-white/10";
const REQUIRED_INFO_LABELS = [
  "계좌 연결",
  "필수 확인",
  "확인해야 할 정보",
  "필수 정보",
  "주의 사항",
  "참고 사항",
  "연결 정보",
  "다음 정보",
  "추가 확인 사항",
] as const;
const formatCitationLabel = (evidenceId: string): string =>
  evidenceId.replace(/^e/i, "");

/** 저장된 구형 dailyCash 확인문도 새 확인문과 같은 제목·목록으로 표시한다. */
const formatDailyCashReview = (text: string): string => {
  if (!/^계획 대비 실적 차이\r?$/m.test(text) || !/^원화 대사 대상:/m.test(text) || /^\s*(?:`{3}|~{3})/m.test(text)) return text;
  let inSection = false;
  const literal = (value: string) => value.replace(/([\\`*_{}\[\]<>])/g, "\\$1");
  return text.split(/\r?\n/).map((line) => {
    const heading = line.match(/^(계좌 연결|계획 대비 실적 차이|정기예금 집행(?:\s*\([^\n]*\))?|신규 가입|만기|원화 대사 대상|환율)(?::\s*(.*))?$/);
    if (heading) {
      inSection = true;
      return `\n\n### ${heading[1]}\n\n${heading[2] ? `- ${literal(heading[2])}` : ""}`;
    }
    if (line.startsWith("확정하려면")) { inSection = false; return `\n\n${line}`; }
    return inSection && line.trim() ? `- ${literal(line.replace(/^\d+\.\s*/, ""))}` : line;
  }).join("\n");
};

const formatRequiredInfoBlocks = (text: string): string => {
  const blocks = text.split(/\n{2,}/);

  return blocks
    .map((block) => {
      const lines = block
        .split(/\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return "";

      const [firstLine, ...rest] = lines;
      const labelPattern = REQUIRED_INFO_LABELS.map((label) =>
        label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ).join("|");
      const match = firstLine.match(
        new RegExp(`^(${labelPattern})(?::|：)?\\s*(.*)$`),
      );

      if (!match) return block;

      const [, label, inlineValue] = match;
      const bodyLines = [inlineValue.trim(), ...rest].filter(
        (value) => value.length > 0,
      );
      if (label === "계좌 연결") return `### ${label}\n\n${bodyLines.map((line) => `- ${line}`).join("\n")}`;
      if (bodyLines.length === 0) {
        return `> **${label}**`;
      }

      return `> **${label}**\n> ${bodyLines.join("\n> ")}`;
    })
    .join("\n\n");
};

/** Markdown으로 파싱된 계좌 목록만 접어서 코드 블록과 뒤의 확인 항목은 그대로 둔다. */
const collapseAccountList = () => (tree: Root) => {
  for (let i = 0; i < tree.children.length; i++) {
    const heading = tree.children[i];
    if (heading.type !== "element" || !/^h[1-6]$/.test(heading.tagName) || heading.children.length !== 1 || heading.children[0].type !== "text" || heading.children[0].value.trim() !== "계좌 연결") continue;
    let next = i + 1;
    while (next < tree.children.length) {
      const gap = tree.children[next];
      if (gap.type !== "text" || gap.value.trim()) break;
      next++;
    }
    const list = tree.children[next];
    if (list?.type !== "element" || !["ul", "ol"].includes(list.tagName)) continue;
    tree.children.splice(i, next - i + 1, {
      type: "element", tagName: "details", properties: {}, children: [
        { type: "element", tagName: "summary", properties: {}, children: heading.children },
        list,
      ],
    });
  }
};

const buildComponents = (
  runId: string | null,
  onOpenCitation: (runId: string, evidenceId: string) => void,
): Components => ({
  details: ({ children }) => (
    <details className={`my-3 rounded-xl border px-3 py-2 [&>ul]:mt-3 [&>ol]:mt-3 ${border}`}>
      {children}
    </details>
  ),
  summary: ({ children }) => (
    <summary className="cursor-pointer rounded font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0066FF]">
      {children}
    </summary>
  ),
  a: ({ href, children }) => {
    const evidenceId = href?.startsWith(CITE_HREF)
      ? href.slice(CITE_HREF.length)
      : null;
    if (evidenceId) {
      return (
        <button
          type="button"
          disabled={!runId}
          onClick={() => runId && onOpenCitation(runId, evidenceId)}
          className={chip}
          title="원본 위치 열기"
        >
          {formatCitationLabel(evidenceId)}
        </button>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-[#0066FF] underline"
      >
        {children}
      </a>
    );
  },
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-2 mt-1 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-1 text-[15px] font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-5 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  // A fenced block keeps react-markdown's language class; inline code gets the pill styling.
  code: ({ className, children }) =>
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className={`rounded px-1 py-0.5 text-[13px] ${codeBg}`}>
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre
      className={`mb-2 overflow-x-auto rounded-lg p-3 text-[13px] last:mb-0 ${codeBg}`}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote
      className={`mb-2 rounded-xl border border-[#D7D9E5] bg-[#F8FAFC] px-3 py-2 text-[#52525B] last:mb-0 dark:border-[#3F3F46] dark:bg-[#171E2A] dark:text-[#E4E4E7] ${border}`}
    >
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className={`border px-2 py-1 text-left font-semibold ${border}`}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className={`border px-2 py-1 ${border}`}>{children}</td>
  ),
  hr: () => <hr className={`my-3 ${border}`} />,
});

/** Assistant answers are markdown; `[[eN]]` markers render as chips that open the original document. */
export const MessageBody = ({
  text,
  runId,
  onOpenCitation,
}: {
  text: string;
  runId: string | null;
  onOpenCitation: (runId: string, evidenceId: string) => void;
}): React.JSX.Element => {
  const components = useMemo(
    () => buildComponents(runId, onOpenCitation),
    [runId, onOpenCitation],
  );
  return (
    <div className="break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[collapseAccountList]}
        components={components}
      >
        {withCitationLinks(formatRequiredInfoBlocks(formatDailyCashReview(text)))}
      </ReactMarkdown>
    </div>
  );
};

const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  preference: "응답 방식",
  fact: "업무 정보",
  task: "작업",
};

const ContextSources = ({
  citations,
  appliedContext,
  runId,
  onOpenCitation,
}: {
  citations: CitationSummary[];
  appliedContext: AppliedContext;
  runId: string | null;
  onOpenCitation: (runId: string, evidenceId: string) => void;
}): React.JSX.Element | null => {
  if (
    !citations.length &&
    !appliedContext.workspaceInstruction &&
    !appliedContext.memories.length
  )
    return null;
  return (
    <div className="mt-3 pt-2 border-t border-[#D4D4D8] dark:border-[#3F3F46]">
      <div className="mb-2 text-[11px] font-semibold text-[#71717A]">
        사용한 컨텍스트
      </div>
      {citations.length > 0 && (
        <div className="mb-2 flex flex-col items-start gap-1">
          <span className="text-[11px] text-[#71717A]">참고 문서</span>
          {citations.map((citation) => (
            <button
              key={citation.evidenceId}
              type="button"
              disabled={!runId}
              onClick={() =>
                runId && onOpenCitation(runId, citation.evidenceId)
              }
              className="text-left text-xs text-[#0066FF] hover:underline disabled:text-[#71717A]"
            >
              [{formatCitationLabel(citation.evidenceId)}]{" "}
              {citation.title || "제목 없는 문서"}
              {citation.page !== undefined ? ` · ${citation.page}쪽` : ""}
            </button>
          ))}
        </div>
      )}
      {appliedContext.workspaceInstruction && (
        <div className="mb-2 text-xs text-[#52525B] dark:text-[#A1A1AA]">
          <span className="block text-[11px] text-[#71717A]">
            저장된 컨텍스트
          </span>
          {appliedContext.workspaceInstruction}
        </div>
      )}
      {appliedContext.memories.length > 0 && (
        <div className="flex flex-col gap-1 text-xs text-[#52525B] dark:text-[#A1A1AA]">
          <span className="text-[11px] text-[#71717A]">기억</span>
          {appliedContext.memories.map((memory) => (
            <span key={memory.id}>
              · {memory.content}{" "}
              <span className="text-[10px] text-[#A1A1AA]">
                ({MEMORY_KIND_LABEL[memory.kind]})
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

type Props = {
  initialPrompt?: string;
  messages: MessageRecord[];
  streamingText: string;
  streamingRunId: string | null;
  streamingCitations: CitationSummary[];
  streamingAppliedContext: AppliedContext;
  progressText: string | null;
  hasMore: boolean;
  onLoadOlder: () => void;
  onOpenCitation: (runId: string, evidenceId: string) => void;
};

const AgentMessages = ({
  initialPrompt,
  messages,
  streamingText,
  streamingRunId,
  streamingCitations,
  streamingAppliedContext,
  progressText,
  hasMore,
  onLoadOlder,
  onOpenCitation,
}: Props): React.JSX.Element => (
  <div className="flex flex-col gap-3">
    {initialPrompt && (
      <div className="flex justify-start">
        <div className="w-full min-w-0 px-4 py-2.5 rounded-2xl text-sm leading-relaxed bg-[#F4F4F5] dark:bg-[#1F1F1F] text-[#18181B] dark:text-[#FAFAFA]">
          {initialPrompt}
        </div>
      </div>
    )}
    {hasMore && (
      <button
        type="button"
        onClick={onLoadOlder}
        className="self-center text-xs text-[#0066FF] hover:underline"
      >
        이전 대화 더 보기
      </button>
    )}
    {messages.map((message) => (
      <div
        key={message.id}
        className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
      >
        <div
          className={`min-w-0 px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${message.role === "user" ? "max-w-[80%] whitespace-pre-wrap bg-[#0066FF] text-white" : "w-full bg-[#F4F4F5] dark:bg-[#1F1F1F] text-[#18181B] dark:text-[#FAFAFA]"}`}
        >
          {message.role === "assistant" ? (
            <MessageBody
              text={message.content}
              runId={message.runId}
              onOpenCitation={onOpenCitation}
            />
          ) : (
            message.content
          )}
          {message.role === "assistant" && (
            <ContextSources
              citations={message.citations}
              appliedContext={message.appliedContext}
              runId={message.runId}
              onOpenCitation={onOpenCitation}
            />
          )}
          {message.role === "assistant" && (
            <div className="flex items-center gap-2 mt-2 text-[#71717A]">
              <button
                type="button"
                title="답변 복사"
                aria-label="답변 복사"
                onClick={() =>
                  void navigator.clipboard.writeText(message.content)
                }
                className="hover:text-[#0066FF]"
              >
                <LuCopy className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
    ))}
    {streamingText && (
      <div className="flex justify-start">
        <div className="w-full min-w-0 px-4 py-2.5 rounded-2xl text-sm leading-relaxed bg-[#F4F4F5] dark:bg-[#1F1F1F] text-[#18181B] dark:text-[#FAFAFA]">
          <MessageBody
            text={streamingText}
            runId={streamingRunId}
            onOpenCitation={onOpenCitation}
          />
          <ContextSources
            citations={streamingCitations}
            appliedContext={streamingAppliedContext}
            runId={streamingRunId}
            onOpenCitation={onOpenCitation}
          />
        </div>
      </div>
    )}
    {!streamingText && progressText && (
      <div className="flex justify-start">
        <div className="w-full min-w-0 px-4 py-2.5 rounded-2xl text-sm border border-[#D4D4D8] dark:border-[#52525B] bg-transparent text-[#71717A] animate-pulse">
          {progressText}
        </div>
      </div>
    )}
  </div>
);

export default AgentMessages;
