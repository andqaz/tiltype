/** Описывает используемую часть SDK редактора для проверки скриптов TilType AI. */
interface NeuralSuggestionItem { id: string; text: string }
interface NeuralInputHelper {
  createWindow(): void;
  setItems(items: NeuralSuggestionItem[]): void;
  getItemsHeight(count: number): number;
  show(width: number, height: number, takeKeyboard: boolean): void;
  unShow(): void;
}
interface NeuralKey {
  keyCode: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}
interface EditorPlugin {
  createInputHelper(): void;
  getInputHelper(): NeuralInputHelper;
  attachEditorEvent(event: "onInputHelperInput", callback: (entry?: { text?: string }) => void): void;
  attachEditorEvent(event: "onInputHelperClear", callback: () => void): void;
  attachEditorEvent(event: "onKeyDown", callback: (key: NeuralKey) => void): void;
  callCommand(command: () => unknown, close: boolean, recalculate: boolean, callback: (result: unknown) => void): void;
  executeCommand(command: string, data: string): void;
  init?: () => void;
  inputHelper_onSelectItem?: (item: NeuralSuggestionItem | null) => void;
  button?: () => void;
}
declare const Asc: {
  plugin: EditorPlugin;
  scope: {
    tiltypeNeuralPrediction: { caret: NeuralCaret; text: string };
    tiltypeReadDocumentHistory?: boolean;
  };
};
declare const Api: {
  GetDocument(): {
    GetRangeBySelect(): { GetStartPos(): number; GetEndPos(): number } | null;
    GetCurrentParagraph(): { GetInternalId(): string } | null;
    GetCurrentSentence(part: "before" | "after"): string;
    GetRange?(start: number, end: number): {
      GetText(options: { ParaSeparator: string; TableRowSeparator: string; NewLineSeparator: string }): string;
    } | null;
    EnterText(text: string): boolean;
    InsertParagraphBreak(): boolean;
  };
};
