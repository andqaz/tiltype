/**
 * Проверяет, что векторный ранг переносит фразу вперёд и сохраняет
 * другой многословный вариант. Использует малые детерминированные веса.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Тема документа продвигает фразу и сохраняет другой многословный вариант", () => {
  const scripts = ["phrase-alternative-index.js", "document-vector-rank.js"]
    .map(name => readFileSync(resolve(__dirname, "../plugin/scripts", name), "utf8"));
  const { ranker, index } = runInNewContext(scripts.join("\n") + `
    ({ ranker: neuralDocumentVectorRank, index: neuralPhraseAlternativeIndex.open(
      "share the\\t0,10,0\\tdraft today,0,10,0\\n") })`);
  const model = {
    vocabulary: new Map([["budget", 0], ["draft", 1], ["today", 2]]),
    embedding: { columns: 2, values: new Int8Array([3, 0, 2, 0, 1, 0]), scale: new Float32Array([1, 1, 1]) },
  };
  const weights = new Float32Array([1, 0, 0, 1]);
  const options = ["broad", "different", "last term"];
  assert.equal(ranker.rank(options, "share the ", "", model, index, weights), options);
  for (const turn of [0, 1]) {
    assert.deepEqual(Array.from(ranker.rank(options, "share the ", "New budget.", model, index, weights)),
      ["draft today", "broad", "last term"], "Прогноз после обращения " + (turn + 1));
  }
});
