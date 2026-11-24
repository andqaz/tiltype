/** Проверяет, что пустой список восстанавливается только при сильной опоре на историю. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Сильное повторение восстанавливает слово, посторонняя история оставляет список пустым", () => {
  const source = readFileSync(resolve(__dirname, "../plugin/scripts/document-abstention.js"), "utf8");
  const { suggest } = runInNewContext(source + "\nneuralDocumentAbstention");
  const model = { phraseEvidence: () => undefined };
  const context = ["сегодня", "надо"];
  const history = "Сегодня надо подтвердить отчёт.\nСегодня надо подтвердить итог.";
  const ranked = [{ word: "посмотреть", probability: 0.035 }];
  assert.deepEqual(Array.from(suggest(history, context, "ru", model, ranked)), ["подтвердить"]);
  assert.deepEqual(Array.from(suggest("Открыта новая выставка.", context, "ru", model, ranked)), []);
  assert.deepEqual(Array.from(suggest("", context, "ru", model, ranked)), []);
});

