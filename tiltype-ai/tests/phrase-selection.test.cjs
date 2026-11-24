/**
 * Проверяет взаимодействие списка фраз с клавиатурой и Office API.
 * Моделирует события редактора, не запуская приложение.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");

test("Стрелка выбирает другую фразу, а Tab вставляет её целиком", async () => {
  const callbacks = new Map();
  const inserted = [];
  const rankedContexts = [];
  const continuationInputs = [];
  const pointerInputs = [];
  const alternativeInputs = [];
  const historyOptionInputs = [];
  let items = [];
  let emptyBase = false;
  let fullBase = false;
  let lastProbability = 0.08;
  const caret = {
    paragraphId: "paragraph", position: 47, before: "Please let me ",
    history: "Please let me know when it is ready.\nPlease let me know when you are ready.",
  };
  const source = readFileSync(resolve(__dirname, "../plugin/scripts/plugin.js"), "utf8");
  const phraseSource = readFileSync(resolve(__dirname, "../plugin/scripts/document-phrase.js"), "utf8");
  const purposeSource = readFileSync(resolve(__dirname, "../plugin/scripts/document-purpose.js"), "utf8");
  const promotionSource = readFileSync(resolve(__dirname, "../plugin/scripts/purpose-phrase-promotion.js"), "utf8");
  const indexSource = readFileSync(resolve(__dirname, "../plugin/scripts/phrase-alternative-index.js"), "utf8");
  const vectorSource = readFileSync(resolve(__dirname, "../plugin/scripts/document-vector-rank.js"), "utf8");
  const optionsSource = readFileSync(resolve(__dirname, "../plugin/scripts/prediction-options.js"), "utf8");
  const officialTerms = ["application", "appropriation", "article", "authority", "budget", "commission",
    "compliance", "contract", "decision", "department", "document", "evidence", "government", "institution",
    "inventory", "jurisdiction", "legislation", "minister", "notice", "participant", "procedure", "protocol",
    "registration", "section", "statement", "threshold"];
  const formalTerms = officialTerms.map(word => word.slice(0, Math.max(4, Math.min(7, word.length - 1))) + "\t0,100,0");
  const purposeProfile = JSON.stringify({
    lexicon: [...formalTerms, "pleas\t0,0,5"].sort().join("\n") + "\n",
    documents: [100, 100, 5],
    phrases: { "let me": [[30, 30, 8], [["check details", [0, 0, 8], 6]]] },
    thirdWords: { "let me check details": "carefully" },
  });
  const inputHelper = {
    createWindow() {},
    setItems(nextItems) { items = Array.from(nextItems); },
    getItemsHeight: (count) => count * 20,
    show() {},
    unShow() {},
  };
  const plugin = {
    createInputHelper() {},
    getInputHelper: () => inputHelper,
    attachEditorEvent: (event, callback) => callbacks.set(event, callback),
    callCommand(command, _close, _recalculate, callback) {
      if (command.name === "readNeuralCaret") callback({ ...caret });
      else {
        const text = Asc.scope.tiltypeNeuralPrediction.text;
        inserted.push(text);
        caret.before += text;
        caret.position += text.length;
        callback(true);
      }
    },
  };
  const Asc = { plugin, scope: {} };
  const opened = runInNewContext(`${indexSource}\n${purposeSource}\nconst profile = neuralDocumentPurpose.open(profileText);
profile.inventory = neuralPhraseAlternativeIndex.open(
  "send the\\t1,1,9\\tdraft today,0,0,8\\nsubmit the\\t1,9,1\\treport today,0,8,0\\n");
profile`, {
    profileText: purposeProfile,
  });
  const vectorModel = {
    purposeProfile: opened,
    vocabulary: new Map([["budget", 0], ["draft", 1], ["today", 2]]),
    embedding: { columns: 2, values: new Int8Array([3, 0, 2, 0, 1, 0]), scale: new Float32Array([1, 1, 1]) },
    documentVector: new Float32Array([1, 0, 0, 1]),
  };
  runInNewContext(`${phraseSource}\n${indexSource}\n${promotionSource}\n${purposeSource}\n${vectorSource}\n${optionsSource}\n${source}`, {
    Asc,
    installEditorCommandQueue() {},
    loadNeuralModel: async () => ({ contextSize: 24 }),
    neuralEngine: {
      LANGUAGES: ["en"],
      selectSentence: (text) => ({ context: text.trimEnd().split(" "), language: "en", model: vectorModel }),
      sentenceOptions: ({ context }, documentContext) => ({
        options: emptyBase ? [] : fullBase ? ["know", "ask", "look"] : [context.length === 3 ? "know" : "know when"],
        rankedWords: documentContext ? [{ word: "know", probability: 0.9 }, { word: "look", probability: lastProbability }] : [],
      }),
    },
    neuralDocumentFeatures: { sentences: (history) => history.split("\n") },
    neuralDocumentRanker: {
      rank(options, history, context) {
        rankedContexts.push({ history, context: context.join(" ") });
        return options;
      },
    },
    neuralDocumentContinuation: {
      rank(local, ranked, _history, _context, _language, _model, rankedWords) {
        continuationInputs.push([local[0], ranked[0], rankedWords[0].word]);
        return ranked;
      },
    },
    neuralPhraseConfidence: { apply: options => options },
    neuralTopicPointer: { rank(options, history) {
      pointerInputs.push(history);
      return options;
    } },
    neuralPhraseAlternative: { append(options, local) {
      alternativeInputs.push(local[0]);
      return options;
    } },
    neuralDocumentHistoryOptions: { append(options, history) {
      historyOptionInputs.push(history);
      return options;
    } },
    readNeuralCaret() {},
    applyNeuralPrediction() {},
  });
  plugin.init();
  await Promise.resolve();
  callbacks.get("onInputHelperInput")({ text: "me " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["check details  [Tab]", "know when", "check details carefully"]);
  callbacks.get("onKeyDown")({ keyCode: 40 });
  assert.equal(items[1].text, "know when  [Tab]");
  callbacks.get("onKeyDown")({ keyCode: 38 });
  callbacks.get("onKeyDown")({ keyCode: 38 });
  assert.equal(items[2].text, "check details carefully  [Tab]");
  callbacks.get("onKeyDown")({ keyCode: 40 });
  assert.equal(items[0].text, "check details  [Tab]");
  callbacks.get("onKeyDown")({ keyCode: 38 });
  callbacks.get("onKeyDown")({ keyCode: 9 });
  assert.deepEqual(inserted, ["check details carefully "]);
  assert.equal(items[0].text, "know when  [Tab]");
  callbacks.get("onKeyDown")({ keyCode: 9 });
  assert.deepEqual(inserted, ["check details carefully ", "know when "]);
  assert.equal(Asc.scope.tiltypeReadDocumentHistory, true);
  assert.deepEqual(rankedContexts.map(entry => entry.history.join("\n")), Array(3).fill(caret.history));
  assert.equal(rankedContexts[1].context, "Please let me check details carefully");
  assert.deepEqual(continuationInputs[0], ["know", "know when", "know"]);
  assert.deepEqual(pointerInputs, Array(3).fill(caret.history));
  assert.equal(alternativeInputs[0], "know");
  assert.deepEqual(historyOptionInputs, Array(3).fill(caret.history));

  emptyBase = true;
  caret.before = "Please let me ";
  callbacks.get("onInputHelperInput")({ text: "me " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["check details  [Tab]"]);

  emptyBase = false;
  fullBase = true;
  callbacks.get("onInputHelperInput")({ text: "me " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["know when  [Tab]", "ask", "check details"]);
  lastProbability = 0.2;
  callbacks.get("onInputHelperInput")({ text: "me " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["know when  [Tab]", "ask", "look"]);

  fullBase = false;
  caret.before = "Please send the ";
  callbacks.get("onInputHelperInput")({ text: "the " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["know  [Tab]", "draft today"]);

  fullBase = true;
  lastProbability = 0.08;
  callbacks.get("onInputHelperInput")({ text: "the " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["know  [Tab]", "ask", "draft today"]);
  lastProbability = 0.2;
  callbacks.get("onInputHelperInput")({ text: "the " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["know  [Tab]", "ask", "look"]);

  fullBase = false;
  caret.before = "Please submit the ";
  caret.history = officialTerms.join(" ") + ".";
  callbacks.get("onInputHelperInput")({ text: "the " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["report today  [Tab]", "know"]);

  caret.before = "Please send the ";
  caret.history = "We need the budget ready.";
  callbacks.get("onInputHelperInput")({ text: "the " });
  callbacks.get("onInputHelperClear")();
  assert.deepEqual(items.map(({ text }) => text), ["draft today  [Tab]", "know"]);
  callbacks.get("onKeyDown")({ keyCode: 40 });
  assert.equal(items[1].text, "know  [Tab]");
  callbacks.get("onKeyDown")({ keyCode: 38 });
  callbacks.get("onKeyDown")({ keyCode: 9 });
  assert.equal(inserted.at(-1), "draft today ");
  assert.equal(items[0].text, "know when  [Tab]");
  callbacks.get("onKeyDown")({ keyCode: 9 });
  assert.deepEqual(inserted.slice(-2), ["draft today ", "know when "]);
});
