/**
 * Загружает выбранный движок прогноза и возвращает варианты для общего списка.
 * Словарь, однословная модель, фразовая модель и GRU используют локальные ресурсы.
 */
"use strict";

const tiltypePredictionEngine = (() => {
  const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;
  const LATIN = /^[a-z]+(?:['’-][a-z]+)*$/u;
  const RUSSIAN = /^[а-яё]+(?:['’-][а-яё]+)*$/u;
  const CYRILLIC = /^[а-яёәғқңөұүһі]+(?:['’-][а-яёәғқңөұүһі]+)*$/u;
  /** @type {Map<PredictionMode, Promise<NeuralModels>>} */
  const loading = new Map();

  /** @param {PredictionMode} mode */
  function prepare(mode) {
    if (mode === "dictionary") {
      return nextWord.load().then(() => ({}));
    }
    let pending = loading.get(mode);
    if (!pending) {
      pending = Promise.all(neuralEngine.LANGUAGES.map(async language => {
        try {
          const model = await loadNeuralModel(language, mode);
          return /** @type {const} */ ([language, model]);
        } catch (error) {
          console.warn("TilType AI: local model unavailable", language, error);
          return null;
        }
      })).then(entries => {
        const models = Object.fromEntries(entries.filter(entry => entry !== null));
        if (!Object.keys(models).length) loading.delete(mode);
        return models;
      });
      loading.set(mode, pending);
    }
    return pending;
  }

  /**
   * Подбирает продолжение по снимку курсора и текущим настройкам.
   * @param {PredictionCaret} caret @param {CorrectionSettings} options
   * @returns {Promise<string[]>}
   */
  async function suggest(caret, options) {
    const mode = options.predictionMode;
    const models = await prepare(mode);
    if (mode === "dictionary") {
      const word = nextWord.suggest(caret.before, options.language);
      return word ? [word] : [];
    }
    if (mode === "word") {
      const word = neuralEngine.suggest(caret.before, models, options.language);
      return word ? [word] : [];
    }
    const selected = neuralEngine.selectSentence(caret.before, models, options.language);
    if (!selected) return [];
    const history = options.predictionHistory ? caret.history ?? "" : "";
    const alphabet = selected.language === "en" ? LATIN : selected.language === "ru" ? RUSSIAN : CYRILLIC;
    // Поиск по истории может вернуть слова другого языка из того же документа.
    /** @param {string} phrase */
    const matchesLanguage = phrase => {
      const terms = phrase.toLowerCase().match(WORD);
      return Boolean(terms && terms.every(word => alphabet.test(word)));
    };
    const phrases = neuralPredictionOptions.complete(caret.before, history, selected).filter(matchesLanguage);
    const candidates = mode === "gru" ?
      neuralRecurrentPhraseOptions.apply(phrases, caret.before, history, selected.model).filter(matchesLanguage) : phrases;
    const topic = options.predictionHistory ? tiltypePredictionTopic.score(caret, selected.model, matchesLanguage) : undefined;
    const optionsWithPhrases = tiltypePhraseExtension.add(candidates, selected, matchesLanguage, topic);
    return tiltypePredictionTopic.extend(optionsWithPhrases, caret.before, history, selected.model.topics, matchesLanguage);
  }

  return { prepare, suggest };
})();
