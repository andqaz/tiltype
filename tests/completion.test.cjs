/**
 * Проверяет полноту словарей, поиск вариантов и замену префикса через SDK.
 * Выполняет браузерные скрипты через Node без запуска редактора.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const pluginRoot = resolve(__dirname, "../plugin");
const readPlugin = (file) => readFileSync(resolve(pluginRoot, file), "utf8");
const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(readPlugin("scripts/completion.js"), context);
vm.runInContext(readPlugin("scripts/settings.js"), context);
vm.runInContext(readPlugin("scripts/layout-correction.js"), context);
vm.runInContext(readPlugin("scripts/corrections.js"), context);
const { getPrefix, indexDictionary, suggest } = vm.runInContext("completion", context);

const sourceDictionaries = Object.fromEntries(
  ["en", "ru", "kk"].map((language) => [language, readPlugin(`dictionaries/${language}.txt`)]),
);
const dictionaries = Object.fromEntries(
  Object.entries(sourceDictionaries).map(([language, source]) => [language, indexDictionary(source)]),
);

test("Автоисправления независимы и учитывают выбранный язык", () => {
  const engine = vm.runInContext("corrections", context);
  const spelling = { spelling: true, layout: false, language: "auto" };
  const layout = { spelling: false, layout: true, language: "auto" };
  const correct = (word, options) => engine.suggest(word, options, dictionaries, {})?.text ?? "";

  assert.equal(correct("Teh", spelling), "The");
  assert.equal(correct("пожалуста", spelling), "пожалуйста");
  assert.equal(correct("рақметт", spelling), "рақмет");
  assert.equal(correct("ghbdtn", layout), "привет");
  assert.equal(correct("руддщ", layout), "hello");
  assert.equal(correct("ghbdtn", { ...layout, language: "en" }), "");
  assert.equal(correct("hello", layout), "");
  assert.equal(correct("Қазақстан", spelling), "");
  assert.equal(correct("teh", layout), "");
  assert.equal(correct("TEH", spelling), "");
});

test("Правка учитывает автозаглавную букву и проверяет позицию курсора", () => {
  let text = "Руддщ ";
  let position = text.length;
  let selected = false;
  const run = {
    GetText: () => text,
    MoveCursorToPos(index) { position = index; return true; },
  };
  const editor = {
    GetRangeBySelect: () => ({ GetStartPos: () => position, GetEndPos: () => position + Number(selected) }),
    GetCurrentParagraph: () => ({
      GetInternalId: () => "paragraph",
      GetText: () => text,
      GetRange: (start = 0, end = text.length) => ({ GetStartPos: () => start, GetText: () => text.slice(start, end) }),
    }),
    GetCurrentSentence: (part) => part === "before" ? text.slice(0, position) : text.slice(position),
    GetCurrentRun: () => run,
    GetCurrentWord: () => text.split(" ")[0],
    ReplaceCurrentWord(word) { text = word + " "; return true; },
  };
  const commandContext = vm.createContext({
    Asc: { scope: { autocompleteReplacement: { original: "руддщ", replacement: "hello" } } },
    Api: { GetDocument: () => editor },
  });
  vm.runInContext(readPlugin("scripts/document-replacement.js"), commandContext);
  const replaceAtCaret = vm.runInContext("replaceAtCaret", commandContext);
  selected = true;
  assert.equal(replaceAtCaret(), false);
  selected = false;
  position -= 1;
  assert.equal(replaceAtCaret(), false);
  position += 1;
  const undo = replaceAtCaret();
  assert.equal(text, "Hello ");
  assert.equal(position, text.length);
  assert.equal(undo.fix.original, "Hello ");
  assert.equal(undo.fix.replacement, "Руддщ ");
  assert.equal(undo.fix.end, position);
});

test("Словари расширены и содержат уникальные словоформы", () => {
  for (const dictionary of Object.values(dictionaries)) {
    assert.ok(dictionary.length > 50_000);
    assert.equal(new Set(dictionary.map(({ word }) => word)).size, dictionary.length);
  }
});

test("Поиск работает на трёх языках с сохранением регистра и общим списком кириллицы", () => {
  assert.ok(suggest("DOCUM", dictionaries).includes("DOCUMENT"));
  assert.ok(suggest("Приве", dictionaries).includes("Привет"));
  assert.ok(suggest("Қаз", dictionaries).includes("Қазақстан"));
  assert.ok(suggest("Өне", dictionaries).includes("Өнер"));
  assert.equal(suggest("инф", dictionaries).length, 10);
  assert.deepEqual(Array.from(suggest("инф", {
    ru: indexDictionary("информация\nинформатика"),
    kk: indexDictionary("инфрақұрылым\nинформация"),
  })), ["информация", "инфрақұрылым", "информатика"]);
});

test("Пробел, пунктуация, короткие и смешанные префиксы обрабатываются отдельно", () => {
  assert.equal(getPrefix("Қазақ, (Doc"), "Doc");
  assert.equal(getPrefix("Қазақ, "), "");
  assert.equal(suggest("до", dictionaries).length, 0);
  assert.equal(suggest("абc", dictionaries).length, 0);
  assert.ok(!suggest("document", dictionaries).includes("document"));
});

test("Обработчик использует последний префикс и игнорирует старую подсказку", async () => {
  const events = new Map();
  const calls = [];
  const reads = [];
  const preferences = { spelling: false, layout: true, language: "auto", proofing: false, punctuation: false };
  let caret = { before: "", after: "" };
  let rows;
  let selected = 0;
  const helper = {
    isVisible: false,
    createWindow() {
      plugin.event_onKeyDown = (key) => {
        if (key.keyCode === 40) selected += 1;
        if (key.keyCode === 13) plugin.inputHelper_onSelectItem(rows[selected]);
      };
    },
    setItems(items) { rows = items; selected = 0; },
    getItemsHeight(count) { return count; },
    show(width, height, takeKeyboard) {
      assert.ok(width > 0 && height <= 7);
      assert.equal(takeKeyboard, false);
      this.isVisible = true;
    },
    unShow() { this.isVisible = false; },
  };
  const plugin = {
    info: { editorType: "word" },
    createInputHelper() {},
    getInputHelper: () => helper,
    attachEditorEvent: (event, handler) => events.set(event, handler),
    executeMethod: (method, args) => {
      if (method !== "AddToolbarMenuItem") calls.push([method, ...args]);
    },
    callCommand(command, close, recalculate, callback) {
      assert.equal(close, false);
      assert.equal(recalculate, false);
      reads.push(() => callback(command()));
    },
  };
  class LocalRequest {
    open(method, url) {
      assert.equal(method, "GET");
      this.language = /^dictionaries\/(en|kk|ru)\.txt$/.exec(url)?.[1];
      assert.ok(this.language);
    }
    overrideMimeType() {}
    send() {
      this.status = 200;
      this.responseText = sourceDictionaries[this.language];
      this.onload();
    }
  }

  Object.assign(context, {
    window: { Asc: { plugin } },
    Api: { GetDocument: () => ({ GetCurrentWord: (part) => caret[part] }) },
    XMLHttpRequest: LocalRequest,
    localStorage: { getItem: () => JSON.stringify(preferences) },
    spellcheck: { start: () => Promise.resolve(), dictionaries: {} },
    replaceCompletedWord: (_plugin, original, replacement, onComplete) => {
      calls.push(["AutoCorrect", original, replacement]);
      onComplete(true, { original, replacement });
    },
    undoCompletedWord: (_plugin, edit) => calls.push(["UndoAutoCorrect", edit.replacement, edit.original]),
  });
  vm.runInContext(readPlugin("scripts/dictionaries.js"), context);
  vm.runInContext(readPlugin("scripts/settings-toolbar.js"), context);
  vm.runInContext(readPlugin("scripts/caret-prefix.js"), context);
  vm.runInContext(readPlugin("scripts/proofing-controller.js"), context);
  vm.runInContext(readPlugin("scripts/plugin.js"), context);
  plugin.init();
  await Promise.resolve();

  events.get("onInputHelperInput")({ text: "Сәлем, Қаз" });
  assert.ok(rows.some(({ text }) => text === "Қазақстан"));
  const oldItem = rows[0];
  events.get("onInputHelperInput")({ text: "docu" });
  plugin.inputHelper_onSelectItem(oldItem);
  assert.equal(calls.length, 0);
  plugin.inputHelper_onSelectItem(rows.find(({ text }) => text === "document"));
  assert.deepEqual(calls, [["InputText", "document", "docu"]]);
  assert.equal(helper.isVisible, false);
  events.get("onInputHelperInput")({ text: "Приве" });
  assert.equal(helper.isVisible, true);
  events.get("onKeyDown")({ keyCode: 27 });
  assert.equal(helper.isVisible, false);
  events.get("onInputHelperInput")({ text: "Приве" });
  assert.equal(helper.isVisible, false);
  events.get("onInputHelperInput")({ text: "Привет" });
  events.get("onKeyDown")({ keyCode: 40 });
  const highlighted = rows[1].text;
  events.get("onKeyDown")({ keyCode: 13 });
  assert.deepEqual(calls.at(-1), ["InputText", highlighted, "Привет"]);
  assert.equal(helper.isVisible, false);
  events.get("onInputHelperClear")();
  assert.equal(helper.isVisible, false);

  const typed = ["руддщ", "цщкдв", "рщц", "нщг"];
  for (const word of typed) {
    events.get("onInputHelperInput")({ text: word });
    events.get("onInputHelperInput")({ text: word + " " });
    events.get("onInputHelperClear")();
  }
  assert.deepEqual(calls.slice(-4), [
    ["AutoCorrect", "руддщ", "hello"], ["AutoCorrect", "цщкдв", "world"],
    ["AutoCorrect", "рщц", "how"], ["AutoCorrect", "нщг", "you"],
  ]);
  events.get("onKeyDown")({ keyCode: 27 });
  assert.deepEqual(calls.at(-1), ["UndoAutoCorrect", "you", "нщг"]);
  const callCount = calls.length;
  events.get("onKeyDown")({ keyCode: 27 });
  events.get("onInputHelperInput")({ text: "руддщ" });
  events.get("onKeyDown")({ keyCode: 27 });
  events.get("onInputHelperInput")({ text: "руддщ " });
  events.get("onInputHelperClear")();
  assert.equal(calls.length, callCount);

  // При открытом списке ONLYOFFICE отправляет сброс, минуя onKeyDown.
  events.get("onInputHelperInput")({ text: "document" });
  assert.equal(helper.isVisible, true);
  caret = { before: "documen", after: "" };
  events.get("onInputHelperClear")();
  reads.shift()();
  assert.ok(helper.isVisible && rows.some(({ text }) => text === "document"));
  events.get("onInputHelperInput")({ text: "t" });
  assert.ok(rows.some(({ text }) => text === "documents"));
  plugin.inputHelper_onSelectItem(rows.find(({ text }) => text === "documents"));
  assert.deepEqual(calls.at(-1), ["InputText", "documents", "document"]);

  // Если список закрыт, Backspace может редактировать ранее набранное слово.
  events.get("onKeyDown")({ keyCode: 8 });
  caret = { before: "docu", after: "" };
  events.get("onInputHelperClear")();
  reads.shift()();
  assert.ok(helper.isVisible && rows.some(({ text }) => text === "document"));
  events.get("onInputHelperClear")();
  caret = { before: "doc", after: "u" };
  reads.shift()();
  assert.equal(helper.isVisible, false);

  // Поздний ответ редактора не перезаписывает ввод после удаления.
  events.get("onKeyDown")({ keyCode: 8 });
  events.get("onInputHelperClear")();
  events.get("onInputHelperInput")({ text: "Қаз" });
  caret = { before: "docu", after: "" };
  reads.shift()();
  assert.ok(rows.some(({ text }) => text === "Қазақстан"));

  preferences.spaceAfterEnter = true;
  events.get("onInputHelperInput")({ text: "docu" });
  events.get("onKeyDown")({ keyCode: 40 });
  const keyboardChoice = rows[1].text;
  events.get("onKeyDown")({ keyCode: 13 });
  assert.deepEqual(calls.at(-1), ["InputText", keyboardChoice + " ", "docu"]);

  events.get("onInputHelperInput")({ text: "docu" });
  const mouseChoice = rows[0];
  plugin.inputHelper_onSelectItem(mouseChoice);
  assert.deepEqual(calls.at(-1), ["InputText", mouseChoice.text, "docu"]);
});
