/**
 * Хранит настройки автокоррекции в профиле редактора.
 * Проверяет данные перед использованием и задаёт подписи для окна настроек.
 */
"use strict";

/** @typedef {"dictionary" | "word" | "phrases" | "gru"} PredictionMode */
/** @typedef {{ personalLearning?: string, formatToolbar: boolean, spelling: boolean, layout: boolean, proofing: boolean, punctuation: boolean, spaceAfterTab: boolean, nextWord: boolean, predictionMode: PredictionMode, predictionHistory: boolean, language: DictionaryLanguage | "auto" }} CorrectionSettings */

const correctionSettings = (() => {
  const storageKey = "autocomplete-ru-kk-en.corrections";
  /** @type {CorrectionSettings} */
  let current = { personalLearning: "document", formatToolbar: true, spelling: false, layout: false, proofing: true, punctuation: true, spaceAfterTab: false,
    nextWord: true, predictionMode: "phrases", predictionHistory: true, language: "auto" };

  /**
   * Проверяет настройки при чтении из хранилища или получении из окна.
   * @param {unknown} value Данные профиля или формы.
   * @returns {CorrectionSettings | null} Допустимые настройки или null.
   */
  function parse(value) {
    if (typeof value !== "object" || value === null) return null;
    if (!("spelling" in value && "layout" in value && "language" in value)) return null;
    const { spelling, layout, language } = value;
    if (typeof spelling !== "boolean" || typeof layout !== "boolean") return null;
    if (language !== "auto" && language !== "ru" && language !== "kk" && language !== "en") return null;
    const proofing = !("proofing" in value) || value.proofing === true;
    const punctuation = !("punctuation" in value) || value.punctuation === true;
    const spaceAfterTab = "spaceAfterTab" in value ? value.spaceAfterTab === true :
      "spaceAfterEnter" in value && value.spaceAfterEnter === true;
    const nextWord = "nextWord" in value && value.nextWord === true;
    const mode = "predictionMode" in value ? value.predictionMode : "phrases";
    const predictionMode = mode === "word" || mode === "dictionary" || mode === "gru" ? mode : "phrases";
    const predictionHistory = !("predictionHistory" in value) || value.predictionHistory === true;
    const formatToolbar = !("formatToolbar" in value) || value.formatToolbar === true;
    const personalLearning = "personalLearning" in value && (value.personalLearning === "off" || value.personalLearning === "profile") ? value.personalLearning : "document";
    return { personalLearning, formatToolbar, spelling, layout, language, proofing, punctuation, spaceAfterTab, nextWord, predictionMode, predictionHistory };
  }

  /** Возвращает текущие настройки профиля редактора. */
  function read() {
    try {
      const text = localStorage.getItem(storageKey);
      if (text) current = parse(JSON.parse(text)) ?? current;
    } catch (error) {
      console.warn("Autocomplete: unable to read preferences", error);
    }
    if (typeof document !== "undefined" && document.documentElement?.dataset?.writer === "shared") {
      return { ...current, spelling: false, layout: false, proofing: false, predictionMode: "phrases", personalLearning: "off" };
    }
    return current;
  }

  /**
   * Сохраняет настройки для всех документов профиля.
   * @param {CorrectionSettings} settings Проверенные данные формы.
   * @throws При недоступности хранилища редактора.
   */
  function save(settings) {
    localStorage.setItem(storageKey, JSON.stringify(settings));
    current = settings;
  }

  return { parse, read, save };
})();

