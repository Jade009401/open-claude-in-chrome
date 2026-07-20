(() => {
  "use strict";

  const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safeLink(href) {
    const value = String(href || "").trim();
    if (!/^(https?:|mailto:)/i.test(value)) return null;
    try {
      const url = new URL(value);
      if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
      return value;
    } catch {
      return null;
    }
  }

  function copyText(text, button) {
    const original = button.textContent;
    const done = () => {
      button.textContent = "已复制";
      button.dataset.copied = "true";
      setTimeout(() => {
        button.textContent = original;
        delete button.dataset.copied;
      }, 1200);
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      return;
    }
    fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      done();
    } catch {}
    textarea.remove();
  }

  function findNextInlineToken(text, start) {
    const patterns = [
      { type: "code", regex: /`([^`\n]+)`/g },
      { type: "link", regex: /\[([^\]\n]+)\]\(([^)\s]+)\)/g },
      { type: "bold", regex: /\*\*([^*\n][\s\S]*?)\*\*/g },
      { type: "bold", regex: /__([^_\n][\s\S]*?)__/g },
      { type: "strike", regex: /~~([^~\n][\s\S]*?)~~/g },
      { type: "italic", regex: /(?<!\*)\*([^*\n]+)\*(?!\*)/g },
      { type: "italic", regex: /(?<!_)_([^_\n]+)_(?!_)/g },
    ];

    let best = null;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = start;
      const match = pattern.regex.exec(text);
      if (!match) continue;
      if (!best || match.index < best.match.index || (match.index === best.match.index && match[0].length > best.match[0].length)) {
        best = { type: pattern.type, match };
      }
    }
    return best;
  }

  function appendInline(parent, text, depth = 0) {
    const value = String(text || "");
    if (!value || depth > 4) {
      parent.appendChild(document.createTextNode(value));
      return;
    }

    let cursor = 0;
    while (cursor < value.length) {
      const token = findNextInlineToken(value, cursor);
      if (!token) {
        parent.appendChild(document.createTextNode(value.slice(cursor)));
        break;
      }
      if (token.match.index > cursor) {
        parent.appendChild(document.createTextNode(value.slice(cursor, token.match.index)));
      }

      const [raw, first, second] = token.match;
      if (token.type === "code") {
        parent.appendChild(element("code", "inline-code", first));
      } else if (token.type === "link") {
        const href = safeLink(second);
        if (href) {
          const link = element("a", "markdown-link");
          link.href = href;
          link.target = "_blank";
          link.rel = "noreferrer noopener";
          appendInline(link, first, depth + 1);
          parent.appendChild(link);
        } else {
          parent.appendChild(document.createTextNode(raw));
        }
      } else {
        const tag = token.type === "bold" ? "strong" : token.type === "italic" ? "em" : "s";
        const formatted = element(tag, `md-${token.type}`);
        appendInline(formatted, first, depth + 1);
        parent.appendChild(formatted);
      }
      cursor = token.match.index + raw.length;
    }
  }

  function isFence(line) {
    return /^\s*```/.test(line);
  }

  function isHr(line) {
    return /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
  }

  function isHeading(line) {
    return /^(#{1,6})\s+(.+)$/.exec(line);
  }

  function isQuote(line) {
    return /^\s*>\s?/.test(line);
  }

  function listMatch(line) {
    return /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
  }

  function looksLikeTableSeparator(line) {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  }

  function splitTableRow(line) {
    let value = String(line || "").trim();
    if (!value.includes("|")) return [];
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    return value.split("|").map((cell) => cell.trim());
  }

  function isBlockStart(lines, index) {
    const line = lines[index] || "";
    if (!line.trim()) return true;
    if (isFence(line) || isHeading(line) || isHr(line) || isQuote(line) || listMatch(line)) return true;
    return index + 1 < lines.length && line.includes("|") && looksLikeTableSeparator(lines[index + 1]);
  }

  function appendCodeBlock(parent, language, codeText) {
    const wrapper = element("section", "code-block");
    const header = element("div", "code-block-header");
    const languageLabel = element("span", "code-language", language || "text");
    const copyButton = element("button", "code-copy-button", "复制");
    copyButton.type = "button";
    copyButton.addEventListener("click", () => copyText(codeText, copyButton));
    header.append(languageLabel, copyButton);

    const pre = element("pre", "code-scroll");
    const code = element("code", "code-content");
    if ((language || "").toLowerCase() === "diff") {
      for (const line of String(codeText).split("\n")) {
        const row = element("span", "code-line", line || " ");
        if (line.startsWith("+") && !line.startsWith("+++")) row.classList.add("diff-add");
        else if (line.startsWith("-") && !line.startsWith("---")) row.classList.add("diff-remove");
        else if (line.startsWith("@@")) row.classList.add("diff-hunk");
        code.appendChild(row);
      }
    } else {
      code.textContent = codeText;
    }
    pre.appendChild(code);
    wrapper.append(header, pre);
    parent.appendChild(wrapper);
  }

  function appendTable(parent, headerCells, rows) {
    const scroller = element("div", "table-scroll");
    const table = element("table", "markdown-table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const cell of headerCells) {
      const th = document.createElement("th");
      appendInline(th, cell);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    for (const rowCells of rows) {
      const tr = document.createElement("tr");
      for (let i = 0; i < headerCells.length; i++) {
        const td = document.createElement("td");
        appendInline(td, rowCells[i] || "");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    scroller.appendChild(table);
    parent.appendChild(scroller);
  }

  function appendList(parent, lines, startIndex) {
    const first = listMatch(lines[startIndex]);
    const ordered = /^\d/.test(first[2]);
    const list = element(ordered ? "ol" : "ul", "markdown-list");
    let index = startIndex;

    while (index < lines.length) {
      const match = listMatch(lines[index]);
      if (!match || /^\d/.test(match[2]) !== ordered) break;
      const item = document.createElement("li");
      let content = match[3];
      const task = /^\[([ xX])\]\s+(.+)$/.exec(content);
      if (task) {
        item.classList.add("task-list-item");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.disabled = true;
        checkbox.checked = task[1].toLowerCase() === "x";
        item.appendChild(checkbox);
        content = task[2];
      }
      const contentSpan = element("span", "list-item-content");
      appendInline(contentSpan, content);
      item.appendChild(contentSpan);
      list.appendChild(item);
      index++;
    }
    parent.appendChild(list);
    return index;
  }

  function appendMarkdown(parent, markdown) {
    const text = String(markdown || "").replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index++;
        continue;
      }

      if (isFence(line)) {
        const language = line.trim().slice(3).trim().split(/\s+/)[0] || "text";
        index++;
        const codeLines = [];
        while (index < lines.length && !isFence(lines[index])) {
          codeLines.push(lines[index]);
          index++;
        }
        if (index < lines.length) index++;
        appendCodeBlock(parent, language, codeLines.join("\n"));
        continue;
      }

      const heading = isHeading(line);
      if (heading) {
        const level = Math.min(6, heading[1].length);
        const node = element(`h${level}`, `md-heading md-h${level}`);
        appendInline(node, heading[2]);
        parent.appendChild(node);
        index++;
        continue;
      }

      if (isHr(line)) {
        parent.appendChild(element("hr", "markdown-hr"));
        index++;
        continue;
      }

      if (isQuote(line)) {
        const quoteLines = [];
        while (index < lines.length && isQuote(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
          index++;
        }
        const quote = element("blockquote", "markdown-quote");
        appendMarkdown(quote, quoteLines.join("\n"));
        parent.appendChild(quote);
        continue;
      }

      if (listMatch(line)) {
        index = appendList(parent, lines, index);
        continue;
      }

      if (index + 1 < lines.length && line.includes("|") && looksLikeTableSeparator(lines[index + 1])) {
        const headerCells = splitTableRow(line);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          rows.push(splitTableRow(lines[index]));
          index++;
        }
        appendTable(parent, headerCells, rows);
        continue;
      }

      const paragraphLines = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
        paragraphLines.push(lines[index]);
        index++;
      }
      const paragraph = element("p", "markdown-paragraph");
      for (let i = 0; i < paragraphLines.length; i++) {
        if (i > 0) paragraph.appendChild(document.createElement("br"));
        appendInline(paragraph, paragraphLines[i]);
      }
      parent.appendChild(paragraph);
    }
  }

  function renderInto(container, markdown) {
    container.textContent = "";
    container.classList.add("markdown-body");
    appendMarkdown(container, markdown);
  }

  function findSafeBoundary(text) {
    let inFence = false;
    let lastBoundary = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith("```", i)) {
        inFence = !inFence;
        i += 2;
        continue;
      }
      if (!inFence && text[i] === "\n" && text[i + 1] === "\n") {
        lastBoundary = i + 2;
        i++;
      }
    }
    return lastBoundary;
  }

  function createStreamingView(container, initialText = "") {
    container.textContent = "";
    container.classList.add("markdown-body", "is-streaming");
    const rich = element("div", "stream-rich");
    const tail = element("div", "stream-tail");
    const tailNode = document.createTextNode("");
    tail.appendChild(tailNode);
    container.append(rich, tail);
    const view = { container, rich, tail, tailNode, buffer: "" };
    if (initialText) appendStreamingText(view, initialText);
    return view;
  }

  function appendStreamingText(view, text) {
    if (!view || !text) return;
    view.buffer += String(text);
    const boundary = findSafeBoundary(view.buffer);
    if (boundary > 0) {
      const ready = view.buffer.slice(0, boundary);
      view.buffer = view.buffer.slice(boundary);
      appendMarkdown(view.rich, ready);
    }
    view.tailNode.data = view.buffer;
  }

  function finishStreamingView(view) {
    if (!view) return;
    if (view.buffer) appendMarkdown(view.rich, view.buffer);
    view.buffer = "";
    view.tail.remove();
    view.container.classList.remove("is-streaming");
  }

  window.ClaudeMarkdown = {
    renderInto,
    createStreamingView,
    appendStreamingText,
    finishStreamingView,
    findSafeBoundary,
  };
})();
