import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { contributionGrid, profileCard, updateProfileCard, updateProfileTimes } from "./profile.js";

const dataKey = (key: string) => key.slice(5).replace(/-([a-z])/g, (_: string, letter: string) => letter.toUpperCase());
class Element {
  attrs: Record<string, string> = {}; dataset: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {};
  parentElement: Element | null = null; hidden = false; open = false; tabIndex = -1; text = ""; title = ""; scrollLeft = 0;
  style = { values: {} as Record<string, string>, setProperty: (key: string, value: string) => { this.style.values[key] = value; } };
  constructor(public tag: string, text = "") { this.text = text; }
  set className(value: string) { this.attrs.class = value; }
  get className() { return this.attrs.class || ""; }
  get classList() { return { contains: (name: string) => this.className.split(" ").includes(name) }; }
  get childNodes() { return [...this.children]; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; if (key.startsWith("data-")) this.dataset[dataKey(key)] = value; if (key === "tabindex") this.tabIndex = Number(value); if (key === "hidden") this.hidden = true; }
  removeAttribute(key: string) { delete this.attrs[key]; if (key.startsWith("data-")) delete this.dataset[dataKey(key)]; }
  getAttribute(key: string) { return key.startsWith("data-") ? this.dataset[dataKey(key)] ?? null : this.attrs[key] ?? null; }
  addEventListener(key: string, callback: Function) { this.events[key] = callback; }
  append(...items: Element[]) { items.forEach(item => { item.remove(); item.parentElement = this; this.children.push(item); }); }
  insertBefore(item: Element, before: Element | null) { item.remove(); item.parentElement = this; const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, item); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  replaceChildren(...items: Element[]) { this.children.forEach(item => item.parentElement = null); this.children = []; this.text = ""; this.append(...items); }
  replaceWith(item: Element) { const parent = this.parentElement; if (parent) { parent.insertBefore(item, this); this.remove(); } }
  get textContent(): string { return this.text + this.children.map(item => item.textContent).join(""); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  querySelectorAll(selector: string): Element[] { return all(this).slice(1).filter(item => selector.split(",").some(part => matches(item, part.trim()))); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector: string): Element | null { return matches(this, selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(node: Element | null): boolean { return !!node && all(this).includes(node); }
  focus() { (document as any).activeElement = this; this.events.focus?.({ currentTarget: this }); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
function matches(node: Element, selector: string): boolean {
  const parts = selector.split(" ");
  if (parts.length > 1) return matches(node, parts.at(-1)!) && !!node.parentElement?.closest(parts.slice(0, -1).join(" "));
  if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
  const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if (attribute) return node.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || node.getAttribute(attribute[1]) === attribute[2]);
  return node.tag === selector;
}
const original = { Node: globalThis.Node, document: globalThis.document };
beforeEach(() => Object.assign(globalThis, { Node: Element, document: { activeElement: null, createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (text: string) => new Element("#text", text) } }));
afterEach(() => Object.assign(globalThis, original));
const daily = [{ date: "2026-10-23", count: 1 }, { date: "2026-10-24", count: 2 }, { date: "2026-10-25", count: 3 }];
const event = { id: "a".repeat(32), agent: { product: "codex", label: "Codex" }, agentAlias: "private laptop alias", service: "github", action: "GitHub activity", status: "running", evidence: "reported", updatedAt: "2026-10-25T10:00:00Z", taskTitle: "private task title", resource: "https://private.example/doc" };
const sample = { profile: { displayName: "Ada", bio: "Building useful things.", slug: "ada" }, stats: { totalActions: 6, activeAgents: 1, activeDays: 3 }, daily, tools: [{ category: "code", count: 6 }], live: { workingAgents: 1, recentlyActiveAgents: 1, completedAgents: 1, staleActions: 0 }, activity: { enabled: true, events: [event] } };

describe("public activity profile", () => {
  test("profile photos update without resetting activity or charts and removals use the fallback", () => {
    const photoUrl = `/api/public/activity/ada/photo.png?v=${"a".repeat(64)}`;
    const data = { ...sample, profile: { ...sample.profile, photoUrl } };
    const card = profileCard(data) as unknown as Element;
    const slot = card.querySelector(".profile-identity-photo")!;
    const avatar = slot.children[0], image = avatar.querySelector("img")!;
    const grid = card.querySelector(".contribution-grid")!;
    expect(image.getAttribute("src")).toBe(photoUrl);
    grid.children[1].focus();
    updateProfileCard(card, { ...data, stats: { ...data.stats, totalActions: 8 } });
    expect(slot.children[0]).toBe(avatar); expect(avatar.querySelector("img")).toBe(image);
    expect(document.activeElement).toBe(grid.children[1] as any);
    updateProfileCard(card, { ...data, profile: { ...data.profile, photo: null } });
    expect(slot.querySelector("img")).toBeNull();
    expect(slot.children[0].getAttribute("data-state")).toBe("empty");
    expect(card.querySelector(".contribution-grid")).toBe(grid);
    const draftPhoto = "data:image/png;base64,aGVsbG8=";
    updateProfileCard(card, { ...data, profile: { ...data.profile, photo: draftPhoto } });
    expect(slot.querySelector("img")!.getAttribute("src")).toBe(draftPhoto);
    expect(document.activeElement).toBe(grid.children[1] as any);
  });

  test("renders canonical product/service identities and only safe projected fields", () => {
    const card = profileCard(sample) as unknown as Element;
    expect(card.textContent).not.toContain("Codex"); expect(card.textContent).toContain("GitHub activity");
    expect(card.textContent).not.toContain("Agent reported"); expect(card.textContent).toContain("In progress");
    expect(all(card).some(node => node.getAttribute("role") === "img" && node.getAttribute("aria-label") === "Codex")).toBe(true);
    expect(card.querySelector("[data-public-event]")!.getAttribute("aria-description")).toContain("Agent-reported activity");
    for (const privateText of ["private laptop alias", "private task title", "private.example"]) {
      expect(card.textContent).not.toContain(privateText);
      expect(JSON.stringify(all(card).map(node => ({ attrs: node.attrs, dataset: node.dataset })))).not.toContain(privateText);
    }
    expect(all(card).some(node => node.attrs["data-brand"] === "codex")).toBe(true);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(1);
  });

  test("off and empty states never display event rows, and disabling removes existing content", () => {
    const card = profileCard({ ...sample, activity: { enabled: false, events: [event] } }) as unknown as Element;
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0); expect(card.textContent).toContain("Activity streaming is off");
    updateProfileCard(card, sample); expect(card.querySelectorAll("[data-public-event]")).toHaveLength(1);
    updateProfileCard(card, { ...sample, activity: { enabled: false, events: [event] } });
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0);
    updateProfileCard(card, { ...sample, activity: { enabled: true, events: [] } });
    expect(card.textContent).toContain("A quiet moment.");
  });

  test("stream changes reuse keyed rows and preserve disclosure, chart selection and keyboard focus", () => {
    const card = profileCard(sample) as unknown as Element;
    const row = card.querySelector("[data-public-event]"), grid = card.querySelector(".contribution-grid")!;
    const history = card.querySelector(".profile-history")!; history.open = true;
    const receipts = card.querySelector(".profile-receipts")!; receipts.open = true;
    const viewport = card.querySelector(".contribution-viewport")!; viewport.scrollLeft = 144;
    grid.children[1].focus();
    const changed = { ...sample, activity: { enabled: true, events: [{ ...event, id: "b".repeat(32), status: "running" }, { ...event, status: "completed" }] } };
    updateProfileCard(card, changed);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(2);
    expect(card.querySelector('[data-public-events="recent"]')!.children[0]).toBe(row);
    expect(card.querySelector(".contribution-grid")).toBe(grid); expect(document.activeElement).toBe(grid.children[1] as any);
    expect(card.querySelector(".contribution-viewport")).toBe(viewport); expect(viewport.scrollLeft).toBe(144);
    expect(grid.dataset.selectedDate).toBe("2026-10-24"); expect(history.open).toBe(true); expect(receipts.open).toBe(true);
    updateProfileCard(card, changed);
    expect(card.querySelector('[data-public-events="recent"]')!.children[0]).toBe(row);
  });

  test("the scrollable chart keeps axes together and preserves roving date exploration", () => {
    const days = Array.from({ length: 21 }, (_, index) => ({ date: new Date(Date.UTC(2026, 9, index + 1)).toISOString().slice(0, 10), count: index }));
    const chart = contributionGrid(days) as unknown as Element;
    const viewport = chart.querySelector(".contribution-viewport")!;
    const composition = viewport.querySelector(".contribution-chart")!;
    const grid = composition.querySelector(".contribution-grid")!;
    expect(composition.querySelector(".contribution-months")!.children).toHaveLength(3);
    expect(composition.querySelector(".contribution-weekdays")!.children).toHaveLength(7);
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("aria-label")).toContain("Swipe or use arrow keys");
    expect(viewport.querySelector(".contribution-caption")).toBeNull();
    expect(chart.querySelector(".contribution-explore")!.textContent).toContain("Swipe or use arrow keys");
    const key = (value: string) => {
      let prevented = false;
      grid.events.keydown({ key: value, preventDefault: () => { prevented = true; } });
      expect(prevented).toBe(true);
      expect(grid.children.filter(cell => cell.tabIndex === 0)).toHaveLength(1);
    };
    grid.children[20].focus();
    key("ArrowLeft"); expect(document.activeElement).toBe(grid.children[13] as any);
    key("ArrowUp"); expect(document.activeElement).toBe(grid.children[12] as any);
    key("Home"); expect(document.activeElement).toBe(grid.children[0] as any);
    key("ArrowUp"); expect(document.activeElement).toBe(grid.children[0] as any);
    key("End"); expect(document.activeElement).toBe(grid.children[20] as any);
    expect(chart.querySelector(".contribution-caption")!.textContent).toContain("20 actions");
    expect(grid.dataset.selectedDate).toBe("2026-10-21");
  });

  test("chart date-range rollover retains the explored date without stealing focus", () => {
    const card = profileCard(sample) as unknown as Element;
    card.querySelector(".contribution-grid")!.children[1].focus();
    const outside = new Element("button"); outside.focus();
    updateProfileCard(card, { ...sample, daily: [{ date: "2026-10-22", count: 0 }, ...daily] });
    const grid = card.querySelector(".contribution-grid")!;
    expect(grid.dataset.selectedDate).toBe("2026-10-24"); expect(grid.children[2].tabIndex).toBe(0);
    expect(document.activeElement).toBe(outside as any); expect(card.querySelector(".contribution-caption")!.textContent).toContain("2 actions");
  });

  test("timestamps age quietly and stale reports have an explicit state", () => {
    const card = profileCard({ ...sample, activity: { enabled: true, events: [{ ...event, status: "stale", evidence: "observed" }] } }) as unknown as Element;
    updateProfileTimes(card, Date.parse(event.updatedAt) + 120_000);
    expect(card.textContent).toContain("Update overdue"); expect(card.textContent).not.toContain("Observed by Engram");
    expect(card.querySelector("[data-public-event]")!.getAttribute("aria-description")).toBe("Observed by Engram");
    expect(card.querySelector("[data-public-time]")!.textContent).toBe("2 minutes ago");
  });

  test("both layouts have a distinct reading order and real empty states", () => {
    const studio = profileCard(sample) as unknown as Element;
    expect(studio.dataset.profileLayout).toBe("studio");
    expect(studio.querySelector(".profile-main")!.children[0].className).toBe("profile-desk");
    const notes = profileCard({ ...sample, profile: { ...sample.profile, layout: "field-notes", highlights: [] }, activity: { enabled: false, events: [event] } }) as unknown as Element;
    expect(notes.dataset.profileLayout).toBe("field-notes");
    expect(notes.querySelector(".profile-main")!.children[0]).toBe(notes.querySelector(".profile-highlights"));
    expect(notes.querySelector(".profile-highlights")!.dataset.empty).toBe("true");
    expect(notes.textContent).toContain("Nothing pinned here yet.");
    expect(notes.textContent).toContain("Some work stays behind the scenes.");
    expect(notes.querySelectorAll("[data-public-event]")).toHaveLength(0);
    expect(notes.querySelectorAll("[data-stage-event]")).toHaveLength(0);
    for (const card of [studio, notes]) {
      const overview = card.querySelector(".profile-overview")!;
      expect(overview.parentElement).toBe(card.querySelector(".profile-main"));
      expect(overview.closest("details")).toBeNull();
      expect(overview.querySelector(".profile-statistics")).not.toBeNull();
      expect(overview.querySelector(".contribution-grid")).not.toBeNull();
    }
    const quiet = profileCard({ ...sample, tools: [], activity: { enabled: true, events: [] } }) as unknown as Element;
    expect(quiet.textContent).toContain("No action counts yet.");
    expect(quiet.textContent).toContain("A quiet moment.");
    expect(profileCard({ ...sample, profile: { ...sample.profile, layout: "unknown" } }).dataset.profileLayout).toBe("studio");
  });

  test("owner highlights are bounded text DOM and safe public links independent of activity sharing", () => {
    const highlights = [
      { title: '<img src=x onerror="alert(1)">', body: "<script>not executable</script>", url: "https://example.com/work?q=public" },
      { title: "A note", body: "No imported task text.", url: "javascript:alert(1)" },
      { title: "A third note", body: "", url: "https://user:secret@example.com/private" },
      { title: "Beyond the limit", body: "", url: "https://example.com/extra" },
    ];
    for (const layout of ["studio", "field-notes"]) {
      const card = profileCard({ ...sample, profile: { ...sample.profile, layout, highlights }, activity: { enabled: false, events: [event] } }) as unknown as Element;
      expect(card.querySelectorAll("[data-profile-highlight]")).toHaveLength(3);
      expect(card.textContent).toContain(highlights[0].title);
      expect(card.textContent).toContain(highlights[0].body);
      expect(card.textContent).not.toContain("Beyond the limit");
      expect(card.querySelectorAll("script")).toHaveLength(0);
      expect(card.querySelectorAll("img")).toHaveLength(0);
      const links = card.querySelectorAll(".profile-highlight-link");
      expect(links[0].getAttribute("href")).toBe(highlights[0].url);
      expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
      expect(links[1].getAttribute("href")).toBeNull(); expect(links[2].getAttribute("href")).toBeNull();
      expect(card.querySelector(".profile-footnote")!.textContent).toContain("Highlights are chosen by the owner");
      expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0);
      expect(card.querySelectorAll("[data-stage-event]")).toHaveLength(0);
    }
  });

  test("the desk shows at most two fresh safe running actions and keeps the complete recent receipts", () => {
    const events = [0, 1, 2].map(index => ({ ...event, id: String(index).repeat(32) }));
    events.push({ ...event, id: "old".repeat(10), updatedAt: "2026-10-25T09:40:00Z" });
    events.push({ ...event, id: "done".repeat(8), status: "completed" });
    const data = { ...sample, live: { ...sample.live, checkedAt: "2026-10-25T10:05:00Z", freshnessSeconds: 900 }, activity: { enabled: true, events } };
    const card = profileCard(data) as unknown as Element;
    expect(card.querySelectorAll("[data-stage-event]")).toHaveLength(2);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(5);
    expect(card.querySelector(".profile-receipts")!.open).toBe(false);
    const stage = card.querySelector("[data-stage-event]");
    const status = stage!.querySelector(".ds-status-text"), mark = stage!.querySelector('[role="img"]');
    updateProfileCard(card, data);
    expect(card.querySelector("[data-stage-event]")).toBe(stage);
    expect(stage!.querySelector(".ds-status-text")).toBe(status);
    expect(stage!.querySelector('[role="img"]')).toBe(mark);
    expect(status!.getAttribute("data-active")).toBe("true");
    updateProfileCard(card, { ...data, live: { ...data.live, checkedAt: "2026-10-25T10:16:00Z" } });
    expect(card.querySelectorAll("[data-stage-event]")).toHaveLength(0);
    expect(card.querySelector(".profile-desk-state")!.hidden).toBe(false);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(5);
    updateProfileCard(card, { ...data, activity: { enabled: false, events } });
    expect(card.querySelectorAll("[data-stage-event]")).toHaveLength(0);
    expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0);
  });

