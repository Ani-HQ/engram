const textValue = value => typeof value === "string" ? value : "";
const comparableHeading = value => textValue(value).normalize("NFKC").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

function linesOf(source) {
  return [...source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter(match => match[0]).map(match => ({
    text: match[0].replace(/[\r\n]+$/, ""), source: match[0], start: match.index, end: match.index + match[0].length,
  }));
}

function withoutDuplicateHeading(source, title, slug) {
  const lines = linesOf(source), index = lines.findIndex(line => line.text.trim());
  if (index < 0) return { document: source, removedHeading: null };
  const line = lines[index], first = line.text.replace(/^\uFEFF/, "");
  const atx = first.match(/^ {0,3}#{1,6}[\t ]+(.+?)(?:[\t ]+#+)?[\t ]*$/);
  const setext = !atx && lines[index + 1]?.text.match(/^ {0,3}(?:=+|-+)[\t ]*$/);
  const heading = atx?.[1] || (setext ? first.trim() : "");
  const candidates = [title, textValue(slug).split("/").filter(Boolean).at(-1)].map(comparableHeading).filter(Boolean);
  if (!heading || !candidates.includes(comparableHeading(heading))) return { document: source, removedHeading: null };
  const end = lines[index + (setext ? 1 : 0)].end;
  return { document: source.slice(0, line.start) + source.slice(end), removedHeading: { text: heading, source: source.slice(line.start, end) } };
}

// Date.parse normalizes some impossible calendar dates. Validate every local
// calendar/time field before using it to convert a timezone-bearing ISO value.
function journalDate(token) {
  const match = token.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2}))?$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hour, minute, second, , zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59)) return null;
  if (zone && !/^[Zz]$/.test(zone) && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const time = Date.parse(hour === undefined ? `${token}T00:00:00.000Z` : token);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function datedBullet(line) {
  const bullet = line.match(/^[-*+][\t ]+/);
  if (!bullet) return null;
  const value = line.slice(bullet[0].length);
  const timestamp = value.match(/^\d{4}-\d{2}-\d{2}(?:[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2}))?/)?.[0];
  if (!timestamp) return null;
  const rest = value.slice(timestamp.length);
  const delimiter = rest.match(/^(?:[\t ]*[—–:][\t ]*|[\t ]+(?:-[\t ]+)?)/)?.[0];
  if (rest && !delimiter) return null;
  const at = journalDate(timestamp);
  return at ? { at, timestamp, prefixLength: bullet[0].length + timestamp.length + (delimiter?.length || 0) } : null;
}

function fenceStart(text) {
  const match = text.match(/^[\t ]*(`{3,}|~{3,})(.*)$/);
  if (!match || match[1][0] === "`" && match[2].includes("`")) return null;
  return { character: match[1][0], length: match[1].length };
}
function fenceEnd(text, fence) {
  const match = text.match(/^[\t ]*(`+|~+)[\t ]*$/);
  return Boolean(match && match[1][0] === fence.character && match[1].length >= fence.length);
}
const topLevelList = text => /^(?:[-*+][\t ]+|\d+[.)][\t ]+)/.test(text);
const blockStart = text => topLevelList(text) || /^ {0,3}(?:#{1,6}[\t ]|>|<|\||(?:-{3,}|\*{3,}|_{3,})[\t ]*$)/.test(text) || Boolean(fenceStart(text));
const subMillisecond = timestamp => Number((timestamp.match(/\.(\d+)/)?.[1] || "").padEnd(9, "0").slice(3));

function entryStarts(lines) {
  const starts = [];
  let fence = null;
  const first = lines.findIndex(line => line.text.trim());
  let frontmatter = first >= 0 && lines[first].text.replace(/^\uFEFF/, "").trim() === "---";
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index].text;
    if (frontmatter) {
      if (index > first && /^(?:---|\.\.\.)[\t ]*$/.test(text)) frontmatter = false;
      continue;
    }
    if (fence) { if (fenceEnd(text, fence)) fence = null; continue; }
    const opening = fenceStart(text);
    if (opening) { fence = opening; continue; }
    const bullet = datedBullet(text);
    if (bullet) starts.push({ line: index, ...bullet });
  }
  return starts;
}

