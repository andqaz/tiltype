/** Проверяет выбор окончания по совпадающим конструкциям и готовым частотам. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Подтверждённая фраза сохраняет первое слово, а слабая сокращается", () => {
  const scripts = ["document-passage", "phrase-confidence"].map(name =>
    readFileSync(resolve(__dirname, `../plugin/scripts/${name}.js`), "utf8"));
  const { apply } = runInNewContext([...scripts, "neuralPhraseConfidence"].join("\n"));
  const context = ["please", "let", "me"];
  const options = ["know where", "ask"];
  const history = ["Please let me know when it is ready.", "Please let me know when you hear back."];
  const model = { phraseEvidence: key => key === "~let me know" ? "when,90" : undefined };
  assert.deepEqual(Array.from(apply(options, options, history, context, "en", model)), ["know when", "ask"]);
  const unrelated = ["The draft was circulated yesterday."];
  assert.deepEqual(Array.from(apply(options, options, unrelated, context, "en", { phraseEvidence: () => undefined })), ["know", "ask"]);
});
