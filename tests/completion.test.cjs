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
const context = vm.createContext({ console, setTimeout, clearTimeout, queueMicrotask });
vm.runInContext(readPlugin("scripts/completion.js"), context);
vm.runInContext(readPlugin("scripts/settings.js"), context);
vm.runInContext(readPlugin("scripts/next-word.js"), context);
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
  assert.equal(correct("еру", layout), "the");
  assert.equal(correct("нщг", layout), "you");
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

test("Прогноз использует пробел и ближайшие слова на трёх языках", () => {
  const models = Object.fromEntries(
    ["en", "ru", "kk"].map((language) => [language, JSON.parse(readPlugin(`dictionaries/predict-${language}.json`))]),
  );
  const predict = (text, language = "auto") => vm.runInContext("nextWord", context).suggest(text, language, models);
  assert.equal(predict("Thank "), "you");
  assert.equal(predict("Thank you "), "for");
  assert.equal(predict("Доброе "), "утро");
  assert.equal(predict("Қайырлы "), "таң");
  assert.equal(predict("Просим вас предоставить "), "документы");
  assert.equal(predict("Қазақстан Республикасының Еңбек "), "кодексі");
  assert.equal(predict("Please see the "), "attached");
  assert.ok(Object.values(models).reduce((total, model) => total + Object.keys(model).length, 0) > 500_000);
  assert.equal(predict("Thank"), undefined);
  assert.equal(predict("Thank, "), undefined);
  assert.equal(predict("Thank  "), undefined);
  assert.equal(predict("СловоОтсутствуетВСловаре "), undefined);
});

test("Прогноз предпочитает длинный контекст и сохраняет составные слова", () => {
  const { suggest: predict } = vm.runInContext("nextWord", context);
  const models = {
    en: {
      free: "software", "the free": "space", "is the free": "version", "where is the free": "parking",
      "can you tell me where is": "the", "don't": "worry", "the company": "has", "^the company": "announced",
    },
    ru: { план: "работы" },
    kk: { план: "бойынша", жоспар: "бойынша" },
  };
  assert.equal(predict("Which is the free ", "auto", models), "version");
  assert.equal(predict("Where is the free ", "auto", models), "parking");
  assert.equal(predict("Can you tell me where is ", "auto", models), "the");
  assert.equal(predict("Check the free ", "auto", models), "space");
  assert.equal(predict("Check: free ", "auto", models), "software");
  assert.equal(predict("  The company ", "auto", models), "announced");
  assert.equal(predict("At the company ", "auto", models), "has");
  assert.equal(predict("Don’t ", "auto", models), "worry");
  assert.equal(predict("план ", "auto", models), undefined);
  assert.equal(predict("план ", "ru", models), "работы");
  assert.equal(predict("Қосымша жоспар ", "auto", models), "бойынша");
});

test("Редкий контекст, окончание и частотное слово дополняют уверенный прогноз", () => {
  const { suggest: predict } = vm.runInContext("nextWord", context);
  const precise = { en: { colour: "palette", "the colour": "green" } };
  const fallback = {
    en: {
      contexts: {
        "the colour": "blue", "my colour": "blue", "it varies": "with",
        "~my colour": "changed", "~~my colour": "faded", "~~see colour": "faded",
        "?my favourite shade": "is", "=ite shade": "matches", "=ite colour": "holds",
        shade: "card",
      },
      suffixes: { ment: "of" },
      defaultWord: "the",
    },
    ru: { contexts: { завтра: "будет" }, suffixes: { ние: "для" }, defaultWord: "и" },
    kk: { contexts: { ертең: "келеді", "+жаңа дық": "ұйым" }, suffixes: { лық: "білім" }, defaultWord: "және" },
  };
  assert.equal(predict("See the colour ", "auto", precise, fallback), "green");
  assert.equal(predict("See my colour ", "auto", precise, fallback), "blue");
  assert.equal(predict("My favourite colour ", "auto", precise, fallback), "changed");
  assert.equal(predict("My very favourite colour ", "auto", precise, fallback), "faded");
  assert.equal(predict("See my favourite colour ", "auto", precise, fallback), "changed");
  assert.equal(predict("My very favourite shade ", "auto", precise, fallback), "is");
  assert.equal(predict("Favourite shade ", "auto", precise, fallback), "matches");
  assert.equal(predict("Favourite colour ", "auto", precise, fallback), "palette");
  assert.equal(predict("Favourite: shade ", "auto", precise, fallback), "card");
  assert.equal(predict("My новая colour ", "auto", precise, fallback), "palette");
  assert.equal(predict("it varies ", "auto", precise, fallback), "with");
  assert.equal(predict("Pretendment ", "auto", precise, fallback), "of");
  assert.equal(predict("quuxxyzzy ", "auto", precise, fallback), "the");
  assert.equal(predict("псевдоизвание ", "auto", precise, fallback), "для");
  assert.equal(predict("абвгдея ", "kk", precise, fallback), "және");
  assert.equal(predict("Қазақша абвгдея ", "auto", precise, fallback), "және");
  assert.equal(predict("Жаңа қоғамдық ", "auto", precise, fallback), "ұйым");
  assert.equal(predict("абвгдея ", "auto", precise, fallback), "и");
  assert.equal(predict("aб ", "auto", precise, fallback), undefined);
  assert.equal(predict("42 ", "auto", precise, fallback), undefined);
  assert.equal(predict("word, ", "auto", precise, fallback), undefined);
});

