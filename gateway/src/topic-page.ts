export const TOPIC_ROLL_AT = 6000;
export const TOPIC_KEEP = 3500;
export const ARCHIVE_SUFFIX = "-archive";
export const ARCHIVE_POINTER = "Older entries:";

export function splitTopicEntries(body: string): { header: string[]; entries: string[][] } {
  const header: string[] = [];
  const entries: string[][] = [];
  for (const line of body.split("\n")) {
    if (/^- /.test(line)) entries.push([line]);
    else if (entries.length) entries[entries.length - 1].push(line);
    else header.push(line);
  }
  return { header, entries };
}

export function entryText(entry: string[]): string {
  return entry.join("\n").trimEnd();
}

export function splitForRoll(entries: string[][]): { keep: string[][]; move: string[][] } {
  const keep: string[][] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const size = entryText(entries[i]).length + 2;
    if (keep.length && used + size > TOPIC_KEEP) return { keep, move: entries.slice(0, i + 1) };
    used += size;
    keep.unshift(entries[i]);
  }
  return { keep, move: [] };
}
