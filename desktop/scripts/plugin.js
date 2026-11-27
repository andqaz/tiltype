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
  const modelOnly = typeof document !== "undefined" && document.documentElement?.dataset?.writer === "shared";
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
  const personal = typeof tiltypePersonalModel === "undefined" ? undefined : tiltypePersonalModel;
  /** @type {{word:string, consumed:boolean}|undefined} */
  let observation;
  let predictAfterClear = false;
  /** @type {{ caret: PredictionCaret, options: string[], typed: string, separator?: string, trailingSpace?: boolean } | null} */
  let prediction = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let phraseTimer;
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
  let acceptingTab = false;
  /** @type {{queued: number} | null} Повторные Tab до подтверждения очередного слова редактором. */
  let pendingStep = null;
  /** @type {{ language: LayoutLanguage, time: number } | null} */
  let layoutContext = null;
  /** @type {(() => void) | undefined} */
  let closeSettings;
  /** @type {(() => void) | undefined} */
  let queueProofing;

  /** @type {ReturnType<typeof installFormatToolbar> | undefined} */
  let formatToolbar;

  /** @type {ReturnType<typeof createInlinePreview>} */
  let inline;
  const wordContext = typeof tiltypeWordContext === "undefined" ? undefined : tiltypeWordContext;
  /** @type {string|undefined} Контекст текущего словарного списка, подтверждённый редактором. */
  let wordBefore;
  let previewReady = false;
  function resetPreview() {
    previewReady = false;
    inline?.hide();
  }

  /** Проверяет актуальность списка после асинхронного чтения курсора. */
  function previewItems() {
    const readWordContext = supportsCorrection && wordContext && /^[а-яёәғқңөұүһі]{3,}$/iu.test(prefix) && !prediction;
    if (!readWordContext && (!items.length || !inline)) return;
    if (prediction?.caret.paragraphTail) {
      previewReady = true;
      updatePreview();
      return;
    }
    const snapshot = items;
    const revision = inputRevision;
    plugin.callCommand(canPreviewAtCaret, false, false, valid => {
      if (items !== snapshot || revision !== inputRevision) return;
      if (valid && typeof valid === "object" && "before" in valid && typeof valid.before === "string" &&
          !prediction && prefix && valid.before.endsWith(prefix) && (!items.length || (helper.getSelectedItem()?.id ?? items[0].id) === items[0].id)) {
        wordBefore = valid.before.slice(0,-prefix.length);
        const language = correctionSettings.read().language;
        const choice = wordContext?.choose(wordBefore,prefix,items.map(i=>i.text),dictionaries.ru,language) ??
          personal?.preferredWord(wordBefore,prefix,language);
        if (choice && items[0]?.text !== choice) {
          const words = [choice,...items.map(i=>i.text).filter(s=>s!==choice)].slice(0,10);
          items = words.map((text,index)=>({id:revision+"-form-"+index,text}));
          helper.setItems(items);
          if (!snapshot.length) helper.show(POPUP_WIDTH,helper.getItemsHeight(items.length),false);
        }
      }
      if (!items.length || !(valid === true || valid && typeof valid === "object" && "visible" in valid && valid.visible)) return;
      previewReady = true;
      updatePreview();
    });
  }

  function updatePreview() {
    if (!previewReady || !inline) return;
    const selected = helper.getSelectedItem() ?? items[0];
    if (selected) inline.show((prediction?.separator ?? "") + selected.text.slice((prediction?.typed ?? prefix).length),
      items.length === 1, sdk.plugin.theme?.type === "dark", prediction?.caret.before ?? prefix);
  }

  function hideSuggestions() {
    resetPreview();
    items = [];
    prediction = null;
    if (!formatToolbar?.visible) helper.unShow();
  }

  function clearInput() {
    pendingStep = null;
    if (phraseTimer !== undefined) clearTimeout(phraseTimer);
    inputRevision += 1;
    prefix = "";
    caretPrefix = "";
    recovery = null;
    deletionRequested = false;
    skipCorrection = "";
    dismissed = false;
    observation = undefined;
    predictAfterClear = false;
    hideSuggestions();
  }

  function handleEditorClear() {
    if (pendingStep) return;
    const previous = prefix || recovery?.previous || "";
    const deletion = deletionRequested || recovery?.deletion === true;
    const shouldPredict = predictAfterClear;
    const completedWord = observation;
    clearInput();
    if (shouldPredict) {
      requestPrediction(undefined, "", completedWord);
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

  /** @param {{ paragraphId?: string, before: string, remainder?: string, trailingSpace?: boolean }} [afterInsertion] @param {string} [typed] @param {{word:string,consumed:boolean}} [manual] */
  function requestPrediction(afterInsertion, typed = "", manual) {
    const revision = inputRevision;
    const options = correctionSettings.read();
    if (!options.nextWord || formatToolbar?.visible) return;
    if (documentTopic && documentTopic.until <= Date.now()) documentTopic = undefined;
    sdk.scope = { ...sdk.scope, tiltypeFullHistory: typeof document !== "undefined" && document.documentElement?.dataset?.compact === "true", tiltypePredictionPrefix: typed, tiltypeAcceptedSuffix: afterInsertion?.before, tiltypeReadDocumentHistory: options.predictionHistory &&
      (options.predictionMode === "phrases" || options.predictionMode === "gru"),
      tiltypeDocumentTopicParagraph: documentTopic?.paragraphId };
    const transaction = afterInsertion?.remainder ? pendingStep : null;
    plugin.callCommand(readPredictionCaret, false, false, async (result) => {
      if (revision !== inputRevision || !result || typeof result !== "object" ||
          !("before" in result) || typeof result.before !== "string" ||
          !("paragraphId" in result) || typeof result.paragraphId !== "string" ||
          !("position" in result) || typeof result.position !== "number") {
        if (transaction && pendingStep === transaction) clearInput();
        return;
      }
      if (afterInsertion && ((afterInsertion.paragraphId && result.paragraphId !== afterInsertion.paragraphId) ||
          !result.before.replaceAll("’", "'").endsWith(afterInsertion.before.replaceAll("’", "'")))) {
        if (transaction && pendingStep === transaction) clearInput();
        return;
      }
      if (documentTopic && (documentTopic.paragraphId !== result.paragraphId || result.position < documentTopic.position)) {
        documentTopic = undefined;
      }
      if ("documentTopic" in result && Array.isArray(result.documentTopic)) {
        const terms = result.documentTopic.filter(item => Array.isArray(item) && typeof item[0] === "string" &&
          typeof item[1] === "number" && Number.isFinite(item[1]));
        documentTopic = { paragraphId: result.paragraphId, position: result.position, until: Date.now() + 15_000, terms };
      }
      const caret = { priorText: "priorText" in result && typeof result.priorText === "string" ? result.priorText : "", before: result.before, paragraphId: result.paragraphId, position: result.position,
        paragraphTail: "paragraphTail" in result && result.paragraphTail === true,
        history: "history" in result && typeof result.history === "string" ? result.history : undefined,
        documentTopic: options.predictionHistory ? documentTopic?.terms : undefined };
      try {
        if (typed && !caret.before.endsWith(typed)) return;
        const separator = afterInsertion && !/\s$/u.test(caret.before) ? " " : "";
        const before = typed ? caret.before.slice(0, -typed.length) : caret.before + separator;
        if (manual && !manual.consumed && before.endsWith(manual.word + " ")) {
          manual.consumed = true;
          personal?.observe(before.slice(0,-manual.word.length-1), manual.word, options.language, caret.paragraphId, caret.position);
        }
        const remainder = afterInsertion?.remainder;
        let choices = remainder ? [remainder] : modelOnly ? await tiltypePredictionEngine.suggest({ ...caret, before, typed }, options) :
          await tiltypePredictionEngine.suggest({ ...caret, before }, options);
        if (!modelOnly && !choices.length && afterInsertion && (options.predictionMode === "phrases" || options.predictionMode === "gru")) {
          const models = await tiltypePredictionEngine.prepare(options.predictionMode);
          const newSentence = /[.!?…][»”")]*\s*$/u.test(before);
          const context = newSentence ? before.replace(/[.!?…][»”")]*\s*$/u, " ") : before;
          const selected = neuralEngine.selectSentence(context, models, options.language);
          if (selected) choices = neuralEngine.rankWords(selected.model, newSentence ? [] : selected.context, 3, true)
            .map(({word}) => newSentence ? word.charAt(0).toUpperCase() + word.slice(1) : word);
        }
        if (revision !== inputRevision || dismissed || formatToolbar?.visible) return;
        if (personal && !remainder) {
          const ranked = personal.rank(before,choices,options.language);
          const phrases = options.predictionMode === "phrases" || options.predictionMode === "gru";
          choices = phrases ? ranked : ranked.filter(s => !s.includes(" "));
        }
        if (typed && !modelOnly) {
          choices = choices.filter(s => s.includes(" ") && s.toLowerCase().startsWith(typed.toLowerCase()));
          if (!choices.length) return;
          const words = completion.suggest(typed, dictionaries);
          const form = wordContext?.choose(before,typed,words,dictionaries.ru,options.language) ??
            personal?.preferredWord(before,typed,options.language);
          if (form) {
            choices = choices.filter(s=>s.split(/\s+/u)[0].toLowerCase()===form.toLowerCase());
            if (!choices.length) return;
          }
          choices = [...new Set([...choices, ...words])].slice(0, VISIBLE_ROWS);
        }
        if (!choices.length) return;
        resetPreview();
        prediction = { caret, options: choices, typed, separator, trailingSpace: afterInsertion?.trailingSpace };
        items = choices.map((text, index) => ({ id: `prediction-${revision}-${index}`, text }));
        helper.setItems(items);
        const width = choices.some(s => s.length > 36) ? 540 : choices.length > 1 ? 360 : POPUP_WIDTH;
        helper.show(width, helper.getItemsHeight(choices.length), false);
        previewItems();
        if (transaction && pendingStep === transaction) {
          if (transaction.queued > 0) {
            transaction.queued--;
            acceptingTab = true;
            try { finishPrediction(0); } finally { acceptingTab = false; }
          } else pendingStep = null;
        }
      } catch (error) {
        console.warn("TilType AI: prediction unavailable", error);
      }
    });
  }

  /** @param {number} index Выбранный вариант для вставки. */
  function finishPrediction(index) {
    if (!prediction) return;
    const { caret, options, typed, separator = "" } = prediction;
    const choice = options[index] ?? "";
    const trailingSpace = prediction.trailingSpace ?? (!typed || addSpaceToSelection);
    // Захватываем знак при слове и исходный разделитель, в том числе неразрывный пробел.
    const step = acceptingTab && correctionSettings.read().tabByWord
      ? /^([\s\S]*?[\p{L}\p{N}]\S*)(\s+)(?=\S)/u.exec(choice) : null;
    const accepted = step ? step[1] : choice;
    const remainder = step ? choice.slice(step[0].length) : undefined;
    const space = step ? step[2] : trailingSpace ? " " : "";
    const text = index >= 0 ? separator + accepted.slice(typed.length) + space : "";
    const queued = pendingStep?.queued ?? 0;
    const transaction = remainder ? { queued } : null;
    if (transaction) {
      // Пока список виден, редактор направляет следующий Tab плагину.
      pendingStep = transaction;
      prefix = "";
      caretPrefix = "";
      inputRevision += 1;
      prediction = null;
      resetPreview();
    } else clearInput();
    const revision = typingRevision;
    sdk.scope = { ...sdk.scope, tiltypePrediction: { caret: { paragraphId: caret.paragraphId, position: caret.position, before: caret.before, paragraphTail: caret.paragraphTail }, text } };
    plugin.callCommand(applyPredictionAtCaret, false, true, (applied) => {
      if (text && applied === true) {
        const before = typed ? caret.before.slice(0,-typed.length) : caret.before;
        personal?.learn(before, accepted, correctionSettings.read().language, true);
      }
      if (transaction) {
        if (pendingStep !== transaction) return;
        if (applied !== true || revision !== typingRevision || !remainder) { clearInput(); return; }
        requestPrediction({paragraphId: caret.paragraphId, before: (caret.before + text).slice(-600),
          remainder, trailingSpace});
        return;
      }
      if (text && applied === true && revision === typingRevision) {
        requestPrediction({ paragraphId: caret.paragraphId, before: (caret.before + text).slice(-600) });
      }
    });
  }

  function renderSuggestions() {
    wordBefore = undefined;
    if (dismissed || formatToolbar?.visible) return;
    if (modelOnly) { hideSuggestions(); return; }
    const raw = completion.suggest(prefix, dictionaries);
    const words = personal && prefix ? personal.rank(prefix,raw,correctionSettings.read().language,true) : raw;
    if (words.length === 0) {
      hideSuggestions();
      previewItems();
      return;
    }

    resetPreview();
    items = words.map((text, index) => ({ id: `${inputRevision}-${index}`, text }));
    helper.setItems(items);
    // Клавиатура остаётся у редактора, чтобы список не мешал набору текста.
    const height = helper.getItemsHeight(Math.min(items.length, VISIBLE_ROWS));
    helper.show(POPUP_WIDTH, height, false);
    previewItems();
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
    inputRevision += 1;
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
    personal?.configure(options.personalLearning ?? "document");
    formatToolbar?.configure(options.formatToolbar);
    clearInput();
    if (options.nextWord) void tiltypePredictionEngine.prepare(options.predictionMode).catch(error => console.error('TilType: model load failed',error));
    if (!options.layout) layoutContext = null;
    if (options.spelling || options.layout || options.proofing) startSpellcheck();
  }

  /** @param {EditorInput} [data] */
  function handleInput(data) {
    pendingStep = null;
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
    observation = completed && completed === prefix ? {word:completed,consumed:false} : undefined;
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
    if (phraseTimer !== undefined) clearTimeout(phraseTimer);
    if (predictAfterClear) requestPrediction(undefined, "", observation);
    else if (supportsCorrection && prefix.length >= 2) {
      const settings = correctionSettings.read();
      if (settings.nextWord && (settings.predictionMode === "phrases" || settings.predictionMode === "gru")) {
        const revision = inputRevision;
        phraseTimer = setTimeout(() => {
          if (revision === inputRevision && !dismissed) requestPrediction(undefined, prefix);
        }, 100);
      }
    }
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
      if (pendingStep) {
        if (key.keyCode === TAB_KEY && !key.altKey && !key.ctrlKey && !key.metaKey && !key.shiftKey) {
          pendingStep.queued++;
          return;
        }
        clearInput();
      }
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
        acceptingTab = true;
        addSpaceToSelection = correctionSettings.read().spaceAfterTab;
        try {
          plugin.inputHelper_onSelectItem?.(helper.getSelectedItem());
        } finally {
          acceptingTab = false;
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
      if (inline && [35,36,37,39,33,34].includes(key.keyCode)) { clearInput(); return; }
      nativeKeyboard?.call(plugin, key);
      if (key.keyCode === 38 || key.keyCode === 40) updatePreview();
    });
    supportsCorrection = plugin.info.editorType === "word";
    if (supportsCorrection) void wordContext?.load();
    supportsCaretRead = supportsCorrection || plugin.info.editorType === "slide";
    if (supportsCorrection) {
      if (typeof createInlinePreview === "function") inline = createInlinePreview(clearInput);
      formatToolbar = installFormatToolbar(plugin, sdk, clearInput);
      queueProofing = installProofing(plugin);
      closeSettings = addSettingsButton(plugin, sdk.PluginWindow, applyCorrectionSettings);
      applyCorrectionSettings(correctionSettings.read());
    }
    plugin.attachEditorEvent("onInputHelperClear", handleEditorClear);
    plugin.attachEditorEvent("onInputHelperInput", handleInput);

    if (modelOnly) return;
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
    const replaced = prefix;
    const selectedContext = wordBefore;
    const continueTyping = supportsCorrection && acceptingTab;
    clearInput();
    const revision = typingRevision;
    plugin.executeMethod("InputText", [text, replaced], () => {
      if (supportsCorrection) personal?.learnWord(replaced,text.trimEnd(),correctionSettings.read().language,selectedContext);
      if (continueTyping && revision === typingRevision) requestPrediction({before:text});
    });
  };

  plugin.button = (_id, windowId) => {
    if (windowId) {
      closeSettings?.();
      return;
    }
    inline?.close();
    formatToolbar?.close();
    if (helper) clearInput();
    plugin.executeCommand("close", "");
  };
})();

