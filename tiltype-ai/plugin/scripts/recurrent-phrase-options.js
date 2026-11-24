/**
 * Подключает рекуррентный декодер к экспериментальной сборке.
 * Удлиняет первый однословный вариант при согласии двух моделей.
 */
"use strict";

const neuralRecurrentPhraseOptions = (() => {
  const MIN_CONFIDENCE = 0.05;
  const SENTENCE_BOUNDARY = /[.!?…\r\n]/u;
  /** @type {WeakMap<NeuralModel, ReturnType<typeof neuralRecurrentPhraseDecoder.restore>>} */
  const decoders = new WeakMap();

  /**
   * Регистрирует локальные веса для уже загруженной модели языка.
   * Может выбросить ошибку при несовместимом ресурсе.
   * @param {NeuralModel} model @param {RecurrentResource} resource
   */
  function attach(model, resource) {
    decoders.set(model, neuralRecurrentPhraseDecoder.restore(resource, model));
  }

  /**
   * Заменяет короткую подсказку фразой с тем же первым словом.
   * @param {string[]} options @param {string} prefix @param {string} history @param {NeuralModel} model
   * @returns {string[]}
   */
  function apply(options, prefix, history, model) {
    const lead = options[0];
    const decoder = decoders.get(model);
    if (!decoder || !lead || lead.includes(" ")) return options;
    const { generate, words } = neuralRecurrentPhraseDecoder;
    const head = words(lead)[0];
    const sentence = prefix.split(SENTENCE_BOUNDARY).at(-1) ?? "";
    const choice = generate(decoder, sentence, history).find(item => words(item.phrase)[0] === head);
    if (!choice || choice.confidence < MIN_CONFIDENCE) return options;
    const second = words(choice.phrase)[1];
    const completion = lead + " " + (second === "i" ? "I" : second);
    return [completion, ...options.slice(1).filter(option => option.toLowerCase() !== completion.toLowerCase())];
  }

  return { attach, apply };
})();