function readEntry(document, lines, start, order) {
  let index = start.line + 1, end = lines[start.line].end, fence = null;
  while (index < lines.length) {
    const line = lines[index];
    if (fence) {
      end = line.end; index++;
      if (fenceEnd(line.text, fence)) fence = null;
      continue;
    }
    if (!line.text.trim()) {
      let next = index + 1;
      while (next < lines.length && !lines[next].text.trim()) next++;
      if (next >= lines.length || !/^(?: {2,}|\t)/.test(lines[next].text)) break;
      end = line.end; index++; continue;
    }
    if (/^(?: {2,}|\t)/.test(line.text)) {
      fence = fenceStart(line.text); end = line.end; index++; continue;
    }
    if (blockStart(line.text)) break;
    // An immediately following plain line is Markdown's lazy list
    // continuation. A blank line followed by prose remains outside the entry.
    end = line.end; index++;
  }
  const begin = lines[start.line].start;
  return { at: start.at, timestamp: start.timestamp, text: document.slice(begin + start.prefixLength, end),
    order, source: document.slice(begin, end), start: begin, end, line: start.line, endLine: index };
}

function ordinary(document) {
  return { intro: document, outro: "", entries: [], sections: document ? [{ kind: "prose", source: document }] : [], isJournal: false };
}

function journal(document) {
  const lines = linesOf(document), starts = entryStarts(lines);
  if (!starts.length) return ordinary(document);
  const sourceEntries = starts.map((start, order) => readEntry(document, lines, start, order));
  for (let index = 1; index < sourceEntries.length; index++) {
    if (sourceEntries[index].start < sourceEntries[index - 1].end || document.slice(sourceEntries[index - 1].end, sourceEntries[index].start).trim()) return ordinary(document);
  }
  const first = sourceEntries[0], last = sourceEntries.at(-1);
  const before = lines.slice(0, first.line).filter(line => line.text.trim()).at(-1);
  const after = lines.slice(last.endLine).find(line => line.text.trim());
  // A mixed ordinary/date list remains a normal Markdown list. No subset is
  // silently promoted to a journal or detached from its neighbouring items.
  if (before && topLevelList(before.text) || after && topLevelList(after.text)) return ordinary(document);
  const sections = [];
  let position = 0;
  for (const entry of sourceEntries) {
    if (entry.start > position) sections.push({ kind: "prose", source: document.slice(position, entry.start) });
    sections.push({ kind: "entry", order: entry.order, source: entry.source }); position = entry.end;
  }
  if (position < document.length) sections.push({ kind: "prose", source: document.slice(position) });
  return { intro: document.slice(0, first.start), outro: document.slice(last.end), sections,
    entries: [...sourceEntries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || subMillisecond(b.timestamp) - subMillisecond(a.timestamp) || a.order - b.order), isJournal: true };
}

export function memoryDocument(page = {}) {
  const title = textValue(page?.title), slug = textValue(page?.slug), source = textValue(page?.body);
  const { document, removedHeading } = withoutDuplicateHeading(source, title, slug);
  const parsed = journal(document);
  return { title, slug, source, body: source, document, duplicateHeadingRemoved: Boolean(removedHeading), removedHeading,
    ...parsed, proseSections: parsed.sections.filter(section => section.kind === "prose") };
}

// A preview is an exact source prefix, not a summary or HTML/Markdown rewrite.
// Callers render it as text and can indicate truncation separately if needed.
export function sourceExcerpt(value, maximum = 180) {
  const source = textValue(value);
  const limit = Number.isFinite(maximum) ? Math.max(0, Math.min(2000, Math.floor(maximum))) : 180;
  const characters = [];
  for (const character of source) { if (characters.length >= limit) break; characters.push(character); }
  return characters.join("");
}
