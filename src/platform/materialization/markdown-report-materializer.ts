function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/gu, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/gu, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/gu, "<em>$1</em>");
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u.test(line);
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  let inCodeBlock = false;
  let listTag: "ul" | "ol" | null = null;
  const paragraphBuffer: string[] = [];
  let lineIndex = 0;

  const flushParagraph = () => {
    if (paragraphBuffer.length === 0) {
      return;
    }
    html.push(`<p>${paragraphBuffer.map((line) => renderInlineMarkdown(line)).join("<br />")}</p>`);
    paragraphBuffer.length = 0;
  };

  const closeList = () => {
    if (!listTag) {
      return;
    }
    html.push(`</${listTag}>`);
    listTag = null;
  };

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    if (line.trimStart().startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCodeBlock) {
        html.push("</code></pre>");
        inCodeBlock = false;
      } else {
        html.push("<pre><code>");
        inCodeBlock = true;
      }
      lineIndex += 1;
      continue;
    }

    if (inCodeBlock) {
      html.push(`${escapeHtml(line)}\n`);
      lineIndex += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${String(level)}>${renderInlineMarkdown(heading[2] ?? "")}</h${String(level)}>`);
      lineIndex += 1;
      continue;
    }

    const nextLine = lines[lineIndex + 1] ?? "";
    if (line.includes("|") && isTableDivider(nextLine)) {
      flushParagraph();
      closeList();
      const headerCells = parseTableRow(line);
      const bodyRows: string[][] = [];
      lineIndex += 2;
      while (lineIndex < lines.length) {
        const tableLine = lines[lineIndex] ?? "";
        if (!tableLine.trim() || !tableLine.includes("|")) {
          break;
        }
        bodyRows.push(parseTableRow(tableLine));
        lineIndex += 1;
      }
      html.push("<table>");
      html.push("<thead><tr>");
      for (const cell of headerCells) {
        html.push(`<th>${renderInlineMarkdown(cell)}</th>`);
      }
      html.push("</tr></thead>");
      if (bodyRows.length > 0) {
        html.push("<tbody>");
        for (const row of bodyRows) {
          html.push("<tr>");
          for (const cell of row) {
            html.push(`<td>${renderInlineMarkdown(cell)}</td>`);
          }
          html.push("</tr>");
        }
        html.push("</tbody>");
      }
      html.push("</table>");
      continue;
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/u.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr />");
      lineIndex += 1;
      continue;
    }

    const blockquote = /^>\s?(.*)$/u.exec(line);
    if (blockquote) {
      flushParagraph();
      closeList();
      const quoteLines: string[] = [];
      while (lineIndex < lines.length) {
        const quoteLine = /^>\s?(.*)$/u.exec(lines[lineIndex] ?? "");
        if (!quoteLine) {
          break;
        }
        quoteLines.push(quoteLine[1] ?? "");
        lineIndex += 1;
      }
      const paragraphs = quoteLines.join("\n").split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
      html.push("<blockquote>");
      for (const part of paragraphs) {
        html.push(`<p>${part.split("\n").map((segment) => renderInlineMarkdown(segment.trim())).join("<br />")}</p>`);
      }
      html.push("</blockquote>");
      continue;
    }

    const unorderedListItem = /^[-*]\s+(.+)$/u.exec(line);
    if (unorderedListItem) {
      flushParagraph();
      if (listTag !== "ul") {
        closeList();
        html.push("<ul>");
        listTag = "ul";
      }
      html.push(`<li>${renderInlineMarkdown(unorderedListItem[1] ?? "")}</li>`);
      lineIndex += 1;
      continue;
    }

    const orderedListItem = /^\d+\.\s+(.+)$/u.exec(line);
    if (orderedListItem) {
      flushParagraph();
      if (listTag !== "ol") {
        closeList();
        html.push("<ol>");
        listTag = "ol";
      }
      html.push(`<li>${renderInlineMarkdown(orderedListItem[1] ?? "")}</li>`);
      lineIndex += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      lineIndex += 1;
      continue;
    }

    paragraphBuffer.push(line.trim());
    lineIndex += 1;
  }

  flushParagraph();
  closeList();

  if (inCodeBlock) {
    html.push("</code></pre>");
  }

  return html.join("\n");
}

export { escapeHtml };
