/**
 * Показывает нейронную подсказку после пробела и принимает её по Tab.
 * Работает как независимый фоновый плагин текстового редактора ONLYOFFICE.
 */
"use strict";

(() => {
  const sdk = Asc;
  const plugin = sdk.plugin;
  const TAB = 9;
  const ENTER = 13;
  const ESCAPE = 27;
  const ARROW_UP = 38;
  const ARROW_DOWN = 40;
  /** @type {NeuralModels} */
  const models = {};
  /** @type {NeuralInputHelper | undefined} */
  let helper;
  /** @type {{ options: string[], selected: number, caret: NeuralCaret, revision: number } | undefined} */
  let suggestion;
  let revision = 0;
  let predictAfterClear = false;

  function dismiss() {
    revision += 1;
    predictAfterClear = false;
    if (!suggestion) return;
    suggestion = undefined;
    helper?.unShow();
  }

  /** @param {unknown} result @returns {result is NeuralCaret} */
  function isCaret(result) {
    return Boolean(result && typeof result === "object" &&
      "before" in result && typeof result.before === "string" &&
      "paragraphId" in result && typeof result.paragraphId === "string" &&
      "position" in result && typeof result.position === "number");
  }

  /** @param {{ paragraphId: string, before: string }} [afterInsertion] */
  function predictAtCaret(afterInsertion) {
    const request = revision;
    const captureHistory = typeof neuralDocumentRanker !== "undefined" &&
      Object.values(models).some(model => model.contextSize > 6);
    sdk.scope = { ...sdk.scope, tiltypeReadDocumentHistory: captureHistory };
    plugin.callCommand(readNeuralCaret, false, false, (result) => {
      if (request !== revision || !helper || !isCaret(result)) return;
      if (afterInsertion && (result.paragraphId !== afterInsertion.paragraphId ||
          !result.before.replaceAll("’", "'").endsWith(afterInsertion.before.replaceAll("’", "'")))) return;
      const sentenceMode = Object.values(models).some(model => model.contextSize > 6);
      const word = sentenceMode ? undefined : neuralEngine.suggest(result.before, models);
      const hasHistory = sentenceMode && typeof result.history === "string" && result.history &&
        typeof neuralDocumentRanker !== "undefined";
      const selected = hasHistory ? neuralEngine.selectSentence(result.before, models) : undefined;
      const options = selected ? neuralPredictionOptions.complete(result.before, result.history ?? "", selected) :
        sentenceMode ? neuralEngine.suggestOptions(result.before, models) : word ? [word] : [];
      if (!options.length) return;
      suggestion = { options, selected: 0, caret: result, revision: request };
      render();
      helper.show(options.length > 1 ? 360 : 240, helper.getItemsHeight(options.length), false);
    });
  }

  function render() {
    if (!suggestion || !helper) return;
    const { options, selected, revision: current } = suggestion;
    helper.setItems(options.map((text, index) => ({
      id: `${current}-${index}`,
      text: index === selected ? `${text}  [Tab]` : text,
    })));
  }

  /** @param {boolean} accept Вставить подсказку, иначе выполнить Enter. */
  function finish(accept) {
    if (!suggestion) return;
    const { caret, options, selected } = suggestion;
    const text = accept ? options[selected] + " " : "";
    dismiss();
    sdk.scope = { ...sdk.scope, tiltypeNeuralPrediction: { caret, text } };
    plugin.callCommand(applyNeuralPrediction, false, true, (applied) => {
      if (accept && applied === true) {
        // Не ждём следующего символа. Новый контекст должен содержать вставленную фразу.
        const expected = (caret.before + text).slice(-600);
        predictAtCaret({ paragraphId: caret.paragraphId, before: expected });
      }
    });
  }

  plugin.init = () => {
    if (helper) return;
    installEditorCommandQueue(plugin, sdk);
    plugin.createInputHelper();
    helper = plugin.getInputHelper();
    helper.createWindow();

    plugin.attachEditorEvent("onInputHelperInput", (entry) => {
      dismiss();
      predictAfterClear = entry?.text?.endsWith(" ") === true;
    });
    plugin.attachEditorEvent("onInputHelperClear", () => {
      const request = predictAfterClear;
      if (!request && !suggestion) return;
      dismiss();
      if (request) predictAtCaret();
    });
    plugin.attachEditorEvent("onKeyDown", (key) => {
      if (key.keyCode === ESCAPE) {
        dismiss();
        return;
      }
      if (!suggestion) return;
      const unmodified = !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey;
      if (unmodified && suggestion.options.length > 1 && (key.keyCode === ARROW_UP || key.keyCode === ARROW_DOWN)) {
        const step = key.keyCode === ARROW_DOWN ? 1 : -1;
        const count = suggestion.options.length;
        suggestion.selected = (suggestion.selected + step + count) % count;
        render();
        return;
      }
      if (unmodified && (key.keyCode === TAB || key.keyCode === ENTER)) {
        finish(key.keyCode === TAB);
      } else if (![16, 17, 18, 91].includes(key.keyCode)) {
        dismiss();
      }
    });

    for (const language of neuralEngine.LANGUAGES) {
      loadNeuralModel(language).then((model) => {
        models[language] = model;
      }).catch((error) => console.error("TilType AI: model load failed", language, error));
    }
  };
  plugin.inputHelper_onSelectItem = (item) => {
    if (!item || !suggestion) return;
    const selected = suggestion.options.findIndex((_, index) => item.id === `${suggestion?.revision}-${index}`);
    if (selected < 0) return;
    suggestion.selected = selected;
    finish(true);
  };
  plugin.button = () => {
    dismiss();
    plugin.executeCommand("close", "");
  };
})();