  test("only fresh running labels shimmer and expire without a new snapshot", () => {
    const receivedAt = Date.now();
    const data = { ...sample, live: { ...sample.live, checkedAt: "2026-10-25T10:05:00Z", freshnessSeconds: 900 }, activity: { enabled: true, events: [
      event,
      { ...event, id: "old", updatedAt: "2026-10-25T09:40:00Z" },
      ...["completed", "failed", "stale"].map(status => ({ ...event, id: status, status })),
    ] } };
    const card = profileCard(data) as unknown as Element;
    const receipt = (id: string) => card.querySelector(`[data-public-event="${id}"]`)!.querySelector(".ds-status-text")!;
    expect(receipt(event.id).getAttribute("data-active")).toBe("true");
    for (const id of ["old", "completed", "failed", "stale"]) expect(receipt(id).getAttribute("data-active")).toBe("false");
    const label = receipt(event.id);
    updateProfileTimes(card, receivedAt + 11 * 60_000);
    expect(receipt(event.id)).toBe(label);
    expect(label.getAttribute("data-active")).toBe("false");
    expect(card.querySelector("[data-stage-event]")!.querySelector(".ds-status-text")!.getAttribute("data-active")).toBe("false");
    updateProfileCard(card, { ...data, live: { ...data.live, checkedAt: "2026-10-25T10:16:00Z" }, activity: { enabled: true, events: [{ ...event, updatedAt: "2026-10-25T10:16:00Z" }] } });
    expect(receipt(event.id).getAttribute("data-active")).toBe("true");
    expect(card.textContent).not.toContain("Codex");
    expect(card.querySelector("[data-stage-event]")!.getAttribute("aria-description")).toContain("Agent-reported activity");
  });

