/**
 * Выбирает продолжение, если история даёт ему преимущество перед первой подсказкой.
 * Использует локальную модель, контекстный поиск и замороженные веса трёх языков.
 */
"use strict";

const neuralDocumentContinuation = (() => {
  const MIN_ADVANTAGE = 0.45;
  const SECOND_WORD_CONFIDENCE = 0.25;
  const CONTEXT_WIDTH = 24;
  const MAX_PASSAGE_PHRASES = 4;
  /** @type {Record<NeuralLanguage, number[]>} */
  const weights = {
    ru: [0.9293845690573388, 0.4054937983831695, -0.6886017292352095, 0.2566659707312734, -0.44256282427632787, 0.5249738292369033, 0.08505110505349399, 0, 0.09517718223424046, 0.07395479296978406, 1.080997597414225, 0.5008214417057957, 0.021194575642614014, 0.28936022080563517],
    kk: [0.7989878921051138, 0.22885811991681695, -0.20534221727048382, 0.34032431249887335, -0.2883000666108507, 0.6896215629692959, 0.43139755267422414, 0, 0.29303587466770864, 0.09780805240966678, 0.9136898718899304, 0.49671473737558614, 0.38051086186036176, 0.0542816585992993],
    en: [1.0301047068055, 0.5415186072673224, -0.9043593358287436, 0.08695000699193593, -0.6914517934732469, 0.36786325062534186, 0.6383827106861867, 0, -0.21075599753085464, 0.3644275715287712, 0.7424711133909072, 0.3669978673100341, 0.04842433381464872, 0.11490245620642552],
  };

  /** @param {string} text @returns {string} Первое слово в нижнем регистре. */
  function first(text) {
    return text.toLowerCase().split(" ")[0];
  }

  /**
   * Измеряет повторяемость фразы и длину совпадающего контекста в прошлых предложениях.
   * @param {string} phrase @param {string[]} context @param {PassageTerm[][]} history @returns {number[]}
   */
  function lexicalEvidence(phrase, context, history) {
    const normalized = phrase.toLowerCase().split(" ");
    let forms = 0;
    let exact = 0;
    let width = 0;
    let recent = 0;
    for (const [age, sentence] of history.entries()) {
      let matched = false;
      let started = false;
      for (let index = 0; index < sentence.length; index += 1) {
        if (sentence[index].word !== normalized[0]) continue;
        started = true;
        if (!normalized.every((word, offset) => word === sentence[index + offset]?.word &&
            (offset === 0 || sentence[index + offset].contiguous))) continue;
        matched = true;
        let span = 0;
        while (span < CONTEXT_WIDTH / 4 && context.at(-span - 1) && sentence[index - span]?.contiguous &&
            sentence[index - span - 1]?.word === context.at(-span - 1)) span += 1;
        width = Math.max(width, span);
        recent = Math.max(recent, 1 / (1 + age * 0.2));
      }
      forms += Number(started);
      exact += Number(matched);
    }
    return [Math.log1p(forms), Math.log1p(exact), width, recent];
  }

  /**
   * Проверяет, может ли ещё не найденное окончание обогнать исходное слово.
   * Без параллельного фрагмента совпадения целой фразы входят в совпадения её
   * первого слова. При неотрицательных весах этих признаков они не увеличат оценку.
   * @param {string} original @param {string} originalFirst @param {string[]} local
   * @param {PassageMatch[]} parallels @param {number[]} coefficients @returns {boolean}
   */
  function mayExtend(original, originalFirst, local, parallels, coefficients) {
    if (parallels.some(item => item.phrase.startsWith(originalFirst + " "))) return true;
    if (coefficients[9] < 0 || coefficients[10] < 0 || coefficients[11] < 0) return true;
    const advantage = coefficients[5] - coefficients[0] - coefficients[3] -
      Number(original === local[0]) * coefficients[1] - Number(local.includes(original)) * coefficients[2];
    return advantage >= MIN_ADVANTAGE - 1e-9;
  }

  /**
   * Ранжирует варианты фразы и оставляет исходный список, пока преимущество не выше порога.
   * @param {string[]} local @param {string[]} baseline @param {string[]} history
   * @param {string[]} context @param {NeuralLanguage} language @param {NeuralModel} model
   * @param {RankedNeuralWord[]} rankedWords @returns {string[]}
   */
  function rank(local, baseline, history, context, language, model, rankedWords) {
    const [original] = baseline;
    if (!original || !history.length) return baseline;
    const terms = neuralDocumentPassage.prepare(history);
    const parallels = neuralDocumentPassage.retrieve(context, terms, model);
    const analogs = new Map(parallels.map(item => [item.phrase, item]));
    const proposed = parallels.slice(0, MAX_PASSAGE_PHRASES).map(item => item.phrase);
    const originalFirst = first(original);
    const coefficients = weights[language];
    if (!original.includes(" ") && mayExtend(original, originalFirst, local, parallels, coefficients)) {
      const [extension] = neuralEngine.rankWords(model, [...context, originalFirst], 1, false);
      if (extension?.probability >= SECOND_WORD_CONFIDENCE) proposed.push(original + " " + extension.word);
    }
    if (!proposed.length && !local[0]) return baseline;
    const alternatives = new Set([...baseline, ...local, ...proposed]);
    if (alternatives.size < 2) return baseline;
    const localRank = new Map(rankedWords.map(item => [item.word.toLowerCase(), item.probability]));
    /** @param {string} choice */
    function score(choice) {
      const word = first(choice);
      const parallel = analogs.get(choice.toLowerCase());
      const features = [
        Number(choice === original), Number(choice === local[0]), Number(local.includes(choice)),
        Number(baseline.includes(choice)), Number(word === originalFirst), Number(choice.includes(" ")),
        Math.log1p(20 * (localRank.get(word) ?? 0)), context.length / CONTEXT_WIDTH,
        ...lexicalEvidence(choice, context, terms), parallel?.strength ?? 0, Math.log1p(parallel?.occurrences ?? 0),
      ];
      return coefficients.reduce((sum, weight, index) => sum + weight * features[index], 0);
    }
    let best = original;
    let bestScore = score(original) + MIN_ADVANTAGE;
    for (const choice of alternatives) {
      if (choice === original) continue;
      const value = score(choice);
      if (value <= bestScore) continue;
      best = choice;
      bestScore = value;
    }
    return best === original ? baseline :
      [best, ...baseline.filter(choice => first(choice) !== first(best))].slice(0, 3);
  }

  return { rank };
})();
