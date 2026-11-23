/**
 * Проверяет локальные правила пунктуации и точность разметки диапазонов Office API.
 * Моделирует служебную позицию между оформленными фрагментами текста.
 */
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
const run = (source) => vm.runInContext(source, context);
for (const name of ["punctuation", "proofing-document"]) {
  run(readFileSync(resolve(__dirname, "../plugin/scripts", name + ".js"), "utf8"));
}
const find = run("findPunctuationFixes");

test("Пунктуация предлагает точечные правки и сохраняет адреса, числа и двусмысленные обороты", () => {
  const text = "😀 Привет ,мир! Я ушёл потому что поздно. Hello,, world. Қазақша мәтін , жақсы. Hi,there! www.example.com/a,b 3,14 12:30";
  const chars = Array.from(text);
  const fixes = Array.from(find(text));
  assert.deepEqual(fixes.map(({ rule }) => rule), ["spacing", "because", "repeated", "before", "after"]);
  assert.equal(fixes[0].replacement, ", ");
  for (const fix of fixes) assert.equal(chars.slice(fix.start, fix.end).join(""), fix.original);
  assert.equal(find("Я пришёл не потому что хотел. Это я потому что я так решил.").length, 1);
  assert.equal(find("Hello, world. Қазақша мәтін. mail@example.com:port").length, 0);
});

test("Office API сопоставляет видимый текст через служебные границы и отвергает устаревшие правки", () => {
  let editorPositions = ["a", "", "b", ",", "п", "р", "и", "в", "е", "т"];
  let selection;
  let caret = editorPositions.length;
  const languages = [];
  const paragraph = {
    GetInternalId: () => "paragraph",
    GetText: () => editorPositions.join(""),
    GetRange(start = 0, end = editorPositions.length) {
      if (end > editorPositions.length) return null;
      const text = editorPositions.slice(start, end).join("");
      return {
        GetStartPos: () => start,
        GetEndPos: () => end,
        GetText: () => text,
        GetTextPr: () => ({ GetLanguage: () => null }),
        SetLanguage: (locale) => { languages.push([text, locale]); },
        Select: () => { selection = [start, end]; return true; },
      };
    },
  };
  context.Api = {
    GetDocument: () => ({
      GetCurrentParagraph: () => paragraph,
      GetRangeBySelect: () => ({ GetStartPos: () => caret, GetEndPos: () => caret }),
      RemoveSelection: () => { selection = null; },
    }),
    ReplaceTextSmart: ([replacement]) => {
      editorPositions.splice(selection[0], selection[1] - selection[0], replacement);
      return true;
    },
  };
  const snapshot = { id: "paragraph", text: "ab,привет", caret: 3 };
  context.Asc = { scope: { autocompleteProofingEdit: { snapshot, spans: [
    { start: 0, end: 2, locale: "en-US" }, { start: 3, end: 9, locale: "ru-RU" },
  ] } } };
  const apply = run("applyProofingEdit");
  assert.equal(apply(), true);
  assert.deepEqual(languages, [["ab", "en-US"], ["привет", "ru-RU"]]);
  context.Asc.scope.autocompleteProofingEdit = { snapshot, fix: find(snapshot.text)[0] };
  assert.equal(apply(), true);
  assert.equal(paragraph.GetText(), "ab, привет");
  assert.equal(apply(), false);

  editorPositions = ["H", "e", "l", "l", "o", "", " "];
  caret = 5;
  context.Asc.scope.autocompleteProofingEdit = {
    snapshot: { id: "paragraph", text: "Hello ", caret: 6 },
    fix: { start: 0, end: 6, original: "Hello ", replacement: "Руддщ " },
    atCaret: true,
  };
  assert.equal(apply(), false);
  caret = editorPositions.length;
  assert.equal(apply(), true);
  assert.equal(paragraph.GetText(), "Руддщ ");
});
