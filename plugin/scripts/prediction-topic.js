/**
 * Оценивает тематическую связь продолжения с предыдущим текстом.
 * Раздельно учитывает близкие слова и сжатую тему более ранней части документа.
 */
"use strict";

/** @typedef {{roots:string[][],entries:Record<string,[number,string,number][]>}} NeuralTopicTables */
const tiltypePredictionTopic = (() => {
  const TERM = /\p{L}+(?:['’-]\p{L}+)*/gu;
  const ROOT_LENGTH = 5;

  /**
   * Создаёт оценку для кандидатов текущей позиции.
   * @param {PredictionCaret} caret @param {NeuralModel} model
   * @param {(phrase: string) => boolean} matchesLanguage
   * @returns {(phrase: string) => number}
   */
  function score(caret, model, matchesLanguage) {
    const weights = new Map(/** @type {[string, number][]} */ ([]));
    const roots = new Map(/** @type {[string, number][]} */ ([]));
    const recent = (caret.history ?? "").toLowerCase().match(TERM)?.slice(-180) ?? [];
    const older = caret.documentTopic ?? [];
    /** @param {string} word @param {number} amount */
    function count(word, amount) {
      if (word.length < ROOT_LENGTH || (model.vocabulary.get(word) ?? Infinity) < 120 || !matchesLanguage(word)) return;
      const root = word.slice(0, ROOT_LENGTH);
      weights.set(word, (weights.get(word) ?? 0) + amount);
      roots.set(root, (roots.get(root) ?? 0) + amount);
    }
    for (const [word, frequency] of older) count(word, 0.42 * Math.log1p(frequency));
    for (const word of recent) count(word, 0.65);
    if (!weights.size) return () => 0;
    const affinity = neuralDocumentVectorRank.topicAffinity(weights, model);
    return phrase => {
      let matches = 0;
      for (const word of phrase.toLowerCase().match(TERM) ?? []) {
        matches = Math.max(matches, roots.get(word.slice(0, ROOT_LENGTH)) ?? 0);
      }
      return 0.35 * affinity(phrase) + 0.22 * Math.min(2, Math.log1p(matches));
    };
  }

  /**
   * Ищет продолжение последних слов с учётом тематических признаков слева.
   * При слабой поддержке добавляет фразу после первой подсказки.
   * @param {string[]} options @param {string} before @param {string} history
   * @param {NeuralTopicTables|undefined} tables @param {(s:string)=>boolean} matchesLanguage
   */
  function extend(options, before, history, tables, matchesLanguage) {
    const suffix = before.toLowerCase().match(/(\p{L}+ +\p{L}+) +$/u)?.[1].replace(/ +/gu, " ");
    if (!suffix || !tables) return options;
    const last = suffix.split(" ")[1];
    const exact = tables.entries[suffix];
    const rows = Array.isArray(exact) ? exact : tables.entries[last];
    if (!Array.isArray(rows)) return options;
    const words = [...new Set((history.slice(-800) + " " + before).toLowerCase().match(TERM) || [])];
    const scores = new Map();
    const strengths = new Map();
    for (const [topic, phrase, count] of rows) {
      if (!matchesLanguage(phrase)) continue;
      if (!strengths.has(topic)) {
        strengths.set(topic, tables.roots[topic].filter(root => words.some(word => word.startsWith(root))).length);
      }
      const signals = strengths.get(topic);
      if (!signals) continue;
      scores.set(phrase, Math.max(scores.get(phrase) || 0, count * Math.min(3, signals)));
    }
    const ranked = [...scores].sort((a,b) => b[1]-a[1]);
    if (!ranked.length) return options;
    const [phrase, support] = ranked[0];
    const sameHead = options[0]?.toLowerCase().split(" ")[0] === phrase.split(" ")[0];
    // Для точной пары допускаем смену первого слова, если продолжение
    // многократно встречалось и заметно опережает остальные варианты.
    const total = ranked.reduce((sum, item) => sum + item[1], 0);
    const strong = (sameHead && support >= (exact ? 3 : 6) && support >= 2 * (ranked[1]?.[1] || 0))
      || (Array.isArray(exact) && support >= 8 && support >= 0.75 * total);
    const rest = options.filter(item => item.toLowerCase() !== phrase);
    if (strong || !rest.length || options[0]?.toLowerCase() === phrase) return [phrase,...rest].slice(0,3);
    return [rest[0],phrase,...rest.slice(1)].slice(0,3);
  }

  return { score, extend };
})();
