/* Команды чтения и вставки для Office API. */
function readPredictionCaret() {
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  const paragraph = document.GetCurrentParagraph();
  if (!range || !paragraph || range.GetStartPos() !== range.GetEndPos()) return null;
  if (document.GetCurrentSentence("after").trim()) return null;
  let before = document.GetCurrentSentence("before").slice(-600);
  const accepted = Asc.scope?.tiltypeAcceptedSuffix;
  if (accepted) {
    const tail = paragraph.GetText({Numbering:false, Math:false}).replace(/[\r\n]+$/u, "").slice(-600);
    if (!tail.replaceAll("’", "'").endsWith(accepted.replaceAll("’", "'"))) return null;
    before = tail;
  }
  const typed = Asc.scope?.tiltypePredictionPrefix;
  if (typed) {
    if (before.match(/\p{L}+$/u)?.[0] !== typed) return null;
  } else if (!accepted && !/\p{L}(?:[,;:]|[ \t]+(?:[—–]|1[0-9]{3}|20[0-9]{2}))? $/u.test(before)) return null;
  const position = range.GetStartPos();
  /** @type {PredictionCaret} */
  const caret = { paragraphId: paragraph.GetInternalId(), position, before, ...(accepted && {paragraphTail:true}) };
  if (!Asc.scope?.tiltypeReadDocumentHistory || typeof document.GetRange !== "function" || position <= before.length) return caret;
  const historyLimit = 4096;
  try {
    const start = Asc.scope?.tiltypeFullHistory ? 0 : Math.max(0, position - historyLimit - before.length);
    const separators = { ParaSeparator: "\n", TableRowSeparator: "\n", NewLineSeparator: "\n" };
    const source = document.GetRange(start, position);
    const text = source?.GetText(separators);
    if (Asc.scope?.tiltypeFullHistory && typeof text === "string" && text.endsWith(before)) caret.priorText = text.slice(0,-before.length);
    if (typeof text === "string" && text.endsWith(before)) caret.history = text.slice(0, -before.length).slice(-historyLimit);
    if (caret.paragraphId !== Asc.scope.tiltypeDocumentTopicParagraph) {
      // Возвращаем сжатую тему, сохраняя соседние предложения в отдельном поле.
      const older = start > 0 ? document.GetRange(0, start)?.GetText(separators) : "";
      const counts = new Map();
      for (const match of (older ?? "").toLowerCase().matchAll(/\p{L}{5,25}/gu)) {
        const word = match[0];
        counts.set(word, Math.min(24, (counts.get(word) ?? 0) + 1));
      }
      caret.documentTopic = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 96);
    }
  } catch (error) {
    console.warn("TilType AI: document history unavailable", error);
  }
  return caret;
}

/**
 * Применяет действие в позиции, для которой редактор показал прогноз.
 * @returns {boolean} Редактор применил действие.
 */
function applyPredictionAtCaret() {
  const { caret, text } = Asc.scope.tiltypePrediction;
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  if (!range || range.GetStartPos() !== caret.position || range.GetEndPos() !== caret.position ||
      document.GetCurrentParagraph()?.GetInternalId() !== caret.paragraphId ||
      !(caret.paragraphTail ? document.GetCurrentParagraph()?.GetText({Numbering:false, Math:false}).replace(/[\r\n]+$/u, "") :
        document.GetCurrentSentence("before"))?.endsWith(caret.before) ||
      document.GetCurrentSentence("after").trim()) return false;
  return text ? document.EnterText(text) : document.InsertParagraphBreak();
}
