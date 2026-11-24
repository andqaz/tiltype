/** Проверяет компактный поиск частот и безопасное добавление варианта в список. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const scripts = ["phrase-alternative-index", "phrase-alternative"].map(name =>
  readFileSync(resolve(__dirname, `../plugin/scripts/${name}.js`), "utf8"));
const { index, ranker } = runInNewContext([...scripts,
  "({ index: neuralPhraseAlternativeIndex, ranker: neuralPhraseAlternative })"].join("\n"));

test("Вариант появляется на свободном месте и сохраняет исходный порядок", () => {
  const resource = index.open("constructor\t0\tname,0.123456789125\nотправили\t10\tотчёт,9\nсегодня отправили\t10\tотчёт,9\n");
  const history = "Раньше мы сегодня отправили отчёт.\nВчера мы сегодня отправили отчёт.";
  const context = ["мы", "сегодня"];
  const model = { vocabulary: new Map(), alternativePriors: resource };
  assert.equal(index.lookup(resource, "constructor").get("name"), 0.123456789125);
  assert.equal(index.lookup(resource, "отправили").get("отчёт"), 0.9);
  assert.equal(index.lookup(resource, "сегодня").size, 0);
  const old = ["отправили", "написали"];
  assert.deepEqual(Array.from(ranker.append(old, old, history, context, "ru", model)), ["отправили", "написали", "отправили отчёт"]);
  const full = [...old, "обсудили"];
  assert.equal(ranker.append(full, old, history, context, "ru", model), full);
});
