/**
 * Снимает контекст и вставляет подсказку через команды Office API.
 * Проверяет, что курсор остался в прежнем абзаце и позиции.
 */
"use strict";

/** @typedef {{ paragraphId: string, position: number, before: string, history?: string }} NeuralCaret */

/** @returns {NeuralCaret | null} Контекст у свёрнутого курсора в конце предложения. */
function readNeuralCaret() {
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  const paragraph = document.GetCurrentParagraph();
  if (!range || !paragraph || range.GetStartPos() !== range.GetEndPos()) return null;
  if (document.GetCurrentSentence("after").trim()) return null;
  const before = document.GetCurrentSentence("before").slice(-600);
  if (!/\p{L} $/u.test(before)) return null;
  const position = range.GetStartPos();
  /** @type {NeuralCaret} */
  const result = { paragraphId: paragraph.GetInternalId(), position, before };
  if (!Asc.scope?.tiltypeReadDocumentHistory || typeof document.GetRange !== "function" || position <= before.length) {
    return result;
  }
  // Читаем только слева от курсора. Текст диапазона должен совпасть с текущим предложением.
  const historyLimit = 4096;
  try {
    const source = document.GetRange(Math.max(0, position - historyLimit - before.length), position);
    const text = source?.GetText({ ParaSeparator: "\n", TableRowSeparator: "\n", NewLineSeparator: "\n" });
    if (typeof text === "string" && text.endsWith(before)) {
      result.history = text.slice(0, -before.length).slice(-historyLimit);
    }
  } catch (error) {
    console.warn("TilType AI: document history unavailable", error);
  }
  return result;
}

/** @returns {boolean} Вставлена ли подсказка или восстановлен ли перенос абзаца. */
function applyNeuralPrediction() {
  const { caret, text } = Asc.scope.tiltypeNeuralPrediction;
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  if (!range || range.GetStartPos() !== caret.position || range.GetEndPos() !== caret.position ||
      document.GetCurrentParagraph()?.GetInternalId() !== caret.paragraphId ||
      !document.GetCurrentSentence("before").endsWith(caret.before) ||
      document.GetCurrentSentence("after").trim()) return false;
  return text ? document.EnterText(text) : document.InsertParagraphBreak();
}