  test("repeated snapshots preserve freshness deadlines and update accessible provenance", () => {
    const checkedAt = "2026-10-25T10:05:00Z", receivedAt = Date.parse(checkedAt) + 2 * 3_600_000;
    const clock = spyOn(Date, "now").mockReturnValue(receivedAt);
    try {
      const data = { ...sample, live: { ...sample.live, checkedAt, freshnessSeconds: 900 } };
      const card = profileCard(data) as unknown as Element;
      clock.mockReturnValue(receivedAt + 6 * 60_000);
      updateProfileCard(card, data);
      expect(card.querySelector("[data-stage-event]")!.querySelector(".ds-status-text")!.getAttribute("data-active")).toBe("true");
      clock.mockReturnValue(receivedAt + 11 * 60_000);
      updateProfileCard(card, data);
      for (const selector of ["[data-stage-event]", "[data-public-event]"]) {
        expect(card.querySelector(selector)!.querySelector(".ds-status-text")!.getAttribute("data-active")).toBe("false");
      }
      updateProfileCard(card, { ...data, live: { ...data.live, checkedAt: "2026-10-25T10:16:00Z" }, activity: { enabled: true, events: [{ ...event, updatedAt: "2026-10-25T10:16:00Z", evidence: "observed" }] } });
      for (const selector of ["[data-stage-event]", "[data-public-event]"]) {
        expect(card.querySelector(selector)!.getAttribute("aria-description")).toBe("Observed by Engram");
        expect(card.querySelector(selector)!.getAttribute("title")).toBe("Observed by Engram");
      }
    } finally { clock.mockRestore(); }
  });

