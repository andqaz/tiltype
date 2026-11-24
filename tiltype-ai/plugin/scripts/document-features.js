/**
 * Извлекает из предыдущих предложений тематические признаки TilType.
 * Использует уже загруженные эмбеддинги и совпадения локального контекста.
 */
"use strict";

/** @typedef {{ choice: string, vector: number[] }} DocumentCandidate */

const neuralDocumentFeatures = (() => {
  const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;
  const SENTENCE_END = /\n+|(?<=[.!?…])\s+/u;
  const MAX_HISTORY = 6;
  const RETRIEVAL_HISTORY = 16;
  const MIN_TERM_RANK = 120;
  const HISTORY_DECAY = 0.65;
  /** @type {{ text: string, sentences: string[] } | undefined} */
  let parsedHistory;

  /** @param {string} text @returns {string[]} Нормализованные слова. */
  function words(text) {
    return text.toLowerCase().replaceAll("’", "'").match(WORD) ?? [];
  }

  /** @param {string} text @returns {string[]} Последние полные предложения. */
  function sentences(text) {
    if (parsedHistory?.text === text) return parsedHistory.sentences;
    const sentences = text.split(SENTENCE_END).map(sentence => sentence.trim())
      .filter(sentence => words(sentence).length >= 4).slice(-RETRIEVAL_HISTORY);
    parsedHistory = { text, sentences };
    return sentences;
  }

  /** @param {NeuralModel} model @param {string} word */
  function project(model, word) {
    const index = model.vocabulary.get(word);
    if (index === undefined || index < MIN_TERM_RANK) return null;
    const { values, columns, scale } = model.embedding;
    return { values, offset: index * columns, columns, scale: scale[index] };
  }

  /** @typedef {{ width: number, occurrences: number }} HistoricalContinuation */
  /** @typedef {{ counts: Map<string, number>, continuations: Map<string, HistoricalContinuation>, vector: Float32Array, norm: number }} DocumentContextFeatures */
  /** @typedef {{ history: string[], tokens: { terms: string[], weight: number }[], counts: Map<string, number>, vector: Float32Array, norm: number }} PreparedHistory */
  /** @type {WeakMap<NeuralModel, PreparedHistory>} */
  const preparedByModel = new WeakMap();

  /** @param {string[]} history @param {NeuralModel} model @returns {PreparedHistory} */
  function prepare(history, model) {
    const recent = history.slice(-MAX_HISTORY);
    const previous = preparedByModel.get(model);
    if (previous && previous.history.length === recent.length &&
        recent.every((sentence, index) => sentence === previous.history[index])) return previous;
    /** @type {Map<string, number>} */
    const counts = new Map();
    const vector = new Float32Array(model.embedding.columns);
    const tokens = recent.map((sentence, index) => ({
      terms: words(sentence), weight: HISTORY_DECAY ** (recent.length - index - 1),
    }));
    for (const { terms, weight } of tokens) {
      for (const term of terms) {
        counts.set(term, (counts.get(term) ?? 0) + weight);
        const projection = project(model, term);
        if (!projection) continue;
        for (let column = 0; column < vector.length; column += 1) {
          vector[column] += projection.values[projection.offset + column] * projection.scale * weight;
        }
      }
    }
    const prepared = { history: recent, tokens, counts, vector, norm: Math.hypot(...vector) };
    preparedByModel.set(model, prepared);
    return prepared;
  }

  /** @param {string[]} history @param {string[]} context @param {NeuralModel} model @returns {DocumentContextFeatures} */
  function summarize(history, context, model) {
    const prepared = prepare(history, model);
    /** @type {Map<string, HistoricalContinuation>} */
    const continuations = new Map();
    if (context.length >= 2) {
      const [third, second, last] = [context.at(-3), context.at(-2), context.at(-1)];
      for (const { terms, weight } of prepared.tokens) {
        for (let index = 2; index < terms.length; index += 1) {
          if (terms[index - 1] !== last || terms[index - 2] !== second) continue;
          const width = third !== undefined && terms[index - 3] === third ? 3 : 2;
          const candidate = terms[index + 1] ? terms[index] + " " + terms[index + 1] : terms[index];
          const previous = continuations.get(candidate);
          continuations.set(candidate, { width: Math.max(width, previous?.width ?? 0),
            occurrences: weight + (previous?.occurrences ?? 0) });
        }
      }
    }
    if (context.length >= 3 && history.length > MAX_HISTORY && continuations.size === 0) {
      const suffix = context.slice(-3);
      const informative = suffix.filter(term => (model.vocabulary.get(term) ?? Infinity) >= MIN_TERM_RANK && term.length >= 4);
      if (informative.length >= 2) {
        for (const sentence of history.slice(-RETRIEVAL_HISTORY, -MAX_HISTORY)) {
          const terms = words(sentence);
          for (let index = 3; index < terms.length; index += 1) {
            if (!suffix.every((term, offset) => term === terms[index - 3 + offset])) continue;
            const candidate = terms[index + 1] ? terms[index] + " " + terms[index + 1] : terms[index];
            const previous = continuations.get(candidate);
            continuations.set(candidate, { width: 3, occurrences: (previous?.occurrences ?? 0) + 0.25 });
          }
        }
      }
    }
    return { counts: prepared.counts, vector: prepared.vector, norm: prepared.norm, continuations };
  }

  /** @param {DocumentContextFeatures} document @param {NeuralModel} model @param {string} word */
  function topicSimilarity(document, model, word) {
    const projection = project(model, word);
    if (!projection || !document.norm) return 0;
    let product = 0;
    let squaredNorm = 0;
    for (let column = 0; column < projection.columns; column += 1) {
      const value = projection.values[projection.offset + column];
      product += document.vector[column] * value;
      squaredNorm += value * value;
    }
    return squaredNorm ? product / (Math.sqrt(squaredNorm) * document.norm) : 0;
  }

  /**
   * Возвращает признаки локальных вариантов и подтверждённых продолжений из истории.
   * @param {string[]} local @param {string[]} history @param {string[]} context @param {NeuralModel} model
   * @returns {DocumentCandidate[]}
   */
  function alternatives(local, history, context, model) {
    const document = summarize(history, context, model);
    const allowed = new Set(local.map(choice => choice.split(" ")[0].toLowerCase()));
    const additions = [...document.continuations]
      .filter(([phrase, data]) => data.width >= 3 || allowed.has(phrase.split(" ")[0]))
      .sort((left, right) => right[1].width - left[1].width || right[1].occurrences - left[1].occurrences)
      .slice(0, 3).map(([phrase]) => phrase);
    return [...new Set([...local, ...additions])].map(choice => {
      const [first, second] = words(choice);
      const position = local.indexOf(choice);
      const continuation = document.continuations.get(choice.toLowerCase());
      return { choice, vector: [
        Number(position === 0), Number(position === 1), Number(position === 2), Number(Boolean(second)),
        Number(position < 0), Math.log1p(document.counts.get(first) ?? 0), topicSimilarity(document, model, first),
        continuation ? continuation.width / 3 : 0,
        Math.log1p(continuation?.occurrences ?? 0), second ? topicSimilarity(document, model, second) : 0,
      ] };
    });
  }

  return { alternatives, sentences };
})();
