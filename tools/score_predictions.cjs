/**
 * Считает точность и покрытие на позициях, поступающих из measure_predictions.py.
 * Загружает исходный JS-модуль прогноза и шесть словарей без запуска редактора.
 */
"use strict";

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { runInNewContext } = require("node:vm");

const LANGUAGES = ["en", "ru", "kk"];
const CONTEXT_CHARS = 150;
const [directory, runtime] = process.argv.slice(2);
const load = (suffix) => Object.fromEntries(LANGUAGES.map((language) => [
  language, JSON.parse(readFileSync(join(directory, `predict-${language}${suffix}.json`), "utf8")),
]));
const models = load("");
const fallback = load("-fallback");
const suggest = runInNewContext(readFileSync(runtime, "utf8") + "\nnextWord.suggest");
const counts = Object.fromEntries(LANGUAGES.map((language) => [
  language, Array.from({ length: 2 }, () => ({ total: 0, shown: 0, matched: 0 })),
]));

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const [language, partition, before, expected] = JSON.parse(line);
  const result = counts[language][partition];
  const prediction = suggest(before.slice(-CONTEXT_CHARS), "auto", models, fallback);
  result.total += 1;
  result.shown += Number(Boolean(prediction));
  result.matched += Number(prediction?.toLowerCase() === expected.toLowerCase());
});
lines.on("close", () => {
  const report = Object.fromEntries(LANGUAGES.map((language) => {
    const partitions = counts[language].map(({ total, shown, matched }) => ({
      total, matched, accuracy: 100 * matched / total, coverage: 100 * shown / total,
    }));
    return [language, { development: partitions[0], evaluation: partitions[1] }];
  }));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
});