  test("the visible overview combines all-time totals with the full supplied twelve-week grid", () => {
    const days = Array.from({ length: 84 }, (_, index) => ({ date: new Date(Date.UTC(2026, 6, index + 1)).toISOString().slice(0, 10), count: index % 4 }));
    const stats = { totalActions: 1234, activeAgents: 9, activeDays: 104 };
    const card = profileCard({ ...sample, stats, daily: days }) as unknown as Element;
    const overview = card.querySelector(".profile-overview")!;
    expect(overview.classList.contains("ds-card")).toBe(true);
    expect(overview.parentElement).toBe(card.querySelector(".profile-main"));
    expect(overview.closest("details")).toBeNull();
    expect(card.querySelector(".profile-weekly")).toBeNull();
    const history = card.querySelector(".profile-history")!;
    expect(history.querySelector(".profile-statistics")).toBeNull();
    expect(history.querySelector(".contributions")).toBeNull();
    expect(history.querySelector(".profile-tools")).not.toBeNull();
    expect(card.textContent).not.toContain("A little momentum.");
    const totals = overview.querySelector(".profile-statistics")!;
    expect(totals.getAttribute("aria-label")).toBe("All-time activity totals");
    expect(totals.querySelector('[data-public-stat="totalActions"]')!.textContent).toBe("1,234");
    expect(totals.querySelector('[data-public-stat="activeAgents"]')!.textContent).toBe("9");
    expect(totals.querySelector('[data-public-stat="activeDays"]')!.textContent).toBe("104");
    expect(totals.textContent).toContain("Actions"); expect(totals.textContent).toContain("Agents"); expect(totals.textContent).toContain("Active days");
    const chart = overview.querySelector(".contributions")!, grid = chart.querySelector(".contribution-grid")!;
    expect(chart.closest("details")).toBeNull();
    expect(chart.textContent).toContain("Last 12 weeks");
    expect(grid.children).toHaveLength(84);
    expect(grid.children[0].dataset.date).toBe(days[0].date);
    expect(grid.children[83].dataset.date).toBe(days[83].date);
    expect(overview.querySelector(".profile-tools")).toBeNull();

    const cells = [...grid.children], viewport = overview.querySelector(".contribution-viewport")!;
    cells[10].focus(); viewport.scrollLeft = 160;
    const changed = days.map((day, index) => index === 10 ? { ...day, count: 20 } : day);
    updateProfileCard(card, { ...sample, stats: { totalActions: 1252, activeAgents: 10, activeDays: 105 }, daily: changed });
    expect(card.querySelector(".profile-overview")).toBe(overview);
    expect(card.querySelector(".contribution-grid")).toBe(grid);
    expect(grid.children.every((cell, index) => cell === cells[index])).toBe(true);
    expect(document.activeElement).toBe(cells[10] as any);
    expect(grid.dataset.selectedDate).toBe(days[10].date);
    expect(grid.children.filter(cell => cell.tabIndex === 0)).toHaveLength(1);
    expect(viewport.scrollLeft).toBe(160);
    expect(chart.querySelector(".contribution-caption")!.textContent).toContain("20 actions");
    expect(totals.querySelector('[data-public-stat="totalActions"]')!.textContent).toBe("1,252");
    expect(totals.querySelector('[data-public-stat="activeAgents"]')!.textContent).toBe("10");
    expect(totals.querySelector('[data-public-stat="activeDays"]')!.textContent).toBe("105");
  });

