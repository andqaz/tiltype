/**
 * Интеграция автодополнения с ONLYOFFICE.
 * Следит за буфером ввода, управляет штатным списком у курсора и вставляет выбранное слово.
 */
"use strict";

/** @typedef {{ id: string, text: string }} SuggestionItem */
/** @typedef {{ text: string, add?: boolean }} EditorInput */
/** @typedef {{ keyCode: number, altKey?: boolean, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean }} InputHelperKey */
/**
 * @typedef {Object} InputHelper
 * @property {boolean} isVisible Состояние штатного списка.
 * @property {() => void} createWindow
 * @property {(items: SuggestionItem[]) => void} setItems
 * @property {() => SuggestionItem | null} getSelectedItem
 * @property {(count: number) => number} getItemsHeight
 * @property {(width: number, height: number, takeKeyboard: boolean) => void} show
 * @property {() => void} unShow
 */
/**
 * @typedef {Object} EditorPlugin
 * @property {Record<string,string>} [theme] Цвета текущей темы редактора.
 * @property {string} guid
 * @property {{ lang?: string, editorType?: string }} info
 * @property {() => void} createInputHelper
 * @property {() => InputHelper} getInputHelper
 * @property {{ (event: "onClick", handler: () => void): void,
 * (event: "onInputHelperInput" | "onInputHelperClear", handler: (data?: EditorInput) => void): void,
 * (event: "onKeyDown", handler: (key: InputHelperKey) => void): void,
 * (event: "onContextMenuShow", handler: (options?: { type: string }) => void): void,
 * (event: "onContextMenuClick", handler: (id: string) => void): void,
 * (event: "onToolbarMenuClick", handler: (id: string) => void): void }} attachEditorEvent
 * @property {(method: string, args: unknown[], callback?: (value: unknown) => void) => void} executeMethod
 * @property {(command: string, data: string) => void} executeCommand
 * @property {(command: () => unknown, close: boolean, recalculate: boolean, callback: (result: unknown) => void) => void} callCommand
 * @property {() => void} [init]
 * @property {(id: number, windowId?: string) => void} [button]
 * @property {(item: SuggestionItem | null) => void} [inputHelper_onSelectItem]
 * @property {(key: InputHelperKey) => void} [event_onKeyDown]
 */

