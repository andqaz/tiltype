/**
 * Подбирает следующее слово по локальным словарям сочетаемости.
 * Проверяет положение курсора через Office API перед вставкой прогноза.
 */
"use strict";

/** @typedef {{ paragraphId: string, position: number, before: string, history?: string, documentTopic?: [string, number][] }} PredictionCaret */
/** @typedef {Partial<Record<DictionaryLanguage, Record<string, string>>>} PredictionModels */
/** @typedef {{ contexts: Record<string, string>, suffixes: Record<string, string>, defaultWord: string }} FallbackModel */
/** @typedef {Partial<Record<DictionaryLanguage, FallbackModel>>} FallbackModels */

const nextWord = (() => {
  const CONTEXT = /(?:^|[^\p{L}\p{N}'-])((?:\p{L}+(?:['-]\p{L}+)* +){0,5}\p{L}+(?:['-]\p{L}+)*) $/u;
  const LATIN = /^[a-z]+(?:['-][a-z]+)*$/;
  const CYRILLIC = /^[а-яёәғқңөұүһі]+(?:['-][а-яёәғқңөұүһі]+)*$/;
  const KAZAKH_LETTERS = /[әғқңөұүһі]/;
  const PREVIOUS_ENDING_LENGTH = 3;
  /** @type {PredictionModels} */
  const models = {};
  /** @type {FallbackModels} */
  const fallbacks = {};
  /** @type {Promise<void> | undefined} */
  let loading;

  /** Загружает модели из пакета один раз, когда пользователь включает прогноз. */
  function load() {
    loading ??= Promise.all(dictionaryLanguages.flatMap(language => [
      loadModel(`predict-${language}`, (model) => {
        models[language] = /** @type {Record<string, string>} */ (model);
      }),
      loadModel(`predict-${language}-fallback`, (model) => {
        if (!isRecord(model.contexts) || !isRecord(model.suffixes) || typeof model.defaultWord !== "string" ||
            !model.defaultWord) throw new Error("Invalid fallback");
        fallbacks[language] = {
          contexts: /** @type {Record<string, string>} */ (model.contexts),
          suffixes: /** @type {Record<string, string>} */ (model.suffixes),
          defaultWord: model.defaultWord,
        };
      }),
    ])).then(() => undefined);
    return loading;
  }

  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /** @param {string} name @param {(model: Record<string, unknown>) => void} onLoad */
  function loadModel(name, onLoad) {
    return new Promise(resolve => {
      const request = new XMLHttpRequest();
      request.open("GET", `dictionaries/${name}.json`);
      request.overrideMimeType("application/json; charset=utf-8");
      request.onload = () => {
        try {
          if (request.status !== 0 && request.status !== 200) throw new Error(`HTTP ${request.status}`);
          const model = JSON.parse(request.responseText);
          if (!isRecord(model)) throw new Error("Invalid model");
          onLoad(model);
        } catch (error) {
          console.error("TilType AI: dictionary unavailable", name, error);
        } finally {
          resolve(undefined);
        }
      };
      request.onerror = () => {
        console.error("TilType AI: dictionary unavailable", name);
        resolve(undefined);
      };
      request.send();
    }).then(() => undefined);
  }

  /**
   * Ищет продолжение после пробела по позиции в предложении и контексту до шести слов.
   * @param {string} before Текст предложения слева от курсора.
   * @param {DictionaryLanguage | "auto"} preferred Язык для разрешения совпадений в кириллице.
   * @param {PredictionModels} [source] Словари уверенных прогнозов.
   * @param {FallbackModels} [fallback] Таблицы редких сочетаний и окончаний.
   * @returns {string | undefined} Продолжение, если определён поддерживаемый контекст.
   */
  function suggest(before, preferred, source = models, fallback = fallbacks) {
    const normalized = before.toLowerCase().replaceAll("’", "'");
    const match = CONTEXT.exec(normalized);
    if (!match) return undefined;
    const words = match[1].split(/ +/);
    const last = words[words.length - 1];
    const alphabet = LATIN.test(last) ? LATIN : CYRILLIC;
    const contexts = [];
    for (let start = words.length - 1; start >= 0 && alphabet.test(words[start]); start -= 1) {
      contexts.unshift(words.slice(start).join(" "));
    }
    if (contexts.length === 0) return undefined;
    const primary = alphabet === LATIN ? "en" : KAZAKH_LETTERS.test(contexts[0]) ? "kk" : "auto";
    const inferred = primary === "auto" ? chooseCyrillic(words, preferred, source, fallback) : primary;

    if (normalized.trimStart() === contexts[0] + " ") {
      const initial = lookupContext("^" + contexts[0], primary, inferred, source);
      if (initial) return initial;
    }
    const relaxed = {
      en: fallback.en?.contexts, ru: fallback.ru?.contexts, kk: fallback.kk?.contexts,
    };
    for (const context of contexts) {
      if (context === last && contexts.length >= 3) {
        const skipped = lookupContext("~" + words.at(-3) + " " + last, primary, inferred, relaxed);
        if (skipped) return skipped;
        if (contexts.length >= 4) {
          const wider = lookupContext("~~" + words.at(-4) + " " + last, primary, inferred, relaxed);
          if (wider) return wider;
        }
      }
      if (contexts.length >= 4 && context === contexts.at(-2)) {
        const anchored = lookupContext("?" + words.at(-4) + " " + context, primary, inferred, relaxed);
        if (anchored) return anchored;
      }
      if (context === last && contexts.length >= 2 && last.length > 3) {
        const ending = lookupContext("+" + words.at(-2) + " " + last.slice(-3), primary, inferred, relaxed);
        if (ending) return ending;
      }
      const precise = lookupContext(context, primary, inferred, source);
      if (precise) return precise;
      const previous = words.at(-2);
      if (context === last && contexts.length >= 2 && previous && previous.length > PREVIOUS_ENDING_LENGTH) {
        const endingKey = "=" + previous.slice(-PREVIOUS_ENDING_LENGTH) + " " + last;
        const ending = lookupContext(endingKey, primary, inferred, relaxed);
        if (ending) return ending;
      }
      const word = lookupContext(context, primary, inferred, relaxed);
      if (word) return word;
    }
    const model = inferred === "auto" ? undefined : fallback[inferred];
    if (!model) return undefined;
    for (const length of [4, 3, 2]) {
      if (last.length <= length) continue;
      const word = lookup(model.suffixes, last.slice(-length));
      if (word && word.toLowerCase() !== last) return word;
    }
    return model.defaultWord || undefined;
  }

  /** @param {string[]} words @param {DictionaryLanguage | "auto"} preferred @param {PredictionModels} source @param {FallbackModels} fallback */
  function chooseCyrillic(words, preferred, source, fallback) {
    if (preferred === "ru" || preferred === "kk") return preferred;
    if (!fallback.ru || !fallback.kk) return "auto";
    for (let index = words.length - 1; index >= 0; index -= 1) {
      const word = words[index];
      if (!CYRILLIC.test(word)) break;
      const ru = lookup(source.ru, word) || lookup(fallback.ru.contexts, word);
      const kk = lookup(source.kk, word) || lookup(fallback.kk.contexts, word);
      if (Boolean(ru) !== Boolean(kk)) return ru ? "ru" : "kk";
    }
    return "ru";
  }

  /** @param {string} context @param {DictionaryLanguage | "auto"} primary @param {DictionaryLanguage | "auto"} inferred @param {PredictionModels} source */
  function lookupContext(context, primary, inferred, source) {
    if (primary !== "auto") return lookup(source[primary], context);
    const ru = lookup(source.ru, context);
    const kk = lookup(source.kk, context);
    if (ru && kk && ru !== kk) return inferred === "ru" ? ru : inferred === "kk" ? kk : undefined;
    return ru ?? kk;
  }

  /** @param {PredictionModels[DictionaryLanguage]} model @param {string} context */
  function lookup(model, context) {
    return model && Object.hasOwn(model, context) ? model[context] : undefined;
  }

  return { load, suggest };
})();

/**
 * Снимает контекст для прогноза в конце предложения без выделения.
 * Выполняется как самостоятельная команда Office API.
 * @returns {PredictionCaret | null}
 */
function readPredictionCaret() {
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  const paragraph = document.GetCurrentParagraph();
  if (!range || !paragraph || range.GetStartPos() !== range.GetEndPos()) return null;
  if (document.GetCurrentSentence("after").trim()) return null;
  const before = document.GetCurrentSentence("before").slice(-600);
  if (!/\p{L} $/u.test(before)) return null;
  const position = range.GetStartPos();
  /** @type {PredictionCaret} */
  const caret = { paragraphId: paragraph.GetInternalId(), position, before };
  if (!Asc.scope?.tiltypeReadDocumentHistory || typeof document.GetRange !== "function" || position <= before.length) return caret;
  const historyLimit = 4096;
  try {
    const start = Math.max(0, position - historyLimit - before.length);
    const separators = { ParaSeparator: "\n", TableRowSeparator: "\n", NewLineSeparator: "\n" };
    const source = document.GetRange(start, position);
    const text = source?.GetText(separators);
    if (typeof text === "string" && text.endsWith(before)) caret.history = text.slice(0, -before.length).slice(-historyLimit);
    if (caret.paragraphId !== Asc.scope.tiltypeDocumentTopicParagraph) {
      // Возвращаем сжатую тему, сохраняя соседние предложения в отдельном поле.
      const older = start > 0 ? document.GetRange(0, start)?.GetText(separators) : "";
      const counts = new Map();
      for (const match of (older ?? "").toLowerCase().matchAll(/\p{L}{5,25}/gu)) {
        const word = match[0];
        counts.set(word, Math.min(24, (counts.get(word) ?? 0) + 1));
      }
      caret.documentTopic = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 96);
    }
  } catch (error) {
    console.warn("TilType AI: document history unavailable", error);
  }
  return caret;
}

/**
 * Применяет действие в позиции, для которой редактор показал прогноз.
 * @returns {boolean} Редактор применил действие.
 */
function applyPredictionAtCaret() {
  const { caret, text } = Asc.scope.tiltypePrediction;
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  if (!range || range.GetStartPos() !== caret.position || range.GetEndPos() !== caret.position ||
      document.GetCurrentParagraph()?.GetInternalId() !== caret.paragraphId ||
      !document.GetCurrentSentence("before").endsWith(caret.before) ||
      document.GetCurrentSentence("after").trim()) return false;
  return text ? document.EnterText(text) : document.InsertParagraphBreak();
}
