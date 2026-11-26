/**
 * Читает и форматирует выделение в контексте Office API.
 * Проверяет границы и абзац непосредственно перед каждой правкой. Команда
 * сериализуется SDK, поэтому использует только локальные данные и Asc.scope.
 */
"use strict";

/** Выполняет одну команду панели и возвращает актуальные свойства выделения. */
function formatSelection() {
  const request = Asc.scope.tiltypeFormat;
  const doc = Api.GetDocument();
  const range = doc.GetRangeBySelect();
  if (!range || range.GetStartPos() === range.GetEndPos()) return null;
  const paragraph = range.GetAllParagraphs()[0];
  if (!paragraph) return null;
  const key = JSON.stringify([paragraph.GetInternalId(), range.GetStartPos(), range.GetEndPos(), range.GetText({Numbering:false, Math:false})]);
  if (request.key && request.key !== key) return null;
  const props = range.GetTextPr();
  const value = request.value;
  const size = props.GetFontSize() / 2;
  switch (request.action) {
    case "read": break;
    case "bold": range.SetBold(!props.GetBold()); break;
    case "italic": range.SetItalic(!props.GetItalic()); break;
    case "underline": range.SetUnderline(!props.GetUnderline()); break;
    case "font":
      if (typeof value !== "string" || !value.trim() || value.length > 128) return null;
      range.SetFontFamily(value.trim()); break;
    case "larger": case "smaller": case "size": {
      const points = request.action === "size" ? Number(value) : (size || 11) + (request.action === "larger" ? 1 : -1);
      if (!Number.isFinite(points) || points < 1 || points > 1638) return null;
      range.SetFontSize(Math.round(points * 2)); break;
    }
    case "color":
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) return null;
      range.SetColor(parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5), 16)); break;
    case "highlight":
      if (!["yellow","green","cyan","magenta","red","none"].includes(String(value))) return null;
      range.SetHighlight(String(value)); break;
    case "align": case "indent": case "outdent": {
      if (request.action === "align" && !["left","center","right","both"].includes(String(value))) return null;
      for (const p of range.GetAllParagraphs()) {
        const para = p.GetParaPr();
        if (request.action === "align") para.SetJc(String(value));
        else para.SetIndLeft(Math.max(0, (para.GetIndLeft() || 0) + (request.action === "indent" ? 360 : -360)));
      }
      break;
    }
    case "bullets": case "numbers": case "unlist": {
      const level = request.action === "unlist" ? null : doc.CreateNumbering(request.action === "bullets" ? "bullet" : "numbered").GetLevel(0);
      for (const p of range.GetAllParagraphs()) p.SetNumbering(level);
      break;
    }
    case "copy": return { key, paint: props.ToJSON(false) };
    case "paint":
      if (typeof value !== "string") return null;
      range.SetTextPr(Api.FromJSON(value)); break;
    default: return null;
  }
  const current = doc.GetRangeBySelect();
  if (!current || current.GetStartPos() === current.GetEndPos()) return null;
  const updated = current.GetTextPr();
  const first = current.GetAllParagraphs()[0];
  if (!first) return null;
  const color = updated.GetColor()?.GetRGB();
  const selectedText = current.GetText({Numbering:false, Math:false});
  // Кириллица может использовать отдельное семейство hAnsi в свойствах DOCX.
  const fontSlot = /\p{Script=Cyrillic}/u.test(selectedText) ? "hAnsi" : "ascii";
  const font = updated.GetFontFamily(fontSlot) || updated.GetFontFamily();
  return {
    color: color && [color.r,color.g,color.b].every(n => Number.isInteger(n) && n >= 0 && n <= 255)
      ? "#" + [color.r,color.g,color.b].map(n => n.toString(16).padStart(2,"0")).join("") : undefined,
    key: JSON.stringify([first.GetInternalId(), current.GetStartPos(), current.GetEndPos(), selectedText]),
    highlight: updated.GetHighlight(), bold: updated.GetBold(), italic: updated.GetItalic(), underline: updated.GetUnderline(),
    font, size: updated.GetFontSize() / 2, align: first.GetParaPr().GetJc(),
  };
}
