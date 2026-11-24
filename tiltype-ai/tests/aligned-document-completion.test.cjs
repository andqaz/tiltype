/**
 * Проверяет перенос фразы через несовпадающее слово в исходной конструкции.
 * Защищает порядок текущих вариантов и границы пунктуации при переносе.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runInNewContext } = require("node:vm");

test("Похожая конструкция дополняет свободное место и не объединяет слова через запятую", () => {
  const modules = ["ordered-phrase-alignment.js", "aligned-document-completion.js"].map(name =>
    fs.readFileSync(path.join(__dirname, "../plugin/scripts", name), "utf8"));
  const completion = runInNewContext(modules.join("\n") + "\nneuralAlignedDocumentCompletion");
  const prefix = "Please review the revised quarterly document ";
  const selected = { context: prefix.trim().toLowerCase().split(" "), language: "en",
    model: { vocabulary: new Map(), phraseEvidence: () => "before the meeting" } };
  const options = ["first", "check"];
  const history = "Please review the draft revised quarterly document before the meeting.";
  assert.deepEqual([...completion.append(options, prefix, history, selected)], ["first", "check", "before the"]);
  assert.equal(completion.append(options, prefix, history.replace("before the", "before, the"), selected), options);
  const full = [...options, "wait"];
  assert.equal(completion.append(full, prefix, history, selected), full);
});
