/** Проверяет подтверждение целой фразы и обработку пунктуации в истории. */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

function loadCompletion() {
  const source = readFileSync(resolve(__dirname, "../plugin/scripts/document-phrase.js"), "utf8");
  return runInNewContext(source + "\nneuralDocumentPhrase").complete;
}

test("Фраза из трёх слов появляется только при совпадающих продолжениях", () => {
  const complete = loadCompletion();
  const prefix = "Мы отправили отчёт ";
  const options = ["в", "после", "утром"];
  const repeated = ["Мы отправили отчёт в городскую комиссию.", "Вчера мы отправили отчёт в городскую комиссию."];
  assert.equal(complete(options, repeated, prefix)[0], "в городскую комиссию");
  assert.equal(complete(options, [repeated[0]], prefix), options);
  assert.equal(complete(options, [...repeated, "Мы отправили отчёт в архив."], prefix), options);
  assert.equal(complete(options, repeated, "Мы отправили, отчёт "), options);
  const interrupted = repeated.map(sentence => sentence.replace("в городскую", "в, городскую"));
  assert.equal(complete(options, interrupted, prefix), options);
});

test("Одинаковое начало получает разные фразы из разных документов", () => {
  const complete = loadCompletion();
  const prefix = "Біз есепті бүгін ";
  const options = ["қалалық", "облыстық"];
  const commission = ["Біз есепті бүгін қалалық комиссияға жібердік.", "Расында, біз есепті бүгін қалалық комиссияға жібердік."];
  const archive = ["Біз есепті бүгін қалалық мұрағатқа тапсырдық.", "Расында, біз есепті бүгін қалалық мұрағатқа тапсырдық."];
  assert.equal(complete(options, commission, prefix)[0], "қалалық комиссияға жібердік");
  assert.equal(complete(options, archive, prefix)[0], "қалалық мұрағатқа тапсырдық");
  assert.equal(complete(options, [...commission, ...archive], prefix), options);
});
