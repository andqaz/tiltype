/**
 * Показывает цвета маркера возле его кнопки в пределах мини-панели.
 * Передаёт контроллеру значение Office API, поддерживает мышь и клавиатуру.
 */
"use strict";

/** @param {HTMLButtonElement} trigger @param {HTMLElement} bar
 * @param {string[]} labels Названия цветов для подсказок и озвучивания.
 * @param {(shade:string)=>void} select Применяет цвет к текущему выделению.
 */
function createHighlightPalette(trigger, bar, labels, select) {
  const shades = ["yellow", "green", "cyan", "magenta", "red", "none"];
  const palette = document.createElement("div");
  palette.className = "format-highlight-palette";
  palette.id = "tiltype-marker-colors";
  palette.hidden = true;
  palette.setAttribute("role", "menu");
  palette.setAttribute("aria-label", trigger.title);
  bar.append(palette);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-controls", palette.id);
  trigger.setAttribute("aria-expanded", "false");

  function close() {
    palette.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  const buttons = shades.map((shade, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.dataset.shade = shade;
    button.title = labels[index];
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-label", labels[index]);
    if (shade !== "none") button.style.setProperty("--chip", shade);
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => { close(); trigger.focus(); select(shade); };
    palette.append(button);
    return button;
  });

  trigger.onclick = () => {
    if (!palette.hidden) { close(); return; }
    palette.hidden = false;
    const left = trigger.getBoundingClientRect().right - bar.getBoundingClientRect().left;
    palette.style.left = Math.max(1, Math.min(left - palette.offsetWidth, bar.clientWidth - palette.offsetWidth)) + "px";
    trigger.setAttribute("aria-expanded", "true");
    (buttons.find(b => b.getAttribute("aria-checked") === "true") || buttons[0]).focus({preventScroll:true});
  };
  palette.onkeydown = event => {
    const i = buttons.findIndex(b => b === document.activeElement);
    if (event.key === "Escape") { close(); trigger.focus(); }
    else if (event.key === "ArrowRight") buttons[(i + 1) % buttons.length].focus();
    else if (event.key === "ArrowLeft") buttons[(i + buttons.length - 1) % buttons.length].focus();
    else return;
    event.stopPropagation();
    event.preventDefault();
  };
  palette.addEventListener("focusout", event => {
    if (!(event.relatedTarget instanceof Node) || !palette.contains(event.relatedTarget)) close();
  });
  bar.addEventListener("pointerdown", event => {
    if (event.target instanceof Node && !trigger.contains(event.target) && !palette.contains(event.target)) close();
  });
  return { close,
    /** @param {string|undefined} shade Цвет фактического выделения. */
    update(shade) {
      trigger.style.setProperty("--swatch", shade && shades.includes(shade) && shade !== "none" ? shade : "#ffe044");
      buttons.forEach((b, i) => b.setAttribute("aria-checked", String(shades[i] === shade)));
    }
  };
}
