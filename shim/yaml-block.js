'use strict';

// A small, conservative editor for block-style YAML configuration, used for
// Hermes Agent's ~/.hermes/config.yaml. The connector runs from a bare `npx`
// with no YAML dependency, so it never parses or re-serializes the document.
// It only replaces or inserts the lines it owns, under one top-level key, and
// leaves every other line (comments included) exactly as it was.
//
// Supported: a top-level block mapping (`parent:` followed by indented
// children), whose child holds either a block mapping or a block sequence.
// Anything else at those two levels (flow style, anchors, aliases, tags, tabs,
// duplicate keys) is refused with an error so the person's file is preserved.

const PLAIN_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*|"[^"\\]*"|'[^']*')[ \t]*:(?:[ \t]+(.*))?$/;
const EMPTY_VALUES = new Set(['', '{}', '[]', 'null', '~', 'Null', 'NULL']);

function unsupported(message) {
  return new Error(`${message} Setup preserved the file; add Engram there by hand or simplify that section.`);
}

function split(raw) {
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw ? raw.split(/\r?\n/) : [];
  if (lines.length && lines.at(-1) === '') lines.pop();
  return { lines, eol };
}
function join({ lines, eol }) { return lines.length ? lines.join(eol) + eol : ''; }

function indentOf(line) {
  const match = /^([ \t]*)/.exec(line)[1];
  if (match.includes('\t') && line.trim()) throw unsupported('This YAML file indents with tabs.');
  return match.length;
}
const skip = line => /^\s*(#.*)?$/.test(line);
const unquote = key => (key.startsWith('"') || key.startsWith("'")) ? key.slice(1, -1) : key;

/** The value text after `key:`, without a trailing comment. */
function inlineValue(rest) {
  const value = String(rest || '');
  if (value.startsWith('#')) return '';
  if (/^["']/.test(value)) return value.trim();
  return value.replace(/\s+#.*$/, '').trim();
}

function keyAt(line, indent) {
  if (indentOf(line) !== indent) return null;
  const match = PLAIN_KEY.exec(line.slice(indent));
  return match ? { key: unquote(match[1]), value: inlineValue(match[2]) } : null;
}

/** Index after the last meaningful line of a block, so trailing comments stay put. */
function contentEnd(lines, start, end) {
  let last = start;
  for (let i = start + 1; i < end; i++) if (!skip(lines[i])) last = i;
  return last + 1;
}

function blockEnd(lines, start, indent) {
  let end = start + 1;
  while (end < lines.length && (skip(lines[end]) || indentOf(lines[end]) > indent)) end++;
  return contentEnd(lines, start, end);
}

function checkValue(value, label) {
  if (EMPTY_VALUES.has(value)) return value === '' ? 'block' : 'empty';
  throw unsupported(`${label} uses a one-line or anchored YAML value.`);
}

/** Finds `key:` among the children at `indent` between start and end. */
function findKey(lines, start, end, indent, key, label) {
  let found = null;
  for (let i = start; i < end; i++) {
    if (skip(lines[i]) || indentOf(lines[i]) !== indent) continue;
    const entry = keyAt(lines[i], indent);
    if (!entry || entry.key !== key) continue;
    if (found) throw unsupported(`${label} appears more than once.`);
    found = { index: i, value: entry.value, end: blockEnd(lines, i, indent) };
  }
  if (found) found.kind = checkValue(found.value, label);
  return found;
}

function childIndent(lines, start, end, parentIndent) {
  for (let i = start + 1; i < end; i++) {
    if (skip(lines[i])) continue;
    const indent = indentOf(lines[i]);
    if (indent <= parentIndent) return null;
    return indent;
  }
  return null;
}

const spaces = count => ' '.repeat(count);

/** Ensures a top-level block mapping `parent:` exists. Returns its location. */
function ensureParent(doc, parent) {
  const label = `"${parent}" in this YAML file`;
  if (doc.lines.some(line => /^(---|\.\.\.)(\s|$)/.test(line))) throw unsupported('This YAML file has more than one document.');
  let found = findKey(doc.lines, 0, doc.lines.length, 0, parent, label);
  if (!found) {
    const at = contentEnd(doc.lines, -1, doc.lines.length);
    const insert = at > 0 ? ['', `${parent}:`] : [`${parent}:`];
    doc.lines.splice(at, 0, ...insert);
    found = { index: at + insert.length - 1, value: '', kind: 'block', end: at + insert.length };
  } else if (found.kind === 'empty') {
    doc.lines[found.index] = `${parent}:`;
  }
  const indent = childIndent(doc.lines, found.index, found.end, 0);
  if (indent !== null && /^-(\s|$)/.test(doc.lines.slice(found.index + 1, found.end).find(line => !skip(line)).trim())) throw unsupported(`${label} is a list, not a mapping.`);
  return { ...found, indent: indent ?? 2 };
}

/** Replaces or adds `parent.child` with the given value lines (relative indentation). */
function setMappingChild(raw, parent, child, valueLines) {
  const doc = split(raw);
  const top = ensureParent(doc, parent);
  const existing = findKey(doc.lines, top.index + 1, top.end, top.indent, child, `"${parent}.${child}"`);
  const block = [`${spaces(top.indent)}${child}:`, ...valueLines.map(line => `${spaces(top.indent + 2)}${line}`)];
  if (existing) doc.lines.splice(existing.index, existing.end - existing.index, ...block);
  else doc.lines.splice(top.end, 0, ...block);
  return join(doc);
}

/**
 * Keeps `parent.child` a block list: removes the items `managed` recognizes
 * and appends `itemLines` (first line starts with "- ").
 */
function setSequenceItem(raw, parent, child, managed, itemLines) {
  const doc = split(raw);
  const top = ensureParent(doc, parent);
  const label = `"${parent}.${child}"`;
  const existing = findKey(doc.lines, top.index + 1, top.end, top.indent, child, label);
  if (!existing) {
    doc.lines.splice(top.end, 0, `${spaces(top.indent)}${child}:`, ...itemLines.map(line => `${spaces(top.indent + 2)}${line}`));
    return join(doc);
  }
  if (existing.kind === 'empty') doc.lines[existing.index] = `${spaces(top.indent)}${child}:`;
  // A sequence may sit at the key's own indentation ("indentless") or deeper.
  let end = existing.end;
  let seqIndent = null;
  for (let i = existing.index + 1; i < doc.lines.length; i++) {
    if (skip(doc.lines[i])) continue;
    const indent = indentOf(doc.lines[i]);
    if (indent >= top.indent && /^-(\s|$)/.test(doc.lines[i].slice(indent)) && (indent > top.indent || i < top.end)) seqIndent = indent;
    break;
  }
  if (seqIndent === null) {
    if (end > existing.index + 1 && doc.lines.slice(existing.index + 1, end).some(line => !skip(line))) throw unsupported(`${label} is not a list.`);
    seqIndent = top.indent + 2;
  } else if (seqIndent === top.indent) {
    end = existing.index + 1;
    while (end < top.end && (skip(doc.lines[end]) || indentOf(doc.lines[end]) > seqIndent || /^-(\s|$)/.test(doc.lines[end].slice(seqIndent)))) end++;
    end = contentEnd(doc.lines, existing.index, end);
  }
  const items = [];
  for (let i = existing.index + 1; i < end; i++) {
    if (skip(doc.lines[i])) continue;
    const indent = indentOf(doc.lines[i]);
    if (indent === seqIndent && /^-(\s|$)/.test(doc.lines[i].slice(indent))) items.push({ start: i });
    else if (indent <= seqIndent) throw unsupported(`${label} mixes list items with other values.`);
  }
  items.forEach((item, n) => { item.end = contentEnd(doc.lines, item.start, n + 1 < items.length ? items[n + 1].start : end); });
  const kept = [];
  let cursor = existing.index + 1;
  for (const item of items) {
    kept.push(...doc.lines.slice(cursor, item.start));
    if (!managed(doc.lines.slice(item.start, item.end).join('\n'))) kept.push(...doc.lines.slice(item.start, item.end));
    cursor = item.end;
  }
  kept.push(...doc.lines.slice(cursor, end));
  while (kept.length && skip(kept.at(-1)) && !kept.at(-1).trim()) kept.pop();
  doc.lines.splice(existing.index + 1, end - existing.index - 1, ...kept, ...itemLines.map(line => `${spaces(seqIndent)}${line}`));
  return join(doc);
}

/** The lines under `parent.child`, or null when absent. */
function readMappingChild(raw, parent, child) {
  const doc = split(raw);
  const top = findKey(doc.lines, 0, doc.lines.length, 0, parent, `"${parent}"`);
  if (!top || top.kind !== 'block') return null;
  const indent = childIndent(doc.lines, top.index, top.end, 0);
  if (indent === null) return null;
  const entry = findKey(doc.lines, top.index + 1, top.end, indent, child, `"${parent}.${child}"`);
  return entry ? doc.lines.slice(entry.index + 1, entry.end) : null;
}

/** A YAML scalar written as plain, single-quoted or double-quoted text. */
function scalar(text) {
  const value = String(text).trim();
  if (value.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(value);
    if (!match) return undefined;
    try { return JSON.parse(`"${match[1]}"`); } catch { return undefined; }
  }
  if (value.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'/.exec(value);
    return match ? match[1].replace(/''/g, "'") : undefined;
  }
  return value.replace(/\s+#.*$/, '') || undefined;
}

/** A double-quoted YAML string. JSON string escapes are valid YAML escapes. */
function quote(value) { return JSON.stringify(String(value)); }

module.exports = { setMappingChild, setSequenceItem, readMappingChild, scalar, quote };
