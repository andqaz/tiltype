/**
 * Добавляет двухсловную подсказку, когда корпусный движок выдал только отдельные слова.
 * Второе слово вычисляется по уже набранному тексту и первому варианту.
 */
"use strict";

const tiltypePhraseExtension = (() => {
  const MIN_EXTENSION = 0.08;
  const MIN_LEADING_EXTENSION = 0.35;
  const MAX_OPTIONS = 3;

  /**
   * Предлагает фразу, сохраняя однословный вариант в списке.
   * @param {string[]} options
   * @param {{ model: NeuralModel, context: string[] }} selected
   * @param {(phrase: string) => boolean} matchesLanguage
   * @param {(phrase: string) => number} [topicScore]
   * @returns {string[]}
   */
  function add(options, selected, matchesLanguage, topicScore = () => 0) {
    const [first] = options;
    if (!first) return options;
    const phrases = options.filter(option => option.includes(" "));
    if (phrases.length) {
      if (phrases.length < 2) return options;
      let index = 0;
      const ordered = phrases.map((phrase, position) => ({ phrase, score: topicScore(phrase) - position * 0.2 }))
        .sort((a, b) => b.score - a.score);
      return options.map(option => option.includes(" ") ? ordered[index++].phrase : option);
    }
    const { model, context } = selected;
    const head = first.toLowerCase().replaceAll("’", "'");
    const continued = [...context, head].slice(-model.contextSize);
    const second = neuralEngine.rankWords(model, continued, 6, true)
      .filter(item => item.probability >= MIN_EXTENSION && item.word.toLowerCase() !== head && matchesLanguage(item.word))
      .map(item => ({ ...item, score: Math.log(item.probability) + topicScore(first + " " + item.word) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!second) return options;
    const phrase = first + " " + second.word;
    if (second.probability >= MIN_LEADING_EXTENSION) return [phrase, ...options.slice(0, MAX_OPTIONS - 1)];
    return [first, phrase, ...options.slice(1, MAX_OPTIONS - 1)];
  }

  return { add };
})();
