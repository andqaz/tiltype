/**
 * Минимальные типы глобальных объектов команды автокоррекции.
 * ONLYOFFICE предоставляет Api и Asc.scope в изолированном контексте Office API.
 */

declare const Asc: {
  scope: {
    autocompleteReplacement: { original: string; replacement: string };
    autocompleteProofingEdit: { snapshot: ProofingParagraph } &
      ({ spans: ProofingSpan[] } | { fix: DocumentTextFix; atCaret?: boolean });
  };
};

interface DocumentProofingRange {
  GetStartPos(): number;
  GetEndPos(): number;
  GetText(options: { Numbering: boolean; Math: boolean }): string;
  GetTextPr(): { GetLanguage(): string | null } | null;
  SetLanguage(locale: string): DocumentProofingRange | null;
  Select(): boolean;
}

declare const Api: {
  GetDocument(): {
    GetRangeBySelect(): { GetStartPos(): number; GetEndPos(): number } | null;
    GetCurrentSentence(part: "before" | "after"): string;
    GetCurrentParagraph(): {
      GetText(options: { Numbering: boolean; Math: boolean }): string;
      GetInternalId(): string;
      GetRange(start?: number, end?: number): DocumentProofingRange | null;
    } | null;
    GetCurrentRun(): {
      GetText(): string;
      MoveCursorToPos(position: number): boolean;
    } | null | undefined;
    GetCurrentWord(part?: "before" | "after"): string;
    ReplaceCurrentWord(word: string): boolean;
    RemoveSelection(): void;
  };
  ReplaceTextSmart(replacements: string[]): boolean;
  GetPresentation?(): { GetCurrentWord(part?: "before" | "after"): string };
};
