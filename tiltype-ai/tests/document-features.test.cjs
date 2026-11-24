/** Проверяет приоритет последних предложений при поиске точного продолжения. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Раннее предложение помогает только при отсутствии совпадения в недавней истории", () => {
  const source = readFileSync(resolve(__dirname, "../plugin/scripts/document-features.js"), "utf8");
  const features = runInNewContext(source + "\nneuralDocumentFeatures");
  const recent = Array.from({ length: 6 }, () => "Вопрос обсуждался на общем собрании.");
  const history = ["Вчера мы согласовали итоговый отчёт с комиссией.", ...recent];
  const context = ["согласовали", "итоговый", "отчёт"];
  const model = { vocabulary: new Map(), embedding: { columns: 1 } };

  const older = features.alternatives([], history, context, model);
  assert.equal(older[0].choice, "с комиссией");
  const updated = [...history.slice(0, -1), "Сегодня согласовали итоговый отчёт без замечаний."];
  const newer = features.alternatives([], updated, context, model);
  assert.equal(newer[0].choice, "без замечаний");
  assert.equal(newer.length, 1);
});
