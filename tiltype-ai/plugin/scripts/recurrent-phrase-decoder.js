/**
 * Выполняет локальную рекуррентную генерацию двухсловных продолжений.
 * Использует существующие эмбеддинги TilType и квантованный выход.
 */
"use strict";

/** @typedef {{ hidden: number, input: number, words: string[], recurrent: string[], output: string[], history: string }} RecurrentResource */

const neuralRecurrentPhraseDecoder = (() => {
  const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;
  const EMBEDDING_CACHE_LIMIT = 512;

  /** @param {string} text */
  function words(text) {
    return text.toLowerCase().replaceAll("’", "'").match(WORD) ?? [];
  }

  /** @param {NeuralModel} model */
  function embeddingLookup(model) {
    /** @type {Map<number, Float32Array>} */
    const cached = new Map();
    const { values, scale, columns } = model.embedding;
    return (/** @type {string} */ word) => {
      let id = model.vocabulary.get(word);
      if (id === undefined) {
        let hash = 2166136261;
        for (const letter of word.slice(-3)) hash = Math.imul(hash ^ letter.charCodeAt(0), 16777619);
        id = model.words.length + 1 + ((hash >>> 0) % model.unknownBuckets);
      }
      const found = cached.get(id);
      if (found) return found;
      const row = Float32Array.from({ length: columns }, (_, index) => values[id * columns + index] * scale[id]);
      if (cached.size >= EMBEDDING_CACHE_LIMIT) {
        const oldest = cached.keys().next();
        if (!oldest.done) cached.delete(oldest.value);
      }
      cached.set(id, row);
      return row;
    };
  }

  const BOUNDARY = /\n+|(?<=[.!?…])\s+/u;
  const WINDOW = 23;

  /** @template T @param {string} encoded @param {new (buffer: ArrayBuffer) => T} Type */
  function typedArray(encoded, Type) {
    return new Type(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)).buffer);
  }

  /** @param {RecurrentResource} resource @param {NeuralModel} base */
  function restore(resource, base) {
    const { hidden, input, words: vocabulary } = resource;
    if (input !== base.embedding.columns) throw new Error("Unexpected recurrent embedding width");
    const [inputWeights, stateWeights, inputBiases, stateBiases] = resource.recurrent.map(encoded => typedArray(encoded, Float32Array));
    const outputWeights = typedArray(resource.output[0], Int8Array);
    const outputScales = typedArray(resource.output[1], Float32Array);
    const outputBiases = typedArray(resource.output[2], Float32Array);
    const history = typedArray(resource.history, Float32Array);
    if (inputWeights.length !== hidden * input * 3 || stateWeights.length !== hidden ** 2 * 3 ||
        outputWeights.length !== hidden * vocabulary.length || outputScales.length !== vocabulary.length ||
        outputBiases.length !== vocabulary.length || history.length !== hidden * input * 2 ||
        inputBiases.length !== 3 * hidden || stateBiases.length !== 3 * hidden) throw new Error("Invalid recurrent weights");
    return { hidden, input, vocabulary, embedding: embeddingLookup(base), inputWeights, stateWeights,
      inputBiases, stateBiases, outputWeights, outputScales, outputBiases, history };
  }

  /** @param {Float32Array | Int8Array} matrix @param {number} offset @param {Float32Array} values */
  function rowSum(matrix, offset, values) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) sum += matrix[offset + index] * values[index];
    return sum;
  }

  /** @param {ReturnType<typeof restore>} model @param {string} raw */
  function initialState(model, raw) {
    const context = new Float32Array(2 * model.input);
    const sentences = raw.trimEnd().split(BOUNDARY).map(words).filter(terms => terms.length).slice(-2).reverse();
    for (const [index, terms] of sentences.entries()) {
      const accumulated = new Float32Array(model.input);
      for (const word of new Set(terms.slice(-32))) {
        if (word.length < 3) continue;
        const embedding = model.embedding(word);
        for (let column = 0; column < model.input; column++) accumulated[column] += embedding[column];
      }
      const norm = Math.hypot(...accumulated);
      if (norm) for (let column = 0; column < model.input; column++) {
        context[index * model.input + column] = accumulated[column] / norm;
      }
    }
    return Float32Array.from({ length: model.hidden }, (_, index) =>
      Math.tanh(rowSum(model.history, index * context.length, context)));
  }

  const logistic = value => 1 / (1 + Math.exp(-value));

  /** @param {ReturnType<typeof restore>} model @param {Float32Array} state @param {Float32Array} input */
  function step(model, state, input) {
    const fromWord = row => rowSum(model.inputWeights, row * model.input, input) + model.inputBiases[row];
    const fromState = row => rowSum(model.stateWeights, row * model.hidden, state) + model.stateBiases[row];
    const result = new Float32Array(model.hidden);
    for (let index = 0; index < model.hidden; index++) {
      const update = index + model.hidden;
      const content = index + 2 * model.hidden;
      const reset = logistic(fromWord(index) + fromState(index));
      const gate = logistic(fromWord(update) + fromState(update));
      const proposal = Math.tanh(fromWord(content) + reset * fromState(content));
      result[index] = (1 - gate) * proposal + gate * state[index];
    }
    return result;
  }

  /** @param {ReturnType<typeof restore>} model @param {Float32Array} state @param {Float32Array} initial @param {number} limit */
  function top(model, state, initial, limit) {
    const features = state.map((value, index) => value + 0.35 * initial[index]);
    let sum = 0;
    const best = [];
    for (let index = 0; index < model.vocabulary.length; index++) {
      const embedding = rowSum(model.outputWeights, index * model.hidden, features);
      const probability = Math.exp(embedding * model.outputScales[index] + model.outputBiases[index]);
      sum += probability;
      if (best.length === limit && probability <= best.at(-1).probability) continue;
      best.push({ term: model.vocabulary[index], probability });
      best.sort((a, b) => b.probability - a.probability);
      if (best.length > limit) best.pop();
    }
    return best.map(({ term, probability }) => ({ term, probability: probability / sum }));
  }

  /** @param {ReturnType<typeof restore>} model @param {string} prefix @param {string} rawHistory */
  function generate(model, prefix, rawHistory) {
    if (!model) return [];
    const tokens = words(prefix).slice(-WINDOW);
    if (!tokens.length) return [];
    const initial = initialState(model, rawHistory);
    let current = initial;
    for (const token of tokens) current = step(model, current, model.embedding(token));
    return top(model, current, initial, 3).flatMap(first => {
      const state = step(model, current, model.embedding(first.term));
      return top(model, state, initial, 3).map(second => ({
        phrase: first.term + " " + second.term, confidence: first.probability * second.probability,
      }));
    }).sort((a, b) => b.confidence - a.confidence);
  }

  return { generate, restore, words };
})();
