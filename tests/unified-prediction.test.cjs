/**
 * Проверяет миграцию настроек и общий список подсказок TilType AI.
 * Имитирует команды редактора, включая повторную вставку и переключение движка.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { setImmediate: settle } = require("node:timers/promises");
const { createContext, runInContext } = require("node:vm");

test("Стрелки перемещают выделение, а Tab вставляет выбранную фразу и показывает продолжение", async () => {
  const events = new Map();
  const text = { before: "Please send ", position: 12, paragraphId: "p1", history: "Earlier text." };
  const inserted = [];
  const requests = [];
  let items = [];
  let selected = 0;
  let renders = 0;
  let onSave;
  const helper = {
    isVisible: false,
    createWindow() {
      plugin.event_onKeyDown = ({ keyCode }) => {
        if (keyCode === 40) selected = Math.min(selected + 1, items.length - 1);
        if (keyCode === 38) selected = Math.max(selected - 1, 0);
        assert.notEqual(keyCode, 13);
      };
    },
    setItems(next) { items = Array.from(next); selected = 0; renders += 1; },
    getSelectedItem() { return items[selected]; },
    getItemsHeight: count => count * 20,
    show() { this.isVisible = true; },
    unShow() { this.isVisible = false; },
  };
  const plugin = {
    info: { editorType: "word" },
    createInputHelper() {},
    getInputHelper: () => helper,
    attachEditorEvent: (name, receive) => events.set(name, receive),
    callCommand(command, _close, _recalculate, done) {
      if (command.name === "readPredictionCaret") {
        requests.push(sdk.scope.tiltypeReadDocumentHistory);
        done({ ...text });
        return;
      }
      assert.equal(command.name, "applyPredictionAtCaret");
      const continuation = sdk.scope.tiltypePrediction.text;
      inserted.push(continuation || "\n");
      text.before += continuation;
      text.position += continuation.length;
      done(true);
    },
  };
  const sdk = { plugin, scope: {} };
  const saved = { spelling: false, layout: false, language: "auto", nextWord: true };
  let preferences = JSON.stringify(saved);
  const context = createContext({
    window: { Asc: sdk },
    localStorage: { getItem: () => preferences, setItem: (_key, value) => { preferences = value; } },
    completion: { getPrefix: () => "", suggest: () => [] },
    dictionaryLanguages: [],
    installEditorCommandQueue() {},
    installProofing() {},
    installFormatToolbar() { return {configure() {}, dismiss() {}, close() {}}; },
    addSettingsButton(_plugin, _window, apply) { onSave = apply; },
    spellcheck: { start: async () => {} },
    readPredictionCaret() {},
    applyPredictionAtCaret() {},
    tiltypePredictionEngine: {
      prepare: async () => {},
      suggest: async (caret, settings) => settings.predictionMode === "dictionary" ? ["it"] :
        caret.before.endsWith("report ") ? ["today"] : ["the draft", "the report"],
    },
  });
  for (const script of ["settings.js", "plugin.js"]) {
    runInContext(readFileSync(join(__dirname, "../plugin/scripts", script), "utf8"), context);
  }
  assert.equal(runInContext("correctionSettings.read().predictionMode", context), "phrases");
  preferences = JSON.stringify({ ...saved, predictionMode: "dictionary" });
  plugin.init();
  const show = async () => {
    events.get("onInputHelperInput")({ text: "send " });
    events.get("onInputHelperClear")();
    await settle();
  };
  const press = keyCode => events.get("onKeyDown")({ keyCode });
  await show();
  assert.equal(items[0].text, "it");
  assert.equal(requests.at(-1), false);
  const update = history => {
    preferences = JSON.stringify({ ...saved, predictionMode: "gru", predictionHistory: history });
    onSave(runInContext("correctionSettings.read()", context));
  };
  update(true);
  assert.equal(helper.isVisible, false);
  await show();
  assert.equal(requests.at(-1), true);
  press(13);
  assert.deepEqual(inserted, ["\n"]);
  await show();
  const renderCount = renders;
  press(40);
  assert.equal(helper.getSelectedItem().text, "the report");
  press(38);
  assert.equal(helper.getSelectedItem().text, "the draft");
  press(40);
  assert.equal(renders, renderCount);
  assert.match(readFileSync(join(__dirname, "../plugin/resources/input-helper.css"), "utf8"),
    /\.li_selected::after\s*\{\s*content:\s*"\s+\[Tab\]"/);
  press(9);
  await settle();
  assert.equal(helper.getSelectedItem().text, "today");
  press(9);
  await settle();
  assert.deepEqual(inserted, ["\n", "the report ", "today "]);
  update(false);
  await show();
  assert.equal(requests.at(-1), false);
});

test("Фразовая подсказка учитывает первое слово и сохраняет короткий вариант", () => {
  const calls = [];
  let probability = 0.2;
  const context = createContext({
    neuralEngine: { rankWords: (_model, prefix) => {
      calls.push(Array.from(prefix));
      return [{ word: "мәтін", probability: 0.7 }, { word: "draft", probability }];
    } },
  });
  runInContext(readFileSync(join(__dirname, "../plugin/scripts/phrase-extension.js"), "utf8"), context);
  const { add } = runInContext("tiltypePhraseExtension", context);
  const selected = { context: ["please", "send"], model: { contextSize: 2 } };
  const english = option => /^[a-z]+$/u.test(option);
  const options = ["the", "me", "it"];
  assert.deepEqual([...add(options, selected, english)], ["the", "the draft", "me"]);
  assert.deepEqual(calls, [["send", "the"]]);
  probability = 0.46;
  assert.deepEqual([...add(options, selected, english)], ["the draft", "the", "me"]);
  probability = 0.06;
  assert.equal(add(options, selected, english), options);
  const phrases = ["the earlier draft", "me"];
  assert.equal(add(phrases, selected, english), phrases);
});

test("Тема за длинным окном меняет продолжение того же начала", () => {
  const older = "контракт ".repeat(52);
  const previous = " ".repeat(4096);
  const prefix = "Стороны решили ";
  const source = older + previous + prefix;
  const officeReads = [];
  const scope = { tiltypeReadDocumentHistory: true };
  const context = createContext({
    Asc: { scope },
    Api: { GetDocument: () => ({
      GetRangeBySelect: () => ({ GetStartPos: () => source.length, GetEndPos: () => source.length }),
      GetCurrentParagraph: () => ({ GetInternalId: () => "paragraph" }),
      GetCurrentSentence: direction => direction === "before" ? prefix : "",
      GetRange(start, end) {
        officeReads.push(start);
        return { GetText: () => source.slice(start, end) };
      },
    }) },
    neuralEngine: { rankWords: () => [{ word: "решение", probability: 0.21 }, { word: "контракт", probability: 0.2 }] },
    neuralDocumentVectorRank: { topicAffinity: () => () => 0 },
  });
  for (const script of ["next-word.js", "phrase-extension.js", "prediction-topic.js"]) {
    runInContext(readFileSync(join(__dirname, "../plugin/scripts", script), "utf8"), context);
  }
  const caret = runInContext("readPredictionCaret()", context);
  assert.equal(caret.documentTopic[0][0], "контракт");
  assert.deepEqual(officeReads, [older.length, 0]);
  scope.tiltypeDocumentTopicParagraph = "paragraph";
  assert.equal(runInContext("readPredictionCaret()", context).documentTopic, undefined);
  const { add } = runInContext("tiltypePhraseExtension", context);
  const { score } = runInContext("tiltypePredictionTopic", context);
  const selected = { model: { vocabulary: new Map(), contextSize: 24 }, context: ["стороны", "решили"] };
  const options = ["подписать"];
  assert.deepEqual([...add(options, selected, () => true)], ["подписать", "подписать решение"]);
  assert.deepEqual([...add(options, selected, () => true, score(caret, selected.model, () => true))],
    ["подписать", "подписать контракт"]);
});
test("Тематические фразы различают одинаковое начало по истории и сохраняют лимит списка", () => {
  const ctx = createContext({});
  runInContext(readFileSync(join(__dirname, "../plugin/scripts/prediction-topic.js"), "utf8"),ctx);
  const {extend} = runInContext("tiltypePredictionTopic",ctx);
  const tables = {roots:[["учеб"],["склад"]],entries:{"составили новый":[[0,"учебный план",4],[1,"график поставок",7]]}};
  const options = ["график","отчёт","проект"];
  const suggest = (history,prefix="Мы составили новый ") => [...extend(options,prefix,history,tables,()=>true)];
  assert.deepEqual(suggest("Работа на складе."),["график поставок","график","отчёт"]);
  assert.deepEqual(suggest("Вышел учебник."),["график","учебный план","отчёт"]);
  assert.deepEqual(suggest(""),options);
  assert.deepEqual(suggest("","the constructor "),options);
});
