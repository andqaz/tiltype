/**
 * Команды Office API для работы со словом у курсора.
 * Используются при сбросе буфера и закрытии списка подсказок ONLYOFFICE.
 */
"use strict";

/**
 * Возвращает слово при редактировании его конца.
 * Передаётся в редактор через callCommand и использует глобальный Office API.
 * @returns {string} Буквы слева от курсора или пустая строка.
 */
function readCaretPrefix() {
  const editor = typeof Api.GetDocument === "function" ? Api.GetDocument() : Api.GetPresentation?.();
  if (!editor || typeof editor.GetCurrentWord !== "function" || editor.GetCurrentWord("after")) return "";
  return editor.GetCurrentWord("before") || "";
}

/**
 * Возвращает редактору обычное действие Enter, когда SDK передал клавишу списку.
 * Повторная проверка префикса предотвращает вставку после перемещения курсора.
 * @returns {boolean} Редактор добавил абзац.
 */
function insertParagraphAtCompletion() {
  const document = Api.GetDocument();
  const range = document.GetRangeBySelect();
  if (!range || range.GetStartPos() !== range.GetEndPos() ||
      document.GetCurrentWord("before") !== Asc.scope?.tiltypeCompletionPrefix) return false;
  return document.InsertParagraphBreak();
}
