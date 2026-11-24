/**
 * Ранжирует варианты TilType по предыдущим предложениям документа.
 * Сохраняет ранее подтверждённую фразу и отдельно проверяет новые фразы.
 */
"use strict";

const neuralDocumentRanker = (() => {
  const OPTION_LIMIT = 3;
  /** @type {Record<NeuralLanguage, { word: number[], phrase: number[], gate: number | null }>} */
  const weights = {
    ru: {
      word: [0.9624950157151496, 0.16090035845539027, 0.009037077007309434, -0.1957672819199325, 0.7273567270615063, 0.48332206205822753, 0.42276027188882687, 1.5364193340198222, 0.8761286077782299, 0],
      phrase: [1.1711434051942116, 0.3886260510544616, 0.215875211192872, 0.5207979249011819, 0.08488771918305092, 0.48767345117821, 0.4244941517744942, 0.7744468217793082, 0.33788978454974616, 0.1987933319917837],
      gate: 1.4644516008210782,
    },
    kk: {
      word: [1.210358153725301, 0.28726262499330063, 0.11386881325018214, -0.197471359456546, 0.2644883228683984, 1.211536283710083, 0.1747424183092705, 1.354484840334955, 0.7234042826447085, 0],
      phrase: [1.3984042634096343, 0.45963310790929524, 0.28620189700041326, 0.18987441091327947, -0.26768470489654994, 1.3037129920586543, 0.15691278457026775, 0.35138408263222937, 0.29077315061520985, 0.07447979180386137],
      gate: null,
    },
    en: {
      word: [0.7899554959745267, 0.0832964865368904, -0.08053624385869981, -0.1939050087689033, 1.049381844651864, 0.58135595154966, 0.5693933287740244, 1.749107423155061, 0.809427350471935, 0],
      phrase: [1.1659532863466018, 0.45108986484363967, 0.2780715614874352, 0.053854901419285894, -0.052111071015796866, 0.5806470735843802, 0.7011207924278635, 0.9610761504541235, 0.5818187399556626, -0.15266769899426624],
      gate: null,
    },
  };

  /** @param {string} choice @returns {string} Первое слово в нижнем регистре. */
  function firstWord(choice) {
    return choice.toLowerCase().split(" ")[0];
  }

  /** @param {number[]} vector @param {number[]} coefficients */
  function score(vector, coefficients) {
    return vector.reduce((total, value, index) => total + value * coefficients[index], 0);
  }

  /** @param {DocumentCandidate[]} choices @returns {DocumentCandidate[]} Кандидаты без повторов первого слова. */
  function firstWordCandidates(choices) {
    /** @type {Map<string, DocumentCandidate>} */
    const words = new Map();
    for (const { choice, vector } of choices) {
      const first = firstWord(choice);
      const merged = words.get(first);
      if (!merged) {
        const representative = [...vector];
        representative[3] = representative[9] = 0;
        words.set(first, { choice: first, vector: representative });
        continue;
      }
      for (const feature of [0, 1, 2, 7, 8]) merged.vector[feature] = Math.max(merged.vector[feature], vector[feature]);
      merged.vector[4] = Math.min(merged.vector[4], vector[4]);
    }
    return [...words.values()];
  }

  /**
   * Возвращает до трёх вариантов с учётом истории документа.
   * @param {string[]} local @param {string[]} history @param {string[]} context
   * @param {NeuralLanguage} language @param {NeuralModel} model
   * @returns {string[]}
   */
  function rank(local, history, context, language, model) {
    if (!history.length || local[0]?.includes(" ")) return local;
    const coefficients = weights[language];
    const choices = neuralDocumentFeatures.alternatives(local, history, context, model);
    return firstWordCandidates(choices)
      .sort((left, right) => score(right.vector, coefficients.word) - score(left.vector, coefficients.word))
      .slice(0, OPTION_LIMIT).map(candidate => {
        const group = choices.filter(entry => firstWord(entry.choice) === candidate.choice);
        const plain = group.find(entry => !entry.vector[3]);
        const word = plain?.choice ?? (candidate.choice === "i" ? "I" : candidate.choice);
        if (coefficients.gate === null) return word;
        const reference = score(plain?.vector ?? candidate.vector, coefficients.phrase);
        const best = group.sort((left, right) => score(right.vector, coefficients.phrase) -
          score(left.vector, coefficients.phrase))[0];
        if (!best.vector[3]) return best.choice;
        if (!plain && !best.vector[4]) return best.choice;
        const bestScore = score(best.vector, coefficients.phrase);
        if (bestScore <= reference) return word;
        const marginReference = [...(plain?.vector ?? best.vector)];
        marginReference[3] = marginReference[9] = 0;
        if (!plain) marginReference[7] = marginReference[8] = 0;
        return bestScore - score(marginReference, coefficients.phrase) >= coefficients.gate ? best.choice : word;
      });
  }

  return { rank };
})();
