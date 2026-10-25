import { h } from "./profile.js";
import { icon } from "./icons.js";
import { renderMarkdown } from "./markdown.js";
import { agentVisual, visualIcon } from "./tooling.js";
import { memoryDocument, sourceExcerpt } from "./memory-document-model.js";
import { statusBadge } from "./design-system.js";

const action = (label, fn, attrs = {}) => h("button", { type: "button", onclick: fn, ...attrs }, label);
function dateLabel(value, options = { day: "numeric", month: "short", year: "numeric" }) {
  const date = new Date(value);
  return value && Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(undefined, options).format(date) : "";
}
function timestamp(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.valueOf()) ? date.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" }) : "";
}
function entryDate(entry) {
  // Calendar-only dates are not instants: do not invent midnight or shift them
  // to the preceding day in a viewer's timezone.
  return /^\d{4}-\d{2}-\d{2}$/.test(entry.timestamp)
    ? dateLabel(`${entry.timestamp}T12:00:00Z`, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : dateLabel(entry.at);
}

/** A reader over the returned memory, without inference or content rewriting. */
export function memoryDocumentView(data, { copyControl } = {}) {
  const page = data?.page || {}, model = memoryDocument(page);
  const snapshot = page.type === "shared-context";
  const snapshotBadge = snapshot ? statusBadge("Read-only snapshot", { tone: "info" }) : null;
  if (snapshotBadge) snapshotBadge.prepend(icon("shield-check", { size: 13 }));
  const root = h("article", { class: "memory-document" });
  const titleText = (model.title === model.slug ? model.slug.split("/").filter(Boolean).at(-1) : model.title) || model.slug || "Untitled memory";
  const title = h("h2", { id: "detail-title", class: "memory-document-title" }, titleText);
  const metadata = h("div", { class: "memory-document-meta" },
    model.entries.length ? h("span", {}, icon("layers", { size: 13 }), `${model.entries.length} ${model.entries.length === 1 ? "entry" : "entries"}`) : h("span", {}, icon("file-text", { size: 13 }), "Saved memory"),
    dateLabel(page.updated_at) && h("time", { datetime: page.updated_at, title: timestamp(page.updated_at) }, icon("clock", { size: 13 }), `Updated ${dateLabel(page.updated_at)}`));
  const header = h("header", { class: "memory-document-header" },
    h("div", { class: "memory-document-topline" }, h("span", { class: "memory-document-symbol", "aria-hidden": "true" }, icon("file-text", { size: 20 })), snapshotBadge),
    title, h("p", { class: "memory-document-path" }, model.slug), metadata,
    snapshot && h("p", { class: "detail-note" }, "Approved snapshot. Changes and access are managed by the sharing owner."));

  const read = h("section", { id: "memory-reader-panel", role: "tabpanel", "aria-labelledby": "memory-reader-tab", tabindex: "0", class: "memory-reader-panel" });
  const source = h("section", { id: "memory-source-panel", role: "tabpanel", "aria-labelledby": "memory-source-tab", tabindex: "0", hidden: true, class: "memory-source-panel" },
    h("div", { class: "memory-source-toolbar" }, h("p", { class: "memory-source-caption" }, "The exact text stored in this memory."), copyControl), h("pre", { class: "memory-source-text" }, h("code", {}, model.source)));
  const tabs = h("div", { class: "memory-document-tabs", role: "tablist", "aria-label": "Memory view" });
  const panels = [read, source];
  const tabButtons = ["Read", "Source"].map((label, index) => action([icon(index ? "code" : "file-text", { size: 14 }), label], () => selectTab(index), {
    id: index ? "memory-source-tab" : "memory-reader-tab", role: "tab", "aria-selected": index === 0 ? "true" : "false", "aria-controls": panels[index].id, tabindex: index ? "-1" : "0",
  }));
  function selectTab(index, focus = false) {
    tabButtons.forEach((tab, i) => { tab.setAttribute("aria-selected", String(i === index)); tab.tabIndex = i === index ? 0 : -1; panels[i].hidden = i !== index; });
    if (focus) tabButtons[index].focus();
  }
  tabs.addEventListener("keydown", event => {
    const current = tabButtons.indexOf(document.activeElement);
    if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectTab(event.key === "Home" ? 0 : event.key === "End" ? 1 : (current + 1) % 2, true);
  });
  tabs.append(...tabButtons);
  if (model.isJournal) read.append(journal(model));
  else if (model.document.trim()) read.append(documentSections(model.document));
  else read.append(h("div", { class: "memory-document-empty" }, icon("file-text", { size: 22 }), h("p", {}, "This memory has no content yet.")));

  const related = relatedMemories(data?.links, model.slug);
  if (related) read.append(related);
  const provenance = data?.provenance || page.provenance;
  const contributors = Array.isArray(provenance?.contributors) ? provenance.contributors.filter(person => typeof person?.name === "string" && person.name.trim()) : [];
  if (contributors.length) read.append(h("details", { class: "memory-contributors" }, h("summary", {}, icon("users", { size: 14 }), `${contributors.length} ${contributors.length === 1 ? "contributor" : "contributors"}`, icon("chevron-down", { size: 13, class: "memory-disclosure-arrow" })),
    h("div", { class: "memory-contributor-list" }, contributors.map(person => h("div", { class: "memory-contributor" }, visualIcon(agentVisual(person.name), { size: 16 }), h("span", {}, person.name), Number.isInteger(person.writes) && person.writes > 0 && h("small", {}, `${person.writes} ${person.writes === 1 ? "write" : "writes"}`))))));
  root.append(header, tabs, read, source);
  return root;
}

function journal(model) {
  const container = h("div", { class: "memory-journal" });
  // A calendar date does not establish an instant within that day. Mixed
  // precision keeps the author's sequence instead of inventing midnight order.
  const sourceOrder = model.entries.some(entry => /^\d{4}-\d{2}-\d{2}$/.test(entry.timestamp));
  const entries = sourceOrder ? [...model.entries].sort((a, b) => a.order - b.order) : model.entries;
  if (model.intro.trim()) container.append(h("div", { class: "memory-journal-context memory-prose" }, renderMarkdown(model.intro)));
  const list = h("div", { class: "memory-entry-list" });
  const status = h("span", { class: "memory-entry-count", role: "status", "aria-live": "polite" });
  const expand = action("Expand all", () => {
    const visible = [...list.querySelectorAll("details")];
    const open = visible.some(node => !node.open);
    visible.forEach(node => { node.open = open; });
    syncExpand();
  }, { class: "memory-expand" });
  function syncExpand() {
    const nodes = [...list.querySelectorAll("details")];
    expand.textContent = nodes.length && nodes.every(node => node.open) ? "Collapse all" : "Expand all";
    expand.disabled = nodes.length === 0;
  }
  let query = "", shown = 8;
  const more = action("Show older entries", () => { shown += 8; refresh(); }, { class: "memory-show-more" });
  const empty = h("div", { class: "memory-search-empty", hidden: true }, icon("search", { size: 20 }), h("p", {}, "No entries match your search."));
  function refresh() {
    const matches = entries.filter(entry => !query || `${entry.text} ${entry.timestamp} ${entryDate(entry)}`.toLocaleLowerCase().includes(query));
    const openIds = new Set([...list.querySelectorAll("details[open]")].map(node => node.dataset.entryOrder));
    list.replaceChildren(...matches.slice(0, shown).map(entry => entryView(entry, openIds.has(String(entry.order)), syncExpand)));
    status.textContent = query ? `${matches.length} of ${entries.length}` : sourceOrder ? "Source order" : "Newest first";
    more.hidden = matches.length <= shown;
    const remaining = Math.max(0, matches.length - shown);
    more.textContent = `Show ${Math.min(8, remaining)} more ${remaining === 1 ? "entry" : "entries"}`;
    empty.hidden = matches.length > 0;
    syncExpand();
  }
  const controls = h("div", { class: "memory-entry-heading" }, h("h3", {}, "Entries"), status, expand);
  container.append(controls);
  if (model.entries.length > 5) {
    const input = h("input", { type: "search", placeholder: "Find in this memory…", "aria-label": "Find in memory entries", oninput: event => { query = event.target.value.trim().toLocaleLowerCase(); shown = 8; refresh(); } });
    container.append(h("div", { class: "memory-entry-search" }, icon("search", { size: 14 }), input));
  }
  container.append(list, empty, more);
  if (model.outro.trim()) container.append(h("div", { class: "memory-journal-outro memory-prose" }, renderMarkdown(model.outro)));
  refresh();
  return container;
}

function entryView(entry, open, changed) {
  const plainText = [...renderMarkdown(entry.text).childNodes].map(node => node.textContent).join(" ");
  // Some journals repeat the same saved date inside their content. Keep the
  // full note exact; the closed preview can omit that redundant prefix.
  let previewText = plainText;
  for (const prefix of [entry.timestamp, entry.timestamp.slice(0, 10)]) {
    if (!previewText.startsWith(prefix)) continue;
    const separator = previewText.slice(prefix.length).match(/^\s*[—–:]\s*|^\s+-\s+/)?.[0];
    if (separator) { previewText = previewText.slice(prefix.length + separator.length); break; }
  }
  const preview = sourceExcerpt(previewText, 320);
  const date = entryDate(entry), time = /T/i.test(entry.timestamp) ? dateLabel(entry.at, { hour: "numeric", minute: "2-digit" }) : "";
  const node = h("details", { class: "memory-entry", "data-entry-order": entry.order, open },
    h("summary", { "aria-label": `${date}${time ? ` at ${time}` : ""}: ${sourceExcerpt(plainText, 90)}` },
      h("span", { class: "memory-entry-topline" }, h("time", { datetime: entry.timestamp, title: time ? timestamp(entry.at) : date }, date, time && h("span", {}, time)),
        h("span", { class: "memory-entry-prompt", "aria-hidden": "true" }, h("span", { class: "memory-entry-read" }, "Read note"), h("span", { class: "memory-entry-close" }, "Close"), icon("chevron-down", { size: 14, class: "memory-disclosure-arrow" }))),
      h("span", { class: "memory-entry-preview" }, preview)),
    h("div", { class: "memory-entry-body memory-prose" }, renderMarkdown(entry.text)));
  node.addEventListener("toggle", changed);
  return node;
}

function documentSections(markdown) {
  const fragment = renderMarkdown(markdown), nodes = [...fragment.childNodes];
  const headings = nodes.filter(node => /^H[2-6]$/.test(node.nodeName));
  const level = headings.length ? Math.min(...headings.map(node => Number(node.nodeName.slice(1)))) : 0;
  const sectionHeading = node => node.nodeName === `H${level}`;
  const root = h("div", { class: "memory-reading-document memory-prose" });
  // Short notes are read directly. Longer structured documents disclose their
  // actual sections, without generating headings or summaries.
  if (headings.filter(sectionHeading).length < 3) { root.append(fragment); return root; }
  let current = root, index = 0;
  for (const node of nodes) {
    if (sectionHeading(node)) {
      const section = h("details", { class: "memory-document-section", open: index++ === 0 }, h("summary", {}, node, icon("chevron-down", { size: 14, class: "memory-disclosure-arrow" })));
      current = h("div", { class: "memory-document-section-body" }); section.append(current); root.append(section);
    } else current.append(node);
  }
  return root;
}

function relatedMemories(links, currentSlug) {
  const seen = new Set([currentSlug]);
  const valid = (Array.isArray(links) ? links : []).filter(link => {
    if (typeof link?.slug !== "string" || !link.slug.trim() || seen.has(link.slug) || /[\u0000-\u001f]/.test(link.slug)) return false;
    seen.add(link.slug); return true;
  }).slice(0, 12);
  if (!valid.length) return null;
  return h("section", { class: "memory-related" }, h("h3", {}, "Linked memories"), h("div", {}, valid.map(link => h("a", { href: `#${encodeURIComponent(link.slug)}`, class: "wikilink memory-related-link", "data-slug": link.slug }, icon("file-text", { size: 14 }), h("span", {}, link.title || link.slug), icon("arrow-up-right", { size: 13 })))));
}
