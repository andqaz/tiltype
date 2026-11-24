/**
 * Проверяет очередь TilType на SDK с одним обработчиком ответа.
 * Воспроизводит параллельный запрос автозамены и чтения для прогноза.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

test("Чтение прогноза дожидается ответа автозамены и сохраняет свои данные", async () => {
  const path = resolve(__dirname, "../plugin/scripts/editor-command-queue.js");
  const install = vm.runInNewContext(readFileSync(path, "utf8") + "\ninstallEditorCommandQueue", { queueMicrotask });
  const sdk = { scope: { word: "руддщ" } };
  const sent = [];
  const results = [];
  let handler;
  const plugin = {
    callCommand(command, _close, _recalculate, callback) {
      sent.push([command.name, sdk.scope.word]);
      handler = callback;
    },
  };
  install(plugin, sdk);
  const replace = function replace() {};
  const read = function read() {};
  plugin.callCommand(replace, false, true, (result) => results.push(result));
  sdk.scope = { word: "hello" };
  plugin.callCommand(read, false, false, (result) => results.push(result));
  sdk.scope = { word: "later" };

  assert.deepEqual(sent, [["replace", "руддщ"]]);
  handler(true);
  handler = undefined;
  await Promise.resolve();
  assert.deepEqual(sent, [["replace", "руддщ"], ["read", "hello"]]);
  assert.equal(sdk.scope.word, "later");
  handler("hello world");
  await Promise.resolve();
  assert.deepEqual(results, [true, "hello world"]);
});
