/**
 * Проверяет вычисление распределения из упакованных int8-матриц
 * и наличие рабочей модели для каждого языка установочного пакета.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

const root = resolve(__dirname, "../plugin");
const source = readFileSync(resolve(root, "scripts/engine.js"), "utf8");
const engine = runInNewContext(source + "\nneuralEngine");

test("Нейронный движок сравнивает общий класс и вероятность слова внутри группы", () => {
  const pieces = [];
  let offset = 0;
  /** @param {number[][]} weights @param {number[] | undefined} biases */
  function matrix(weights, biases) {
    const rows = weights.length;
    const columns = weights[0].length;
    const values = Buffer.from(weights.flat());
    const scales = Buffer.alloc(rows * 4);
    for (let index = 0; index < rows; index += 1) scales.writeFloatLE(1, index * 4);
    const spec = { rows, columns, start: offset, scale: offset + values.length, bias: null };
    pieces.push(values, scales);
    offset += values.length + scales.length;
    if (biases) {
      const bytes = Buffer.alloc(rows * 4);
      for (let index = 0; index < rows; index += 1) bytes.writeFloatLE(biases[index], index * 4);
      spec.bias = offset;
      pieces.push(bytes);
      offset += bytes.length;
    }
    return spec;
  }
  const descriptor = {
    words: ["a", "one", "tail", "wins"], shortlist: 2, contextSize: 2, unknownBuckets: 1,
    embedding: matrix([[0], [1], [0], [1], [1], [1]]),
    context: matrix([[0, 1]], [0]),
    head: matrix([[0], [0], [3]], [0, 1, 0]),
    tails: [{ start: 2, projection: matrix([[1]]), classifier: matrix([[0], [3]]) }],
  };
  const bytes = Buffer.concat(pieces);
  const evidence = {};
  const decoded = engine.decode(descriptor, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), evidence);
  assert.equal(engine.suggest("A ", { en: decoded }), "wins");
  assert.equal(engine.suggest("One ", { en: decoded }), "one");
  assert.equal(engine.suggest("A", { en: decoded }), undefined);
  const options = engine.suggestOptions("A ", { en: decoded });
  assert.equal(options[0].split(" ")[0], "wins");
  assert.equal(new Set(options.map(option => option.split(" ")[0])).size, options.length);

  const models = { en: decoded };
  evidence["~a one"] = "topic,85";
  assert.ok(engine.suggestOptions("A one ", models).includes("topic"));
  evidence["a one"] = "wins tail";
  evidence["!a one"] = "wins tail";
  assert.equal(engine.suggestOptions("A one ", models)[0], "wins tail");
});

test("Упакованные модели предлагают слово на всех трёх языках", () => {
  const models = Object.fromEntries(["en", "ru", "kk"].map((language) => {
    const spec = JSON.parse(readFileSync(resolve(root, `models/${language}.json`), "utf8"));
    const bytes = readFileSync(resolve(root, `models/${language}.bin`));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    return [language, engine.decode(spec, buffer)];
  }));
  assert.match(engine.suggest("I would like ", models), /^[a-z'-]+$/iu);
  assert.match(engine.suggest("Пожалуйста напишите ", models), /^[а-яё'-]+$/iu);
  assert.match(engine.suggest("Бұл қазақша ", models), /^[а-яёәғқңөұүһі'-]+$/iu);
  assert.equal(engine.suggest("Проверка, ", models), undefined);
  // Короткая фраза не должна унаследовать токены из предыдущего расчёта.
  const short = engine.suggest("Please ", models);
  engine.suggest("Could you kindly send it tomorrow ", models);
  assert.equal(engine.suggest("Please ", models), short);
});
