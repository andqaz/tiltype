/**
 * Синхронизирует форму настроек с фоновым плагином через события окон SDK.
 * Обновляет документ только через отправку настроек, без доступа к его содержимому.
 */
"use strict";

(() => {
  const plugin = Reflect.get(window, "Asc").plugin;
  const form = /** @type {HTMLFormElement} */ (document.getElementById("preferences"));
  const formatToolbar = /** @type {HTMLInputElement} */ (document.getElementById("format-toolbar"));
  const spelling = /** @type {HTMLInputElement} */ (document.getElementById("spelling"));
  const layout = /** @type {HTMLInputElement} */ (document.getElementById("layout"));
  const proofing = /** @type {HTMLInputElement} */ (document.getElementById("proofing"));
  const punctuation = /** @type {HTMLInputElement} */ (document.getElementById("punctuation"));
  const spaceAfterTab = /** @type {HTMLInputElement} */ (document.getElementById("space-after-tab"));
  const tabMode = /** @type {HTMLSelectElement} */ (document.getElementById("tab-mode"));
  const nextWord = /** @type {HTMLInputElement} */ (document.getElementById("next-word"));
  const predictionMode = /** @type {HTMLSelectElement} */ (document.getElementById("prediction-mode"));
  const predictionHistory = /** @type {HTMLInputElement} */ (document.getElementById("prediction-history"));
  const learning = /** @type {HTMLSelectElement} */ (document.getElementById("learning"));
  const language = /** @type {HTMLSelectElement} */ (document.getElementById("language"));
  const errorMessage = /** @type {HTMLElement} */ (document.getElementById("error"));

  // Высоту определяет сама форма. Размер iframe уже зависит от ответа редактора.
  let lastHeight = 0;
  function reportHeight() {
    if (form.hidden) return;
    const height = Math.ceil(form.getBoundingClientRect().height);
    if (height === lastHeight || height < 1) return;
    lastHeight = height;
    plugin.sendToPlugin("preferencesHeight", height);
  }

  const layoutObserver = new ResizeObserver(reportHeight);
  layoutObserver.observe(form);
  function syncPredictionInputs() {
    tabMode.disabled = !nextWord.checked;
    predictionMode.disabled = !nextWord.checked;
    predictionHistory.disabled = !nextWord.checked || !["phrases", "gru"].includes(predictionMode.value);
  }

  nextWord.addEventListener("change", syncPredictionInputs);
  predictionMode.addEventListener("change", syncPredictionInputs);
  plugin.init = () => {
    plugin.attachEvent("preferencesData", (/** @type {{ options: CorrectionSettings, language: DictionaryLanguage }} */ data) => {
      const labels = settingsLabels[data.language];
      document.documentElement.lang = data.language;
      for (const element of document.querySelectorAll("[data-text]")) {
        const key = /** @type {keyof typeof labels} */ (element.getAttribute("data-text"));
        element.textContent = labels[key];
      }
      formatToolbar.checked = data.options.formatToolbar;
      spelling.checked = data.options.spelling;
      layout.checked = data.options.layout;
      proofing.checked = data.options.proofing;
      punctuation.checked = data.options.punctuation;
      spaceAfterTab.checked = data.options.spaceAfterTab;
      tabMode.value = data.options.tabByWord ? "word" : "phrase";
      nextWord.checked = data.options.nextWord;
      predictionMode.value = data.options.predictionMode;
      predictionHistory.checked = data.options.predictionHistory;
      syncPredictionInputs();
      learning.value = data.options.personalLearning ?? "document";
      language.value = data.options.language;
      form.hidden = false;
      reportHeight();
    });
    plugin.attachEvent("preferencesError", () => { errorMessage.hidden = false; });
    plugin.sendToPlugin("preferencesReady", {});
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    errorMessage.hidden = true;
    plugin.sendToPlugin("preferencesSave", {
      formatToolbar: formatToolbar.checked,
      spelling: spelling.checked,
      layout: layout.checked,
      proofing: proofing.checked,
      punctuation: punctuation.checked,
      spaceAfterTab: spaceAfterTab.checked,
      tabByWord: tabMode.value === "word",
      nextWord: nextWord.checked,
      predictionMode: predictionMode.value,
      predictionHistory: predictionHistory.checked,
      personalLearning: learning.value,
      language: language.value,
    });
  });
  document.getElementById("cancel")?.addEventListener("click", () => {
    plugin.sendToPlugin("preferencesCancel", {});
  });
})();
