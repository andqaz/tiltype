/**
 * Проверяет опубликованный Worker через настоящий декодер WebAssembly.
 * Использует ресурсы каталога desktop и проверяет ответы на трёх языках.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../desktop");
const read = name => fs.readFileSync(path.join(root, name));

test("The packaged worker loads the compact model and completes three languages", async () => {
  let reply;
  const context = vm.createContext({ TextEncoder, TextDecoder, postMessage(value) { reply = value; } });
  vm.runInContext(read("runtime/worker.js").toString(), context);
  const weights = read("models/writer.fp16");
  assert.equal(weights.length, 8188675 * 2);
  await context.onmessage({data: {
    id: 1, wasm: read("runtime/decoder.wasm"),
    weights: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
    tokenizer: JSON.parse(read("models/tokenizer.json")), threshold: JSON.parse(read("models/config.json")).threshold
  }});
  assert.equal(reply.ready, true, reply.error);
  for (const [language, text] of [["ru","Для согласования проекта "], ["en","After reviewing the plan "], ["kk","Жобаны іске асыру үшін "]]) {
    await context.onmessage({data: {id: 2, text, language}});
    assert.ok(reply.choices?.some(word => word.trim()), reply.error || language);
  }
});
