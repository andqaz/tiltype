/** Проверяет, когда ранжировщик меняет первый вариант по истории документа. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Та же фраза получает другую подсказку только при опоре на историю", () => {
  const scripts = ["document-passage", "document-continuation"].map(name =>
    readFileSync(resolve(__dirname, `../plugin/scripts/${name}.js`), "utf8"));
  let secondWordCalls = 0;
  const { rank } = runInNewContext([...scripts, "neuralDocumentContinuation"].join("\n"), {
    neuralEngine: { rankWords: () => {
      secondWordCalls += 1;
      return [];
    } },
  });
  const leading = ["review", "finance"];
  const words = ["we", "submitted", "the", "quarterly", "report", "to"];
  const model = { vocabulary: new Map() };
  assert.equal(rank(leading, leading, [], words, "en", model, []), leading);
  assert.equal(rank(leading, leading, ["The draft was circulated yesterday."], words, "en", model, [])[0], "review");
  const history = ["We submitted the quarterly report to finance before lunch."];
  assert.equal(rank(leading, leading, history, words, "en", model, [])[0], "finance");
  assert.equal(rank(leading, leading, history, words, "en", model, [])[0], "finance");
  assert.equal(secondWordCalls, 0);
});