  test("aggregate-only and zero-activity profiles keep the overview visible without sample activity", () => {
    for (const layout of ["studio", "field-notes"]) {
      const card = profileCard({ ...sample, profile: { ...sample.profile, layout }, activity: { enabled: false, events: [event] } }) as unknown as Element;
      const overview = card.querySelector(".profile-overview")!;
      expect(overview.closest("details")).toBeNull();
      expect(overview.querySelector('[data-public-stat="totalActions"]')!.textContent).toBe("6");
      expect(overview.querySelector(".contribution-grid")!.children).toHaveLength(daily.length);
      expect(card.querySelectorAll("[data-public-event]")).toHaveLength(0);
      expect(card.querySelectorAll("[data-stage-event]")).toHaveLength(0);

      updateProfileCard(card, { ...sample, profile: { ...sample.profile, layout }, stats: { totalActions: 0, activeAgents: 0, activeDays: 0 }, daily: [], tools: [], activity: { enabled: false, events: [] } });
      expect(card.querySelector(".profile-overview")).toBe(overview);
      for (const key of ["totalActions", "activeAgents", "activeDays"]) expect(overview.querySelector(`[data-public-stat="${key}"]`)!.textContent).toBe("0");
      expect(overview.querySelector(".contribution-grid")!.children).toHaveLength(0);
      expect(overview.querySelector(".contribution-caption")!.textContent).toContain("0 actions");
      expect(overview.hidden).toBe(false);
      expect(overview.closest("details")).toBeNull();
    }
  });

