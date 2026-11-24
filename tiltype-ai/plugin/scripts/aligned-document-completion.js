/**
 * Добавляет фразу из похожего фрагмента текущего документа.
 * Использует выравнивание и корпусную поддержку, сохраняя уже показанные варианты.
 */
"use strict";

const neuralAlignedDocumentCompletion = (() => {
  const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;
  const THRESHOLD = 0.08;
  const MAX_OPTIONS = 3;
  const weights = {
    ru: [-2.229502526041455, 0.4664162453240966, -0.48517178029333746, -0.286194741999931,
      0.5634516734489035, 0.9502149898394883, 0.021493538594093812, 0.027684645921440904],
    kk: [-2.53399843043656, 0.33777478295142915, -0.073255103561092, -0.33325023072515914,
      0.6417491911213501, -0.11439037160987235, 0.4842176755851479, 0.08630368289691176],
    en: [-2.0211288381264576, 0.5531240599032083, -0.6032899067328585, -0.09437168481106842,
      0.4776169638525456, 0.7612858945025311, 0.34775440859881585, -0.06705184993495238],
  };

  /** @param {string} text */
  function words(text) {
    return text.toLowerCase().replaceAll("’", "'").match(WORD) ?? [];
  }

  /**
   * Добавляет самое уверенное продолжение на свободную позицию.
   * @param {string[]} options @param {string} prefix @param {string} raw
   * @param {{ context: string[], model: NeuralModel, language: NeuralLanguage }} selected
   * @param {NeuralPurposeProfile} [profile]
   * @returns {string[]}
   */
  function append(options, prefix, raw, selected, profile = selected.model.purposeProfile) {
    if (options.length >= MAX_OPTIONS || !raw || selected.context.length < 4) return options;
    const candidates = neuralOrderedPhraseAlignment.retrieve(prefix, raw, selected)
      .filter(item => !options.some(option => option.toLowerCase() === item.text));
    if (!candidates.length) return options;
    const { context, model, language } = selected;
    const head = options[0] && words(options[0])[0];
    const suffix = context.slice(-2).join(" ");
    const directPhrases = [2, 3].filter(width => context.length >= width)
      .map(width => model.phraseEvidence(context.slice(-width).join(" ")));
    const inventory = profile?.inventory && neuralPhraseAlternativeIndex.find(profile.inventory, suffix);
    const corpusPhrases = profile?.phrases[suffix]?.[1].map(([phrase]) => phrase) ?? [];
    if (inventory) {
      for (const record of inventory.slice(inventory.indexOf("\t") + 1).split("|")) corpusPhrases.push(record.split(",")[0]);
    }
    let best;
    let score = -Infinity;
    for (const item of candidates) {
      const tokens = words(item.text);
      const [first, second] = tokens;
      const pair = first + " " + second;
      const matches = text => text?.toLowerCase().split(" ").slice(0, 2).join(" ") === pair;
      const direct = directPhrases.some(matches) || corpusPhrases.some(matches);
      const specific = model.alternativePriors &&
        neuralPhraseAlternativeIndex.lookup(model.alternativePriors, context.at(-1) + " " + first).has(second);
      const general = model.alternativePriors && neuralPhraseAlternativeIndex.lookup(model.alternativePriors, first).has(second);
      const features = [1, Math.min(10, item.score) / 3, Math.log1p(item.occurrences), Number(tokens.length === 3),
        Number(first === head), Number(direct), Number(Boolean(specific)), Number(Boolean(general))];
      const logit = weights[language].reduce((total, weight, index) => total + weight * features[index], 0);
      const probability = 1 / (1 + Math.exp(-logit));
      if (probability < THRESHOLD || probability <= score) continue;
      best = item.text;
      score = probability;
    }
    return best ? [...options, best] : options;
  }

  return { append };
})();
