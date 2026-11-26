/**
 * Раскрывает каталог шрифтов внутри iframe TilType. Семейства загружаются через
 * редактор при первом открытии, без передачи путей к файлам в разметку.
 */
"use strict";

/** @param {HTMLElement} parent @param {HTMLElement} bar @param {string} label
 * @param {(callback:(names:string[])=>void)=>void} load
 * @param {(open:boolean)=>void} resize @param {(name:string)=>void} choose */
function createFormatFontPicker(parent, bar, label, load, resize, choose) {
  const field = document.createElement("div");
  field.className = "format-font-field";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 128;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.dataset.action = "font";
  input.placeholder = "—";
  input.setAttribute("role","combobox");
  input.setAttribute("aria-label",label);
  input.setAttribute("aria-autocomplete","list");
  input.setAttribute("aria-expanded","false");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.tabIndex = -1;
  toggle.title = label;
  toggle.setAttribute("aria-label",label);
  const arrow = document.createElement("span");
  arrow.className = "format-icon";
  arrow.dataset.icon = "down";
  arrow.setAttribute("aria-hidden","true");
  toggle.append(arrow);
  const list = document.createElement("div");
  list.id = "tiltype-font-options";
  list.className = "format-font-menu";
  list.hidden = true;
  list.setAttribute("role","listbox");
  input.setAttribute("aria-controls",list.id);
  field.append(input,toggle,list);
  parent.append(field);

  /** @type {string[]} */
  let names = [], visible = [];
  let selected = "", cursor = 0, pending = false;
  let query = "";
  function mark() {
    for (const item of list.children) item.classList.toggle("font-cursor",item.id === "tiltype-font-" + cursor);
    const active = list.children[cursor];
    if (active) {
      input.setAttribute("aria-activedescendant",active.id);
      active.scrollIntoView({block:"nearest"});
    } else input.removeAttribute("aria-activedescendant");
  }
  function filter() {

    visible = [...new Set([selected,...names])].filter(n=>n && n.toLocaleLowerCase().includes(query));
    const exact = visible.findIndex(name => name.toLocaleLowerCase() === query);
    cursor = query ? Math.max(0,exact) : Math.max(0,visible.indexOf(selected));
    list.replaceChildren();
    for (const [i,name] of visible.entries()) {
      const item = document.createElement("div");
      item.textContent = name; item.id = "tiltype-font-" + i; item.setAttribute("role","option");
      item.dataset.font = name;
      item.style.fontFamily = CSS.escape(name) + ', "Segoe UI", sans-serif';
      item.setAttribute("aria-selected",String(name === selected));
      list.append(item);
    }
    mark();
  }
  function close() {
    if (list.hidden) return;
    list.hidden = true;
    input.value = selected;
    input.setAttribute("aria-expanded","false");
    input.removeAttribute("aria-activedescendant");
    bar.classList.remove("font-menu-open");
    resize(false);
  }
  /** @param {string} name */
  function commit(name) {
    if (!name || name.length > 128) return;
    close();
    choose(name);
  }
  function open() {
    if (!list.hidden) return;
    query = "";
    list.hidden = false;
    bar.classList.add("font-menu-open");
    input.setAttribute("aria-expanded","true");
    resize(true);
    filter();
    if (!names.length && !pending) {
      pending = true;
      load(result => {pending=false; names=result; if (!list.hidden) filter();});
    }
  }
  toggle.onmousedown = event => event.preventDefault();
  toggle.onclick = () => {
    if (!list.hidden) { close(); return; }
    input.focus({preventScroll:true});
    input.select();
    open();
  };
  input.onclick = () => {
    if (list.hidden) { open(); input.select(); }
  };
  list.onmousedown = event=>event.preventDefault();
  list.onclick = event=>{
    const item = event.target instanceof HTMLElement ? event.target.closest("[data-font]") : null;
    if (item instanceof HTMLElement && item.dataset.font) commit(item.dataset.font);
  };
  input.oninput = () => {
    open();
    query = input.value.trim().toLocaleLowerCase();
    filter();
  };
  input.onkeydown = event => {
    if (event.key === "Escape" && !list.hidden) {
      event.stopPropagation();
      close();
    } else if (event.key === "Enter") {
      commit(list.hidden ? input.value.trim() : visible[cursor] || input.value.trim());
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (list.hidden) open();
      else cursor = Math.max(0,Math.min(visible.length-1,cursor+(event.key === "ArrowDown" ? 1 : -1)));
      mark();
    } else return;
    event.preventDefault();
  };
  input.onblur = close;
  bar.addEventListener("pointerdown",event=>{
    if (event.target instanceof Node && !field.contains(event.target)) close();
  });
  return {close,
    /** @param {string} name */
    setValue(name) {
      selected = name;
      if (list.hidden) input.value = name;
      input.title = name ? label + " · " + name : label;
    }
  };
}
