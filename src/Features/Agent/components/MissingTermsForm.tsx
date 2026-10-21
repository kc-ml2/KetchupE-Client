import { useState } from "react";
import { CanvasTermValue } from "@app-types/CanvasEdit.types";
import { MissingTerm } from "@app-types/Canvas.types";
import KetchupE from "@images/rag.png";

interface MissingTermsFormProps {
  terms: MissingTerm[];
  disabled?: boolean;
  onSubmit: (terms: CanvasTermValue[]) => boolean;
}

const getTermKey = (term: MissingTerm): string => term.term_key || term.label;

const MissingTermsForm = ({
  terms,
  disabled = false,
  onSubmit,
}: MissingTermsFormProps) => {
  const [values, setValues] = useState<Record<string, string>>({});

  const normalizedTerms = terms.map((term) => ({
    ...term,
    term_key: getTermKey(term),
  }));

  const hasValue = normalizedTerms.some(
    (term) => values[term.term_key]?.trim(),
  );

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !hasValue) return;

    const submittedTerms = normalizedTerms
      .map((term) => ({
        term_key: term.term_key,
        label: term.label,
        value: values[term.term_key]?.trim() ?? "",
      }))
      .filter((term) => term.value);

    if (submittedTerms.length === 0) return;
    if (!onSubmit(submittedTerms)) return;
    setValues({});
  };

  if (normalizedTerms.length === 0) return null;

  return (
    <div className="flex flex-col mb-3 items-start">
      <div className="flex items-start flex-row w-full max-w-2xl">
        <img src={KetchupE} alt="Assistant" className="w-7 h-7 object-cover" />
        <form
          onSubmit={handleSubmit}
          className="ml-0 px-4 py-3 rounded-2xl border border-[#FDE68A] dark:border-[#713F12] bg-[#FFFBEB] dark:bg-[#271C0B] text-[#78350F] dark:text-[#FCD34D] rounded-br-md mr-12 max-w-[85%] w-full"
        >
          <div className="mb-3">
            <h3 className="text-sm font-semibold">작성이 필요한 항목</h3>
            <p className="mt-1 text-xs leading-relaxed">
              값을 입력하면 현재 계약서 초안에 반영해 요청합니다.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {normalizedTerms.map((term) => (
              <label key={term.term_key} className="flex flex-col gap-1">
                <span className="text-xs font-medium">{term.label}</span>
                {term.description && (
                  <span className="text-[11px] leading-relaxed opacity-80">
                    {term.description}
                  </span>
                )}
                <input
                  value={values[term.term_key] ?? ""}
                  onChange={(event) =>
                    setValues((prev) => ({
                      ...prev,
                      [term.term_key]: event.target.value,
                    }))
                  }
                  disabled={disabled}
                  className="h-9 rounded-lg border border-[#FCD34D] bg-white px-3 text-sm text-[#18181B] outline-none transition-colors focus:border-[#0066FF] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#92400E] dark:bg-[#171717] dark:text-[#FAFAFA]"
                />
              </label>
            ))}
          </div>

          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={disabled || !hasValue}
              className="rounded-lg bg-[#0066FF] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#0052CC] disabled:cursor-not-allowed disabled:opacity-60"
            >
              적용
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default MissingTermsForm;