  test("switching layouts and updating highlights retains native disclosures, selected dates and focus", () => {
    const highlights = [{ title: "A deliberately public note", body: "An owner-approved sentence. ".repeat(10), url: "https://example.com/first" }];
    const card = profileCard({ ...sample, profile: { ...sample.profile, highlights } }) as unknown as Element;
    const highlight = card.querySelector("[data-profile-highlight]")!, note = highlight.querySelector(".ds-highlight-disclosure")!;
    const history = card.querySelector(".profile-history")!;
    const receipts = card.querySelector(".profile-receipts")!;
    note.open = true; history.open = true; receipts.open = true;
    const chart = card.querySelector(".contribution-grid")!, viewport = card.querySelector(".contribution-viewport")!;
    chart.children[1].focus(); viewport.scrollLeft = 144;
    const selectedCell = chart.children[1], overview = card.querySelector(".profile-overview")!;
    const changed = { ...sample, profile: { ...sample.profile, layout: "field-notes", highlights: [{ ...highlights[0], title: "A revised public note", body: highlights[0].body + "Updated.", url: "" }] } };
    updateProfileCard(card, changed);
    expect(card.querySelector(".profile-main")!.children[0]).toBe(card.querySelector(".profile-highlights"));
    expect(card.querySelector("[data-profile-highlight]")).toBe(highlight);
    expect(note.open).toBe(true); expect(history.open).toBe(true); expect(receipts.open).toBe(true);
    expect(card.querySelector(".contribution-grid")).toBe(chart); expect(chart.dataset.selectedDate).toBe("2026-10-24");
    expect(viewport.scrollLeft).toBe(144); expect(document.activeElement).toBe(selectedCell as any);
    expect(card.querySelector(".profile-overview")).toBe(overview); expect(overview.closest("details")).toBeNull();
    expect(highlight.querySelector(".profile-highlight-link")!.getAttribute("href")).toBeNull();
    expect(highlight.textContent).toContain("A revised public note");
    const outside = new Element("button"); outside.setAttribute("data-date", "2026-10-24"); outside.focus();
    updateProfileCard(card, { ...changed, daily: [{ date: "2026-10-22", count: 0 }, ...daily] });
    expect(document.activeElement).toBe(outside as any);
    expect(card.querySelector(".contribution-viewport")!.scrollLeft).toBe(144);
  });

