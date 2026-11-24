/**
 * Применяет контекстные ранжировщики TilType AI Phrases в рабочем порядке.
 * Используется отдельно от обработчиков клавиатуры и списка редактора.
 */
"use strict";

const neuralPredictionOptions = (() => {
  /**
   * Возвращает фразы текущего предложения. При наличии истории уточняет их по документу.
   * @param {string} before @param {string} raw
   * @param {{ model: NeuralModel, language: NeuralLanguage, context: string[] }} selected
   * @returns {string[]}
   */
  function complete(before, raw, selected) {
    const history = neuralDocumentFeatures.sentences(raw);
    const documentContext = history.length > 0 && typeof neuralDocumentContinuation !== "undefined";
    const useAbstention = typeof neuralDocumentAbstention !== "undefined";
    const sentence = neuralEngine.sentenceOptions(selected, Boolean(raw) && (documentContext || useAbstention));
    let options = sentence.options;
    if (!raw) return options;
    if (history.length) {
      const local = options;
      options = neuralDocumentRanker.rank(local, history, selected.context, selected.language, selected.model);
      if (typeof neuralDocumentPhrase !== "undefined") options = neuralDocumentPhrase.complete(options, history, before);
      if (documentContext) {
        options = neuralDocumentContinuation.rank(local, options, history, selected.context,
          selected.language, selected.model, sentence.rankedWords);
      }
      if (typeof neuralPhraseConfidence !== "undefined") {
        options = neuralPhraseConfidence.apply(options, local, history, selected.context, selected.language, selected.model);
      }
    }
    if (typeof neuralTopicPointer !== "undefined") {
      options = neuralTopicPointer.rank(options, raw, selected.context, selected.language, selected.model);
    }
    if (typeof neuralPhraseAlternative !== "undefined") {
      options = neuralPhraseAlternative.append(options, sentence.options, raw, selected.context,
        selected.language, selected.model);
    }
    if (typeof neuralDocumentHistoryOptions !== "undefined") {
      options = neuralDocumentHistoryOptions.append(options, raw, selected.context, selected.language, selected.model);
    }
    if (!options.length && useAbstention) {
      options = neuralDocumentAbstention.suggest(raw, selected.context, selected.language,
        selected.model, sentence.rankedWords);
    }
    if (typeof neuralDocumentPurpose !== "undefined") {
      options = neuralDocumentPurpose.rank(options, before, raw, selected.model.purposeProfile,
        sentence?.rankedWords);
      options = neuralDocumentPurpose.expand(options, before, raw, selected.model.purposeProfile,
        sentence?.rankedWords, selected.language);
    }
    if (typeof neuralDocumentVectorRank !== "undefined") {
      const model = selected.model;
      options = neuralDocumentVectorRank.rank(options, before, raw, model,
        model.purposeProfile?.inventory, model.documentVector);
    }
    if (typeof neuralAlignedDocumentCompletion !== "undefined") {
      options = neuralAlignedDocumentCompletion.append(options, before, raw, selected);
    }
    return options;
  }

  return { complete };
})();
