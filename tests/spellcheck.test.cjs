/**
 * Проверяет браузерную сборку Hunspell с входящими в пакет словарями.
 * Охватывает словоформы, автоисправление и последовательности RU ↔ EN.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

test("Hunspell загружает словари ONLYOFFICE и исправляет слова вне ручного списка", async () => {
  const root = resolve(__dirname, "../plugin");
  const context = vm.createContext({
    console, setTimeout, clearTimeout, WebAssembly, TextDecoder, TextEncoder, crypto, Uint8Array,
    document: { currentScript: null },
    location: { href: "file:///plugin/index.html" },
  });
  context.self = context.window = context;
  context.XMLHttpRequest = class LocalRequest {
    open(_method, url) { this.path = resolve(root, url); }
    send() {
      this.status = 0;
      this.response = Uint8Array.from(readFileSync(this.path)).buffer;
      this.onload();
    }
  };
  const run = (source) => vm.runInContext(source, context, { displayErrors: false });
  for (const path of [
    "vendor/hunspell.js", "scripts/completion.js", "scripts/dictionaries.js",
    "scripts/spellcheck.js", "scripts/layout-correction.js", "scripts/corrections.js", "scripts/proofing-language.js",
  ]) {
    run(readFileSync(resolve(root, path), "utf8"));
  }

  await run("spellcheck.start()");
  const spellcheckers = run("spellcheck.dictionaries");
  const { indexDictionary } = run("completion");
  const engine = run("corrections");
  const ranks = Object.fromEntries(["en", "ru", "kk"].map((language) =>
    [language, indexDictionary(readFileSync(resolve(root, `dictionaries/${language}.txt`), "utf8"))]));

  try {
    const spelling = { spelling: true, layout: false, language: "auto" };
    assert.equal(engine.suggest("acommodation", spelling, ranks, spellcheckers)?.text, "accommodation");
    assert.equal(engine.suggest("термодинамка", spelling, ranks, spellcheckers)?.text, "термодинамика");
    assert.ok(spellcheckers.kk.spell("кітаптарыңыз"));
    assert.equal(engine.suggest("кітаптарңыз", spelling, ranks, spellcheckers)?.text, "кітаптарыңыз");
    assert.equal(engine.suggest("термодинамика", spelling, ranks, spellcheckers), null);
    assert.equal(engine.suggest("Andrey", { ...spelling, layout: true }, ranks, spellcheckers), null);
    assert.equal(engine.suggest("andrey", spelling, ranks, spellcheckers), null);
    assert.equal(engine.suggest("Noreliy", spelling, {}, {
      en: { spell: () => false, suggest: () => ["Noreli"] },
    }), null);
    assert.equal(engine.suggest("noreliy", spelling, {}, {
      en: { spell: () => false, suggest: () => ["noreli"] },
    }), null);

    const layout = { spelling: false, layout: true, language: "auto" };
    const correctPhrase = (words) => {
      let last = null;
      return words.map((word) => {
        const correction = engine.suggest(word, layout, ranks, spellcheckers, last);
        if (correction) last = correction.layout;
        return correction?.text ?? word;
      });
    };
    assert.deepEqual(correctPhrase(["руддщ", "цщкдв", "рщц", "фку", "нщг"]), ["hello", "world", "how", "are", "you"]);
    assert.deepEqual(correctPhrase(["ghbdtn", "rfr", "ltkf", "z"]), ["привет", "как", "дела", "я"]);
    assert.deepEqual(correctPhrase(["руддщ", "мы", "по", "от"]), ["hello", "мы", "по", "от"]);

    const mixed = "⭐ Hello world. Привет, русский текст. Қазақша мәтін.";
    const codepoints = Array.from(mixed);
    const spans = run("proofingLanguage").detect(mixed, spellcheckers);
    assert.deepEqual(Array.from(spans, (span) => [codepoints.slice(span.start, span.end).join(""), span.locale]), [
      ["Hello world", "en-US"], ["Привет", "ru-RU"], ["русский текст", "ru-RU"], ["Қазақша мәтін", "kk-KZ"],
    ]);
  } finally {
    for (const checker of Object.values(spellcheckers)) checker.dispose();
  }
});