  test("removed dates and owner notes leave keyboard focus on an available part of the profile", () => {
    const highlights = [{ title: "A public note", body: "A long note. ".repeat(20), url: "" }];
    const card = profileCard({ ...sample, profile: { ...sample.profile, layout: "field-notes", highlights } }) as unknown as Element;
    const highlightHeading = card.querySelector(".profile-highlights")!.querySelector("h2")!;
    highlightHeading.removeAttribute("tabindex");
    card.querySelector(".ds-highlight-disclosure")!.querySelector("summary")!.focus();
    updateProfileCard(card, { ...sample, profile: { ...sample.profile, layout: "field-notes", highlights: [] } });
    expect(document.activeElement).toBe(highlightHeading as any);
    expect(highlightHeading.getAttribute("tabindex")).toBe("-1");
    card.querySelector(".contribution-grid")!.children[0].focus();
    updateProfileCard(card, { ...sample, daily: daily.slice(1) });
    expect(document.activeElement).toBe(card.querySelector(".contribution-grid")!.children[1] as any);
    card.querySelector(".contribution-grid")!.children[0].focus();
    updateProfileCard(card, { ...sample, daily: daily.slice(2) });
    expect(document.activeElement).toBe(card.querySelector(".contribution-grid")!.children[0] as any);
    const studio = profileCard({ ...sample, profile: { ...sample.profile, highlights } }) as unknown as Element;
    studio.querySelector(".ds-highlight-disclosure")!.querySelector("summary")!.focus();
    updateProfileCard(studio, sample);
    expect(document.activeElement).toBe(studio.querySelector(".profile-category-summary")!.querySelector("h2") as any);
  });
});
