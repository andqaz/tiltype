/** Проверяет восстановление слова из истории и устойчивость к обычному тексту. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const source = readFileSync(resolve(__dirname, "../plugin/scripts/topic-pointer.js"), "utf8");
const { rank } = runInNewContext(source + "\nneuralTopicPointer");

test("Точное продолжение из истории может быть вне словаря модели", () => {
  const model = { phraseEvidence: () => undefined, vocabulary: new Map(), pointerProfile: { profile: {}, global: {}, total: 1 } };
  const history = "Notify the clerk about eastborough.\nAsk the clerk about eastborough.\nTell the clerk about eastborough.";
  const alternatives = ["planning", "permits"];
  assert.deepEqual(Array.from(rank(alternatives, history, ["clerk", "about"], "en", model)),
    ["eastborough", "planning", "permits"]);
  assert.equal(rank(alternatives, history, ["the", "constructor"], "en", model), alternatives);
  assert.equal(rank(alternatives, history, ["clerk", "about"], "en", { ...model, pointerProfile: undefined }), alternatives);
  const phrase = ["planning office"];
  assert.equal(rank(phrase, history, ["clerk", "about"], "en", model), phrase);
});
