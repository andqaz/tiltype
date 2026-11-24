/**
 * Минимальные типы глобальных объектов команды автокоррекции.
 * ONLYOFFICE предоставляет Api и Asc.scope в изолированном контексте Office API.
 */

declare const Asc: {
  scope: {
    tiltypeFormat: {action: string; key: string; value?: string};
    autocompleteReplacement: { original: string; replacement: string };
    tiltypePrediction: { caret: PredictionCaret; text: string };
    tiltypeReadDocumentHistory?: boolean;
    tiltypeDocumentTopicParagraph?: string;
    tiltypeCompletionPrefix?: string;
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
  FromJSON(value: string): unknown;
  GetDocument(): {
    CreateNumbering(type: string): {GetLevel(level: number): unknown};
    GetRangeBySelect(): {
      GetStartPos(): number; GetEndPos(): number;
      GetText(options: {Numbering: boolean; Math: boolean}): string;
      GetAllParagraphs(): Array<{GetInternalId(): string; SetNumbering(level: unknown): void;
        GetParaPr(): {GetJc(): string; SetJc(value: string): void; GetIndLeft(): number; SetIndLeft(value: number): void}}>;
      GetTextPr(): {GetBold(): boolean; GetItalic(): boolean; GetUnderline(): boolean; GetFontSize(): number;
        GetHighlight(): string; GetColor(): {GetRGB(): {r:number;g:number;b:number} | null} | null; GetFontFamily(slot?: "ascii" | "hAnsi"): string | undefined; ToJSON(styles: boolean): string};
      SetBold(value: boolean): void; SetItalic(value: boolean): void; SetUnderline(value: boolean): void;
      SetFontFamily(value: string): void; SetFontSize(value: number): void; SetColor(r: number,g: number,b: number): void;
      SetHighlight(value: string): void; SetTextPr(value: unknown): void;
    } | null;
    GetCurrentSentence(part: "before" | "after"): string;
    GetRange?(start: number, end: number): {
      GetText(options: { ParaSeparator: string; TableRowSeparator: string; NewLineSeparator: string }): string;
    } | null;
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
    EnterText(text: string): boolean;
    InsertParagraphBreak(): boolean;
    RemoveSelection(): void;
  };
  ReplaceTextSmart(replacements: string[]): boolean;
  GetPresentation?(): { GetCurrentWord(part?: "before" | "after"): string };
};
