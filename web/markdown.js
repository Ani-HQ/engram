const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function renderMarkdown(markdown = "") {
  const root = document.createDocumentFragment();
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      index += lines[index]?.startsWith("```") ? 1 : 0;
      root.append(el("pre", {}, el("code", {}, code.join("\n"))));
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      const node = el(`h${level}`);
      appendInline(node, heading[2]);
      root.append(node);
      index += 1;
      continue;
    }

    if (/^\s*((-|\*)|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const list = el(ordered ? "ol" : "ul");
      while (index < lines.length && /^\s*((-|\*)|\d+\.)\s+/.test(lines[index])) {
        const item = el("li");
        appendInline(item, lines[index].replace(/^\s*((-|\*)|\d+\.)\s+/, ""));
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }

    const para = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,4})\s+/.test(lines[index]) && !/^\s*((-|\*)|\d+\.)\s+/.test(lines[index]) && !lines[index].startsWith("```")) {
      para.push(lines[index]);
      index += 1;
    }
    const p = el("p");
    appendInline(p, para.join(" "));
    root.append(p);
  }

  return root;
}

function appendInline(parent, text) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        parent.append(el("code", {}, text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i) {
        parent.append(el("strong", {}, text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }
    if (text[i] === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        parent.append(el("em", {}, text.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }
    if (text[i] === "[" && text[i + 1] === "[") {
      const close = text.indexOf("]]", i + 2);
      if (close > -1) {
        const target = text.slice(i + 2, close).split("|")[0].trim();
        parent.append(el("a", { href: `#${target}`, class: "wikilink", "data-slug": target }, target));
        i = close + 2;
        continue;
      }
    }
    if (text[i] === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      const urlStart = labelEnd >= 0 ? text.indexOf("(", labelEnd) : -1;
      const urlEnd = urlStart === labelEnd + 1 ? text.indexOf(")", urlStart) : -1;
      if (labelEnd > i && urlEnd > urlStart) {
        const href = safeHref(text.slice(urlStart + 1, urlEnd).trim());
        const link = el("a", href ? { href } : {}, text.slice(i + 1, labelEnd));
        parent.append(link);
        i = urlEnd + 1;
        continue;
      }
    }
    const next = nextToken(text, i + 1);
    parent.append(document.createTextNode(text.slice(i, next)));
    i = next;
  }
}

function nextToken(text, from) {
  const candidates = ["`", "**", "*", "["]
    .map(token => text.indexOf(token, from))
    .filter(index => index >= 0);
  return candidates.length ? Math.min(...candidates) : text.length;
}

function safeHref(raw) {
  if (!raw) return "";
  if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) return raw;
  try {
    const url = new URL(raw, location.origin);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  });
  children.flat().forEach(child => node.append(child instanceof Node ? child : document.createTextNode(String(child))));
  return node;
}
