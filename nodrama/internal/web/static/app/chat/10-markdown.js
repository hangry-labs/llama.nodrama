"use strict";

/* ── Markdown → DOM renderer ────────────────────────────────────────── */
/* Block grammar handled: ATX headings, fenced code, GFM tables, lists
 * (-, *, +, 1.), blockquotes, horizontal rules, paragraphs.
 * Inline grammar: code spans, bold, italic, links (http(s) only). */
function renderMarkdown(src) {
  const frag = document.createDocumentFragment();
  const lines = String(src).split(/\r?\n/);
  let i = 0;

  const isHr = (l) => /^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(l);
  const isBlank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    let line = lines[i];

    /* skip blanks */
    if (isBlank(line)) { i++; continue; }

    /* fenced code block */
    let m = line.match(/^ {0,3}(```|~~~)(.*)$/);
    if (m) {
      const fence = m[1];
      const lang = m[2].trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        buf.push(lines[i]); i++;
      }
      if (i < lines.length) i++; /* skip closing fence */
      const pre = el("pre");
      const code = el("code", lang ? { class: "lang-" + lang.replace(/[^\w-]/g, "") } : null);
      code.textContent = buf.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    /* horizontal rule */
    if (isHr(line)) { frag.appendChild(el("hr")); i++; continue; }

    /* ATX heading */
    m = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      const h = el("h" + m[1].length);
      renderInlineInto(m[2], h);
      frag.appendChild(h);
      i++;
      continue;
    }

    /* table — needs a delimiter row immediately after a pipe-row */
    if (line.includes("|") && i + 1 < lines.length &&
        /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headers = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((c) => {
        const left = /^:/.test(c.trim()), right = /:$/.test(c.trim());
        if (left && right) return "center";
        if (right) return "right";
        if (left) return "left";
        return null;
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      const table = el("table");
      const thead = el("thead");
      const trh = el("tr");
      headers.forEach((h, idx) => {
        const th = el("th", aligns[idx] ? { style: "text-align:" + aligns[idx] } : null);
        renderInlineInto(h, th);
        trh.appendChild(th);
      });
      thead.appendChild(trh); table.appendChild(thead);
      const tbody = el("tbody");
      for (const r of rows) {
        const tr = el("tr");
        for (let idx = 0; idx < headers.length; idx++) {
          const td = el("td", aligns[idx] ? { style: "text-align:" + aligns[idx] } : null);
          renderInlineInto(r[idx] || "", td);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      frag.appendChild(table);
      continue;
    }

    /* blockquote */
    if (/^ {0,3}>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      const bq = el("blockquote");
      const inner = renderMarkdown(buf.join("\n"));
      bq.appendChild(inner);
      frag.appendChild(bq);
      continue;
    }

    /* list */
    const liMatch = line.match(/^ {0,3}([-*+]|\d+\.)\s+(.*)$/);
    if (liMatch) {
      const ordered = /\d+\./.test(liMatch[1]);
      const list = el(ordered ? "ol" : "ul");
      while (i < lines.length) {
        const lm = lines[i].match(/^ {0,3}([-*+]|\d+\.)\s+(.*)$/);
        if (!lm) break;
        const buf = [lm[2]];
        i++;
        while (i < lines.length &&
               !isBlank(lines[i]) &&
               !/^ {0,3}([-*+]|\d+\.)\s+/.test(lines[i]) &&
               !/^ {0,3}#{1,6}\s/.test(lines[i]) &&
               !/^ {0,3}(```|~~~)/.test(lines[i])) {
          buf.push(lines[i].replace(/^ {1,4}/, ""));
          i++;
        }
        const li = el("li");
        renderInlineInto(buf.join(" "), li);
        list.appendChild(li);
        if (i < lines.length && isBlank(lines[i])) { i++; break; }
      }
      frag.appendChild(list);
      continue;
    }

    /* paragraph — gather contiguous non-blank, non-block lines */
    const buf = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) &&
           !/^ {0,3}#{1,6}\s/.test(lines[i]) &&
           !/^ {0,3}(```|~~~)/.test(lines[i]) &&
           !/^ {0,3}>/.test(lines[i]) &&
           !/^ {0,3}([-*+]|\d+\.)\s+/.test(lines[i]) &&
           !isHr(lines[i])) {
      buf.push(lines[i]); i++;
    }
    const p = el("p");
    renderInlineInto(buf.join("\n"), p);
    frag.appendChild(p);
  }

  return frag;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|"))  s = s.slice(0, -1);
  /* split on unescaped pipes */
  const out = []; let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\" && s[k + 1] === "|") { cur += "|"; k++; continue; }
    if (c === "|") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/* Tokenize-and-render inline markdown into `target`. We walk the string
 * with a small state machine — never use innerHTML. Order matters:
 * code spans win first (their contents are literal). */
function renderInlineInto(src, target) {
  let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i];
    /* inline code */
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end !== -1) {
        const code = el("code");
        code.textContent = src.slice(i + 1, end);
        target.appendChild(code);
        i = end + 1; continue;
      }
    }
    /* bold ** ** */
    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end !== -1) {
        const strong = el("strong");
        renderInlineInto(src.slice(i + 2, end), strong);
        target.appendChild(strong);
        i = end + 2; continue;
      }
    }
    /* italic * * or _ _ */
    if ((c === "*" || c === "_") && src[i + 1] !== c) {
      const end = src.indexOf(c, i + 1);
      if (end !== -1 && /\S/.test(src.slice(i + 1, end))) {
        const em = el("em");
        renderInlineInto(src.slice(i + 1, end), em);
        target.appendChild(em);
        i = end + 1; continue;
      }
    }
    /* link [text](url) — only http(s) URLs are honored, others dropped to text */
    if (c === "[") {
      const close = src.indexOf("]", i + 1);
      if (close !== -1 && src[close + 1] === "(") {
        const paren = src.indexOf(")", close + 2);
        if (paren !== -1) {
          const url = src.slice(close + 2, paren).trim();
          const safe = /^https?:\/\//i.test(url);
          if (safe) {
            const a = el("a", { href: url, target: "_blank", rel: "noopener noreferrer" });
            renderInlineInto(src.slice(i + 1, close), a);
            target.appendChild(a);
            i = paren + 1; continue;
          }
        }
      }
    }
    /* line break (two trailing spaces + \n) */
    if (c === "\n") {
      target.appendChild(document.createTextNode("\n"));
      i++; continue;
    }
    /* plain text run — find next markdown trigger */
    const next = nextInlineTrigger(src, i);
    target.appendChild(document.createTextNode(src.slice(i, next)));
    i = next;
  }
}

function nextInlineTrigger(src, from) {
  for (let k = from + 1; k < src.length; k++) {
    const c = src[k];
    if (c === "`" || c === "*" || c === "_" || c === "[" || c === "\n") return k;
  }
  return src.length;
}

