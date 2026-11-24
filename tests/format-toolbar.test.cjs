/**
 * Проверяет настройки панели в старом профиле и защиту от правки чужого выделения.
 * Использует те же сериализуемые команды, что и фоновый плагин.
 */
"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const vm = require("node:vm");
const script = name => readFileSync(join(__dirname,"../plugin/scripts",name), "utf8");

test("Переключатель панели сохраняется и мигрирует из старых настроек", () => {
  let value = JSON.stringify({spelling:false,layout:false,language:"auto"});
  const ctx=vm.createContext({localStorage:{getItem:()=>value,setItem:(_key,v)=>{value=v;}}});
  vm.runInContext(script("settings.js"),ctx);
  assert.equal(vm.runInContext("correctionSettings.read().formatToolbar",ctx),true);
  vm.runInContext("correctionSettings.save({...correctionSettings.read(),formatToolbar:false})",ctx);
  assert.equal(vm.runInContext("correctionSettings.read().formatToolbar",ctx),false);
});

test("Форматирование применяется повторно только к тому же выделению", () => {
  let text="слово", bold=false, size=22;
  const paragraph={GetInternalId:()=>"p",GetParaPr:()=>({GetJc:()=>"left"})};
  const range={
    GetStartPos:()=>3,GetEndPos:()=>8,GetAllParagraphs:()=>[paragraph],GetText:()=>text,
    GetTextPr:()=>({GetBold:()=>bold,GetItalic:()=>false,GetUnderline:()=>false,GetFontSize:()=>size,
      GetColor:()=>null,GetHighlight:()=>"none",GetFontFamily:slot=>slot==="hAnsi"?"Georgia":"Arial"}),
    SetBold:v=>{bold=v;},SetFontSize:v=>{size=v;},
  };
  const ctx=vm.createContext({Asc:{scope:{}},Api:{GetDocument:()=>({GetRangeBySelect:()=>range})}});
  vm.runInContext(script("format-selection.js"),ctx);
  const run=(action,key,value)=>{ctx.Asc.scope.tiltypeFormat={action,key,value};return vm.runInContext("formatSelection()",ctx);};
  const selected=run("read");
  assert.equal(selected.font,"Georgia");
  assert.equal(run("bold",selected.key).bold,true);
  assert.equal(run("size",selected.key,"12.5").size,12.5);
  text="друго";
  assert.equal(run("bold",selected.key),null);
  assert.equal(bold,true);
});
