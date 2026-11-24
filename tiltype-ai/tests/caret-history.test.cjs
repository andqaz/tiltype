/** Проверяет чтение истории слева от курсора через подмену Office API. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Диапазон истории заканчивается курсором, а несовпадающий текст отбрасывается", () => {
  const source = readFileSync(resolve(__dirname, "../plugin/scripts/caret.js"), "utf8");
  const before = "Отчёт отправлен в ";
  const previous = "Предыдущий абзац.\n";
  let rangeText = previous + before;
  let requested;
  const scope = { tiltypeReadDocumentHistory: true };
  const read = runInNewContext(source + "\nreadNeuralCaret", {
    Asc: { scope },
    Api: { GetDocument: () => ({
      GetRangeBySelect: () => ({ GetStartPos: () => 6000, GetEndPos: () => 6000 }),
      GetCurrentParagraph: () => ({ GetInternalId: () => "paragraph" }),
      GetCurrentSentence: (part) => part === "before" ? before : "",
      GetRange: (start, end) => {
        requested = [start, end];
        return { GetText: () => rangeText };
      },
    }) },
  });
  assert.equal(read().history, previous);
  assert.deepEqual(requested, [6000 - 4096 - before.length, 6000]);
  rangeText += "Будущий текст";
  assert.equal(read().history, undefined);
  scope.tiltypeReadDocumentHistory = false;
  requested = undefined;
  assert.equal(read().history, undefined);
  assert.equal(requested, undefined);
});
