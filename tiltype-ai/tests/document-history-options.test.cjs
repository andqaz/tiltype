/** Проверяет сохранение первой подсказки и границ копируемой фразы. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Свободный вариант получает фразу из истории без перехода через запятую", () => {
  const source = readFileSync(resolve(__dirname, "../plugin/scripts/document-history-options.js"), "utf8");
  const { append } = runInNewContext(source + "\nneuralDocumentHistoryOptions");
  const alternatives = ["подтвердить", "написать"];
  const context = ["просим", "официально", "сегодня"];
  const history = "Просим официально сегодня подтвердить поступление.\nПросим официально сегодня подтвердить поступление.";
  const model = { vocabulary: new Map(), phraseEvidence: () => undefined };
  assert.deepEqual(Array.from(append(alternatives, history, context, "ru", model)),
    ["подтвердить", "написать", "подтвердить поступление"]);
  const interrupted = history.replaceAll("подтвердить поступление", "подтвердить, поступление");
  assert.equal(append(alternatives, interrupted, context, "ru", model), alternatives);
  const full = [...alternatives, "запросить"];
  assert.equal(append(full, history, context, "ru", model), full);
});
