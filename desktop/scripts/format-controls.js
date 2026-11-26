/**
 * Создаёт элементы мини-панели в окне подсказок SDK.
 * Переводит подписи и передаёт контроллеру действия без доступа к документу.
 */
"use strict";

/** @param {DictionaryLanguage} lang @param {(action:string,value?:string)=>void} act
 * @param {(callback:(names:string[])=>void)=>void} loadFonts @param {(open:boolean)=>void} resizeFonts */
function createFormatControls(lang, act, loadFonts, resizeFonts) {
  const labels = {
    ru: ["Форматирование","Шрифт","Размер","Увеличить размер","Уменьшить размер","Полужирный","Курсив","Подчёркивание","Цвет текста","Маркер","Жёлтый","Зелёный","Бирюзовый","Пурпурный","Красный","Без выделения","Выравнивание","По левому краю","По центру","По правому краю","По ширине","Маркированный список","Нумерованный список","Убрать список","Уменьшить отступ","Увеличить отступ","Формат по образцу: нажмите и выделите другой текст"],
    kk: ["Пішімдеу","Қаріп","Өлшем","Үлкейту","Кішірейту","Қалың","Көлбеу","Астын сызу","Мәтін түсі","Маркер","Сары","Жасыл","Көгілдір","Күлгін","Қызыл","Түссіз","Туралау","Сол жаққа","Ортаға","Оң жаққа","Ені бойынша","Таңбалы тізім","Нөмірлі тізім","Тізімді алып тастау","Шегіністі азайту","Шегіністі ұлғайту","Пішімді көшіру: басып, басқа мәтінді таңдаңыз"],
    en: ["Formatting","Font","Size","Grow font","Shrink font","Bold","Italic","Underline","Font color","Highlight","Yellow","Green","Cyan","Magenta","Red","No highlight","Alignment","Left","Center","Right","Justify","Bullets","Numbering","Remove list","Decrease indent","Increase indent","Format painter: click and select other text"],
  }[lang];
  const bar = document.createElement("div");
  bar.className = "tiltype-format";
  bar.hidden = true;
  bar.setAttribute("role","toolbar");
  bar.setAttribute("aria-label",labels[0]);
  function row() {
    const el = document.createElement("div");
    el.className = "format-row";
    bar.append(el);
    return el;
  }
  const top = row(), bottom = row();
  /** @param {HTMLElement} parent */
  function group(parent) {
    const el = document.createElement("div");
    el.className = "format-group";
    parent.append(el);
    return el;
  }
  /** @param {HTMLElement} el @param {string} action @param {number} label */
  function labelControl(el, action, label) {
    el.dataset.action = action;
    el.title = labels[label];
    el.setAttribute("aria-label", labels[label]);
  }
  /** @param {string} name */
  function icon(name) {
    const glyph = document.createElement("span");
    glyph.className = "format-icon";
    glyph.dataset.icon = name;
    glyph.setAttribute("aria-hidden", "true");
    return glyph;
  }
  /** @param {HTMLElement} parent @param {string} action @param {number} label @param {string} [value] */
  function button(parent, action, label, value) {
    const el = document.createElement("button");
    labelControl(el, action, label);
    if (value) el.dataset.value = value;
    el.append(icon(value || action));
    el.onmousedown = event => event.preventDefault();
    el.onclick = () => act(action, value);
    parent.append(el);
    return el;
  }
  const fields = group(top);
  const font = createFormatFontPicker(fields,bar,labels[1],loadFonts,resizeFonts,name=>act("font",name));
  const size = document.createElement("input");
  size.type = "number"; size.min = "1"; size.max = "1638"; size.step = "0.5";
  size.onchange = () => { if (size.value && size.validity.valid) act("size", size.value); };
  labelControl(size, "size", 2);
  fields.append(size);
  const sizing = group(top);
  button(sizing, "larger", 3); button(sizing, "smaller", 4);
  const colors = group(top);
  /** @param {HTMLSelectElement|HTMLInputElement} field @param {string} action @param {number} label */
  function picker(field, action, label) {
    const wrap = document.createElement("label");
    wrap.className = "format-picker";
    wrap.title = labels[label];
    labelControl(field, action, label);
    wrap.append(icon(action), icon("down"), field);
    colors.append(wrap);
    return wrap;
  }
  const marker = document.createElement("button");
  marker.type = "button";
  marker.className = "format-picker format-marker";
  labelControl(marker, "highlight", 9);
  marker.append(icon("highlight"), icon("down"));
  marker.onmousedown = event => event.preventDefault();
  colors.append(marker);
  const palette = createHighlightPalette(marker, bar, labels.slice(10,16), shade => act("highlight", shade));
  const color = document.createElement("input"); color.type = "color";
  color.onchange = () => act("color", color.value);
  const ink = picker(color, "color", 8);
  button(group(top), "copy", 26);
  const styles = group(bottom);
  button(styles, "bold", 5); button(styles, "italic", 6); button(styles, "underline", 7);
  const alignment = group(bottom);
  for (const [i,value] of ["left","center","right","both"].entries()) button(alignment, "align", 17+i, value);
  const lists = group(bottom);
  button(lists, "bullets", 21); button(lists, "numbers", 22); button(lists, "unlist", 23);
  const indentation = group(bottom);
  button(indentation, "outdent", 24); button(indentation, "indent", 25);
  document.body.append(bar);
  return {bar, closeMenus() { font.close(); palette.close(); },
    /** @param {FormatState} state @param {boolean} painting */
    update(state, painting) {
      color.value = state.color || "#000000";
      ink.style.setProperty("--swatch", color.value);
      palette.update(state.highlight);
      font.setValue(state.font || ""); size.value = String(state.size || "");
      for (const el of alignment.querySelectorAll("button")) el.setAttribute("aria-pressed", String(state.align === el.dataset.value));
      for (const name of /** @type {const} */ (["bold","italic","underline","copy"])) {
        const active = name === "copy" ? painting : state[name];
        bar.querySelector('[data-action="'+name+'"]')?.setAttribute("aria-pressed", typeof active === "boolean" ? String(active) : "mixed");
      }
    }
  };
}