(() => {
  const sdk = Reflect.get(window, "Asc");
  /** @type {EditorPlugin} */
  const plugin = sdk.plugin;
  const POPUP_WIDTH = 240;
  const VISIBLE_ROWS = 7;
  const TAB_KEY = 9;
  const ENTER_KEY = 13;
  const ESCAPE_KEY = 27;
  const BACKSPACE_KEY = 8;
  const DELETE_KEY = 46;
  const LAYOUT_CONTEXT_MS = 45_000;
  /** @type {Partial<Record<DictionaryLanguage, DictionaryEntry[]>>} */
  const dictionaries = {};
  /** @type {InputHelper} */
  let helper;
  let prefix = "";
  let caretPrefix = "";
  /** @type {{ previous: string, deletion: boolean } | null} */
  let recovery = null;
  let deletionRequested = false;
  /** @type {SuggestionItem[]} */
  let items = [];
  let predictAfterClear = false;
  /** @type {{ caret: PredictionCaret, options: string[] } | null} */
  let prediction = null;
  let inputRevision = 0;
  let typingRevision = 0;
  /** @type {{ paragraphId: string, position: number, until: number, terms: [string, number][] } | undefined} */
  let documentTopic;
  let skipCorrection = "";
  /** @type {ReversibleWordEdit | null} */
  let lastCorrection = null;
  let supportsCorrection = false;
  let supportsCaretRead = false;
  let dismissed = false;
  let addSpaceToSelection = false;
  /** @type {{ language: LayoutLanguage, time: number } | null} */
  let layoutContext = null;
  /** @type {(() => void) | undefined} */
  let closeSettings;
  /** @type {(() => void) | undefined} */
  let queueProofing;

  /** @type {ReturnType<typeof installFormatToolbar> | undefined} */
  let formatToolbar;

  function hideSuggestions() {
    items = [];
    prediction = null;
    if (!formatToolbar?.visible) helper.unShow();
  }

  function clearInput() {
    inputRevision += 1;
    prefix = "";
    caretPrefix = "";
    recovery = null;
    deletionRequested = false;
    skipCorrection = "";
    dismissed = false;
    predictAfterClear = false;
    hideSuggestions();
  }

  function handleEditorClear() {
    const previous = prefix || recovery?.previous || "";
    const deletion = deletionRequested || recovery?.deletion === true;
    const shouldPredict = predictAfterClear;
    clearInput();
    if (shouldPredict) {
      requestPrediction();
      return;
    }
    if (!supportsCaretRead || (!deletion && !previous)) return;

    // При открытом списке SDK сбрасывает буфер после Backspace без события клавиши.
    // В таком случае принимаем только укороченный вариант предыдущего слова.
    recovery = { previous, deletion };
    const revision = inputRevision;
    plugin.callCommand(readCaretPrefix, false, false, (remaining) => {
      if (revision !== inputRevision) return;
      recovery = null;
      if (typeof remaining !== "string" || !remaining || completion.getPrefix(remaining) !== remaining) return;
      if (!deletion && (remaining.length >= previous.length || !previous.startsWith(remaining))) return;

      // После сброса SDK сообщает только символы, набранные после удаления.
      caretPrefix = remaining;
      prefix = remaining;
      renderSuggestions();
    });
  }

  /** @param {{ paragraphId: string, before: string }} [afterInsertion] */
  function requestPrediction(afterInsertion) {
    const revision = inputRevision;
    const options = correctionSettings.read();
    if (!options.nextWord || formatToolbar?.visible) return;
    if (documentTopic && documentTopic.until <= Date.now()) documentTopic = undefined;
    sdk.scope = { ...sdk.scope, tiltypeReadDocumentHistory: options.predictionHistory &&
      (options.predictionMode === "phrases" || options.predictionMode === "gru"),
      tiltypeDocumentTopicParagraph: documentTopic?.paragraphId };
    plugin.callCommand(readPredictionCaret, false, false, async (result) => {
      if (revision !== inputRevision || !result || typeof result !== "object" ||
          !("before" in result) || typeof result.before !== "string" ||
          !("paragraphId" in result) || typeof result.paragraphId !== "string" ||
          !("position" in result) || typeof result.position !== "number") return;
      if (afterInsertion && (result.paragraphId !== afterInsertion.paragraphId ||
          !result.before.replaceAll("’", "'").endsWith(afterInsertion.before.replaceAll("’", "'")))) return;
      if (documentTopic && (documentTopic.paragraphId !== result.paragraphId || result.position < documentTopic.position)) {
        documentTopic = undefined;
      }
      if ("documentTopic" in result && Array.isArray(result.documentTopic)) {
        const terms = result.documentTopic.filter(item => Array.isArray(item) && typeof item[0] === "string" &&
          typeof item[1] === "number" && Number.isFinite(item[1]));
        documentTopic = { paragraphId: result.paragraphId, position: result.position, until: Date.now() + 15_000, terms };
      }
      const caret = { before: result.before, paragraphId: result.paragraphId, position: result.position,
        history: "history" in result && typeof result.history === "string" ? result.history : undefined,
        documentTopic: options.predictionHistory ? documentTopic?.terms : undefined };
      try {
        const choices = await tiltypePredictionEngine.suggest(caret, options);
        if (revision !== inputRevision || !choices.length) return;
        prediction = { caret, options: choices };
        items = choices.map((text, index) => ({ id: `prediction-${revision}-${index}`, text }));
        helper.setItems(items);
        helper.show(choices.length > 1 ? 360 : POPUP_WIDTH, helper.getItemsHeight(choices.length), false);
      } catch (error) {
        console.warn("TilType AI: prediction unavailable", error);
      }
    });
  }

  /** @param {number} index Выбранный вариант для вставки. */
  function finishPrediction(index) {
    if (!prediction) return;
    const { caret, options } = prediction;
    const text = index >= 0 ? options[index] + " " : "";
    clearInput();
    const revision = typingRevision;
    sdk.scope = { ...sdk.scope, tiltypePrediction: { caret, text } };
    plugin.callCommand(applyPredictionAtCaret, false, true, (applied) => {
      if (text && applied === true && revision === typingRevision) {
        requestPrediction({ paragraphId: caret.paragraphId, before: (caret.before + text).slice(-600) });
      }
    });
  }

  function renderSuggestions() {
    if (dismissed || formatToolbar?.visible) return;
    const words = completion.suggest(prefix, dictionaries);
    if (words.length === 0) {
      hideSuggestions();
      return;
    }

    items = words.map((text, index) => ({ id: `${inputRevision}-${index}`, text }));
    helper.setItems(items);
    // Клавиатура остаётся у редактора, чтобы список не мешал набору текста.
    const height = helper.getItemsHeight(Math.min(items.length, VISIBLE_ROWS));
    helper.show(POPUP_WIDTH, height, false);
  }

  /** @param {string} word */
  function correctWord(word) {
    const options = correctionSettings.read();
    if (!options.layout) layoutContext = null;
    if (!options.spelling && !options.layout) return;

    startSpellcheck();
    const previous = layoutContext && Date.now() - layoutContext.time <= LAYOUT_CONTEXT_MS
      ? layoutContext.language
      : null;
    const correction = corrections.suggest(word, options, dictionaries, spellcheck.dictionaries, previous);
    if (!correction) return;

    const { text, layout } = correction;
    const revision = typingRevision;
    replaceCompletedWord(plugin, word, text, (success, undo) => {
      if (success && layout) layoutContext = { language: layout, time: Date.now() };
      if (revision === typingRevision) lastCorrection = undo;
    });
  }

  function handleEscape() {
    if (prediction) hideSuggestions();
    if (lastCorrection) {
      undoCompletedWord(plugin, lastCorrection);
      lastCorrection = null;
      layoutContext = null;
      return;
    }
    skipCorrection = prefix;
    if (items.length > 0) {
      dismissed = true;
      hideSuggestions();
    }
  }

  function startSpellcheck() {
    spellcheck.start().catch((error) => console.error("Autocomplete: Hunspell", error));
  }

  /** @param {CorrectionSettings} options */
  function applyCorrectionSettings(options) {
    documentTopic = undefined;
    formatToolbar?.configure(options.formatToolbar);
    clearInput();
    if (options.nextWord) void tiltypePredictionEngine.prepare(options.predictionMode);
    if (!options.layout) layoutContext = null;
    if (options.spelling || options.layout || options.proofing) startSpellcheck();
  }

  /** @param {EditorInput} [data] */
  function handleInput(data) {
    formatToolbar?.dismiss();
    typingRevision += 1;
    lastCorrection = null;
    prediction = null;
    if (!data || typeof data.text !== "string") {
      clearInput();
      return;
    }
    const text = (data.add ? prefix : caretPrefix) + data.text;
    recovery = null;
    deletionRequested = false;
    const completed = /(?:^|[\s(«“])([\p{L}]+) $/u.exec(text)?.[1];
    if (supportsCorrection && completed && completed === prefix && completed !== skipCorrection) correctWord(completed);
    predictAfterClear = supportsCorrection && text.endsWith(" ") && correctionSettings.read().nextWord;
    if (data.text) queueProofing?.();

    inputRevision += 1;
    const nextPrefix = completion.getPrefix(text);
    if (nextPrefix !== prefix) {
      dismissed = false;
      skipCorrection = "";
    }
    prefix = nextPrefix;
    renderSuggestions();
  }

  plugin.init = () => {
    if (helper) return;
    installEditorCommandQueue(plugin, sdk);
    plugin.createInputHelper();
    helper = plugin.getInputHelper();
    helper.createWindow();
    const nativeKeyboard = plugin.event_onKeyDown;
    // SDK пересылает клавиши списка только подписавшимся плагинам.
    plugin.attachEditorEvent("onKeyDown", (key) => {
      if (formatToolbar?.visible) {
        formatToolbar.dismiss();
        return;
      }
      if (key.keyCode === BACKSPACE_KEY || key.keyCode === DELETE_KEY) {
        if (prediction) clearInput();
        typingRevision += 1;
        lastCorrection = null;
        deletionRequested = true;
        return;
      }
      if (key.keyCode === ESCAPE_KEY) {
        handleEscape();
        return;
      }
      if (items.length === 0 || dismissed) return;
      const unmodified = !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey;
      if (key.keyCode === TAB_KEY) {
        if (!unmodified) return;
        addSpaceToSelection = correctionSettings.read().spaceAfterTab;
        try {
          plugin.inputHelper_onSelectItem?.(helper.getSelectedItem());
        } finally {
          addSpaceToSelection = false;
        }
        return;
      }
      if (key.keyCode === ENTER_KEY) {
        if (prediction && unmodified) finishPrediction(-1);
        else if (prefix && unmodified && supportsCorrection && helper.isVisible) {
          const typedPrefix = prefix;
          clearInput();
          sdk.scope = { ...sdk.scope, tiltypeCompletionPrefix: typedPrefix };
          plugin.callCommand(insertParagraphAtCompletion, false, true, () => {});
        } else clearInput();
        return;
      }
      nativeKeyboard?.call(plugin, key);
    });
    supportsCorrection = plugin.info.editorType === "word";
    supportsCaretRead = supportsCorrection || plugin.info.editorType === "slide";
    if (supportsCorrection) {
      formatToolbar = installFormatToolbar(plugin, sdk, clearInput);
      queueProofing = installProofing(plugin);
      closeSettings = addSettingsButton(plugin, sdk.PluginWindow, applyCorrectionSettings);
      applyCorrectionSettings(correctionSettings.read());
    }
    plugin.attachEditorEvent("onInputHelperClear", handleEditorClear);
    plugin.attachEditorEvent("onInputHelperInput", handleInput);

    for (const language of dictionaryLanguages) {
      loadDictionary(language).then((dictionary) => {
        dictionaries[language] = dictionary;
        if (prefix) {
          inputRevision += 1;
          renderSuggestions();
        }
      }).catch((error) => console.error("Autocomplete:", error));
    }
  };

  plugin.inputHelper_onSelectItem = (item) => {
    if (!item || !helper.isVisible) return;
    const index = items.findIndex(option => option.id === item.id);
    if (index === -1) return;
    if (prediction) {
      finishPrediction(index);
      return;
    }
    if (!prefix) return;

    // SDK заменяет только переданный фрагмент в буфере ввода, сохраняя текст перед ним.
    const text = addSpaceToSelection ? items[index].text + " " : items[index].text;
    plugin.executeMethod("InputText", [text, prefix]);
    clearInput();
  };

  plugin.button = (_id, windowId) => {
    if (windowId) {
      closeSettings?.();
      return;
    }
    formatToolbar?.close();
    if (helper) clearInput();
    plugin.executeCommand("close", "");
  };
})();
