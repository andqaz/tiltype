/**
 * Рисует предварительное продолжение поверх страницы рядом с кареткой Word.
 * Привязывается к доступному слою редактора, оставляя ввод и выбор за InputHelper.
 */
"use strict";

/** Проверяет в контексте Office API, свободна ли строка после позиции ввода. */
function canPreviewAtCaret() {
  const doc = Api.GetDocument();
  const range = doc.GetRangeBySelect();
  if (!range || range.GetStartPos() !== range.GetEndPos()) return false;
  const paragraph = doc.GetCurrentParagraph();
  const text = paragraph?.GetText({Numbering:false, Math:false});
  const before = doc.GetCurrentSentence("before");
  return {before:before.slice(-600), visible:typeof text === "string" && !!before && !doc.GetCurrentSentence("after").trim() &&
    text.replace(/[\r\n]+$/u, "").endsWith(before)};
}

/**
 * Возвращает контроллер просмотра, если редактор предоставляет слой курсора.
 * @param {() => void} dismiss Сбрасывает также выбор при уходе с позиции ввода.
 */
function createInlinePreview(dismiss) {
  const frame = /** @type {HTMLElement|null} */ (window.frameElement);
  const host = frame?.ownerDocument;
  const view = host?.defaultView;
  if (!frame || !view || !host) return undefined;
  const ghost = host.createElement("span");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText = "position:fixed;pointer-events:none;user-select:none;white-space:pre;overflow:hidden;text-overflow:ellipsis;z-index:10000;opacity:.46;";
  const events = new AbortController();
  const marker = host.createElement("i");
  marker.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;";
  const label = host.createTextNode("");
  ghost.append(marker, label);
  const metrics = host.createElement("canvas").getContext("2d");
  let before = "";
  let lastGeometry = "";
  let active = false;
  let savedClip = "";
  let animation = 0;
  /** Следим за окончательной экранной позицией: SDK обновляет каретку после события ввода. */
  function align() {
    const pos = host.getElementById("id_target_cursor")?.getBoundingClientRect();
    const canvas = /** @type {HTMLCanvasElement|null} */ (host.getElementById("id_viewer"));
    const bounds = canvas?.getBoundingClientRect();
    if (!pos || !bounds || pos.height < 3) return false;
    const left = Math.ceil(pos.right) + 1;
    const room = Math.min(bounds.right,view.innerWidth) - left;
    if (room < 18 || pos.left < bounds.left || pos.top < Math.max(0,bounds.top) ||
        pos.bottom > Math.min(bounds.bottom,view.innerHeight)) return false;
    const geometry = [left,pos.top,pos.height,room,bounds.top,bounds.left,canvas.width,canvas.height].join("/");
    if (geometry === lastGeometry) return true;
    lastGeometry = geometry;
    Object.assign(ghost.style, {left:left+"px", top:pos.top+"px", maxWidth:room+"px",
      fontSize:pos.height*0.89+"px", lineHeight:pos.height+"px"});
    if (metrics && ghost.isConnected) {
      metrics.font = [ghost.style.fontStyle,ghost.style.fontWeight,ghost.style.fontSize,ghost.style.fontFamily].join(" ");
      const fallback = marker.getBoundingClientRect().top;
      const baseline = measureInlineBaseline(canvas, pos, metrics, before, fallback);
      if (baseline !== undefined) ghost.style.top = (pos.top + baseline - fallback)+"px";
    }
    return true;
  }
  // Отрисовка SDK может завершиться позже показа списка. Пересчитываем
  // координаты при изменении геометрии каретки, а не на каждом кадре простоя.
  const moves = new MutationObserver(scheduleAlignment);
  function scheduleAlignment() {
    if (!active || animation) return;
    animation = view.requestAnimationFrame(() => {
      animation = 0;
      if (active && !align()) hide();
    });
  }
  function hide() {
    if (!active) return;
    active = false;
    moves.disconnect();
    view.cancelAnimationFrame(animation);
    animation = 0;
    ghost.remove();
    frame.style.clipPath = savedClip;
    document.body.classList.remove("tiltype-inline");
  }
  function cancel() { if (active) dismiss(); }
  host.addEventListener("pointerdown", cancel, {capture:true, signal:events.signal});
  host.addEventListener("wheel", cancel, {capture:true, passive:true, signal:events.signal});
  host.addEventListener("scroll", cancel, {capture:true, passive:true, signal:events.signal});
  view.addEventListener("resize", cancel, {signal:events.signal});
  view.addEventListener("pagehide", hide, {signal:events.signal});
  window.addEventListener("pagehide", () => { hide(); events.abort(); }, {once:true});
  /** @param {string} suffix @param {boolean} single @param {boolean} dark @param {string} typed */
  function show(suffix, single, dark, typed = "") {
    const cursor = host.getElementById("id_target_cursor");
    if (!suffix || !cursor) {
      hide();
      return false;
    }
    if (!active) {
      savedClip = frame.style.clipPath;
      moves.observe(cursor, {attributes:true, attributeFilter:["style","class"]});
    }
    active = true;
    scheduleAlignment();
    document.body.classList.add("tiltype-inline");
    frame.style.clipPath = single ? "inset(50%)" : savedClip;
    const editor = Reflect.get(view, "editor") || Reflect.get(view, "Asc")?.editor;
    const props = editor?.get_TextProps?.()?.get_TextPr?.();
    label.data = suffix;
    before = typed;
    Object.assign(ghost.style, {
      fontFamily:props?.get_FontFamily?.()?.get_Name?.() || "serif", 
      fontWeight:props?.get_Bold?.() ? "bold" : "normal", fontStyle:props?.get_Italic?.() ? "italic" : "normal",
      color:view.getComputedStyle(cursor).backgroundColor});
    if (!ghost.style.color || ghost.style.color === "rgba(0, 0, 0, 0)") ghost.style.color = dark ? "#dddddd" : "#555555";
    if (!ghost.isConnected) host.body.append(ghost);
    lastGeometry = "";
    if (!align()) { hide(); return false; }
    // После показа SDK ещё может перерисовать буквы при той же позиции каретки.
    lastGeometry = "";
    return true;
  }
  return {show, hide, close() { hide(); events.abort(); }};
}