test("Прогноз применяется только на прежнем курсоре и сохраняет пробел", () => {
  let position = 6;
  let end = position;
  let paragraphId = "paragraph";
  let before = "Thank ";
  let after = "";
  const inserted = [];
  const document = {
    GetRangeBySelect: () => ({ GetStartPos: () => position, GetEndPos: () => end }),
    GetCurrentParagraph: () => ({ GetInternalId: () => paragraphId }),
    GetCurrentSentence: (part) => part === "before" ? before : after,
    EnterText(text) { inserted.push(text); return true; },
    InsertParagraphBreak() { inserted.push("\n"); return true; },
  };
  const commandContext = vm.createContext({ Api: { GetDocument: () => document }, Asc: { scope: {} } });
  vm.runInContext(readPlugin("scripts/next-word.js"), commandContext);
  const caret = vm.runInContext("readPredictionCaret()", commandContext);
  commandContext.Asc.scope.tiltypePrediction = { caret, text: "you " };
  const apply = () => vm.runInContext("applyPredictionAtCaret()", commandContext);

  assert.equal(apply(), true);
  end += 1;
  assert.equal(apply(), false);
  assert.equal(vm.runInContext("readPredictionCaret()", commandContext), null);
  position = end;
  assert.equal(apply(), false);
  position = end = caret.position;
  paragraphId = "another paragraph";
  assert.equal(apply(), false);
  paragraphId = caret.paragraphId;
  before = "There ";
  assert.equal(apply(), false);
  before = "Thank ";
  after = "you";
  assert.equal(apply(), false);
  after = "";
  commandContext.Asc.scope.tiltypePrediction.text = "";
  assert.equal(apply(), true);
  assert.deepEqual(inserted, ["you ", "\n"]);
});

test("Enter создаёт абзац после закрытия списка, если префикс ещё у курсора", () => {
  let word = "docu";
  let end = 4;
  let inserted = 0;
  const editor = {
    GetRangeBySelect: () => ({ GetStartPos: () => 4, GetEndPos: () => end }),
    GetCurrentWord: () => word,
    InsertParagraphBreak() { inserted += 1; return true; },
  };
  const sandbox = vm.createContext({
    Api: { GetDocument: () => editor },
    Asc: { scope: { tiltypeCompletionPrefix: "docu" } },
  });
  vm.runInContext(readPlugin("scripts/caret-prefix.js"), sandbox);
  const pressEnter = vm.runInContext("insertParagraphAtCompletion", sandbox);
  assert.equal(pressEnter(), true);
  end = 5;
  assert.equal(pressEnter(), false);
  end = 4;
  word = "";
  assert.equal(pressEnter(), false);
  assert.equal(inserted, 1);
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
        if (key.keyCode === 13) assert.fail("Enter reached the native suggestion handler");
      };
    },
    setItems(items) { rows = items; selected = 0; },
    getSelectedItem() { return rows[selected]; },
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
    installFormatToolbar: () => ({configure() {}, dismiss() {}, close() {}}),
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
  vm.runInContext(readPlugin("scripts/editor-command-queue.js"), context);
  vm.runInContext(readPlugin("scripts/prediction-engine.js"), context);
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
  events.get("onKeyDown")({ keyCode: 9, shiftKey: true });
  assert.equal(calls.length, 1);
  events.get("onKeyDown")({ keyCode: 9 });
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
  await Promise.resolve();
  events.get("onKeyDown")({ keyCode: 8 });
  caret = { before: "docu", after: "" };
  events.get("onInputHelperClear")();
  reads.shift()();
  assert.ok(helper.isVisible && rows.some(({ text }) => text === "document"));
  await Promise.resolve();
  events.get("onInputHelperClear")();
  caret = { before: "doc", after: "u" };
  reads.shift()();
  assert.equal(helper.isVisible, false);

  // Поздний ответ редактора не перезаписывает ввод после удаления.
  await Promise.resolve();
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
  events.get("onKeyDown")({ keyCode: 9 });
  assert.deepEqual(calls.at(-1), ["InputText", keyboardChoice + " ", "docu"]);

  events.get("onInputHelperInput")({ text: "docu" });
  const mouseChoice = rows[0];
  plugin.inputHelper_onSelectItem(mouseChoice);
  assert.deepEqual(calls.at(-1), ["InputText", mouseChoice.text, "docu"]);
});