const settingsLabels = {
  en: {
    learning: "Learn from typing and accepted suggestions",
    learningOff: "Off",
    learningDocument: "In this document",
    learningProfile: "On this computer",

    title: "TilType AI settings",
    formatToolbar: "Show the formatting toolbar when text is selected",
    spelling: "Correct common spelling mistakes",
    layout: "Correct text typed in the wrong layout (RU ↔ EN)",
    proofing: "Detect the spell-check language for each part of the text",
    punctuation: "Suggest punctuation corrections in the context menu",
    spaceAfterTab: "Add a space after accepting a suggestion with Tab",
    nextWord: "Suggest continuations after a space. Press Tab to insert.",
    predictionMode: "Prediction engine",
    predictionDictionary: "Dictionary",
    predictionWord: "AI · Next word",
    predictionPhrases: "AI · Phrases",
    predictionGru: "AI · Phrases with GRU (experimental)",
    predictionHistory: "Use earlier text in the document for phrase suggestions",
    language: "Preferred language for corrections",
    auto: "Automatic",
    detail: "Corrections apply in text documents after a space. The system keyboard layout stays the same.",
    save: "Save",
    cancel: "Cancel",
    error: "Could not save settings.",
  },
  ru: {
    learning: "Обучение по набору и выбору подсказок",
    learningOff: "Выключено",
    learningDocument: "В этом документе",
    learningProfile: "На этом компьютере",

    title: "Настройки TilType AI",
    formatToolbar: "Показывать панель форматирования при выделении текста",
    spelling: "Исправлять частые опечатки",
    layout: "Исправлять набор в неверной раскладке (RU ↔ EN)",
    proofing: "Определять язык проверки для фрагментов текста",
    punctuation: "Предлагать исправления пунктуации в контекстном меню",
    spaceAfterTab: "Ставить пробел после вставки подсказки клавишей Tab",
    nextWord: "Предлагать продолжения после пробела. Вставка по Tab.",
    predictionMode: "Движок подсказок",
    predictionDictionary: "Словарь",
    predictionWord: "ИИ · Следующее слово",
    predictionPhrases: "ИИ · Фразы",
    predictionGru: "ИИ · Фразы с GRU (экспериментально)",
    predictionHistory: "Учитывать предыдущий текст документа при прогнозе фраз",
    language: "Предпочтительный язык исправлений",
    auto: "Автоматически",
    detail: "Исправления работают в текстовых документах после пробела. Раскладка клавиатуры Windows остаётся прежней.",
    save: "Сохранить",
    cancel: "Отмена",
    error: "Не удалось сохранить настройки.",
  },
  kk: {
    learning: "Терілген мәтін мен таңдалған ұсыныстардан үйрену",
    learningOff: "Өшірулі",
    learningDocument: "Осы құжатта",
    learningProfile: "Осы компьютерде",

    title: "TilType AI баптаулары",
    formatToolbar: "Мәтін таңдалғанда пішімдеу тақтасын көрсету",
    spelling: "Жиі кездесетін теру қателерін түзету",
    layout: "Қате пернетақта жаймасымен терілген мәтінді түзету (RU ↔ EN)",
    proofing: "Мәтін бөліктерінің емле тексеру тілін анықтау",
    punctuation: "Мәтінмәндік мәзірде тыныс белгілерін түзетуді ұсыну",
    spaceAfterTab: "Ұсынысты Tab пернесімен енгізгеннен кейін бос орын қосу",
    nextWord: "Бос орыннан кейін жалғасын ұсыну. Tab пернесімен енгізу.",
    predictionMode: "Ұсыныс қозғалтқышы",
    predictionDictionary: "Сөздік",
    predictionWord: "ЖИ · Келесі сөз",
    predictionPhrases: "ЖИ · Тіркестер",
    predictionGru: "ЖИ · GRU тіркестері (сынақ)",
    predictionHistory: "Тіркес ұсынғанда құжаттың алдыңғы мәтінін ескеру",
    language: "Түзетуге арналған тіл",
    auto: "Автоматты түрде",
    detail: "Түзету мәтіндік құжаттарда бос орыннан кейін орындалады. Жүйелік пернетақта жаймасы өзгермейді.",
    save: "Сақтау",
    cancel: "Болдырмау",
    error: "Баптауларды сақтау мүмкін болмады.",
  },
};

/**
 * Определяет язык подписей по локали интерфейса ONLYOFFICE.
 * @param {string | undefined} locale Код локали редактора.
 * @returns {DictionaryLanguage} Поддерживаемый язык интерфейса.
 */
function getSettingsLanguage(locale) {
  const language = locale?.split("-")[0].toLowerCase();
  return language === "ru" || language === "kk" ? language : "en";
}
