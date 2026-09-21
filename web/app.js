import { api, AuthError } from "./api.js";
import { inkColor, inkStepFor } from "./ink.js";
import { renderMarkdown } from "./markdown.js";
import { inkGlyph, relativeDate, renderLinks, renderTimeline, pulse, sealImg } from "./mechanics.js";
import { renderGraph } from "./graph.js";
import { agentMark } from "./agents.js";
const app = document.getElementById("app");
const refs = {};
const state = {
  session: null,
  items: [],
  scopes: [],
  query: "",
  selected: 0,
  loading: false,
  pane: null,
  activeRow: null,
  captureOpen: false,
  captureText: "",
  captureError: "",
  keyHelp: false,
  message: "",
  undo: null,
  more: false,
  loadingMore: false,
  view: "collection",
  active: new Map(),
  graph: null,
  graphError: "",
  graphController: null,
  now: new Date(),
};

// One window of rows. Small enough that the first screen arrives quickly, large
// enough that scrolling does not fetch constantly.
const PAGE_SIZE = 40;

bootstrap();
document.addEventListener("keydown", onKeydown);

async function bootstrap() {
  showLoading("Reading the gate");
  try {
    state.session = await api.me();
    showConsole();
    await loadCollection();
  } catch (error) {
    if (error instanceof AuthError) showLogin();
    else showLogin("The server did not answer.");
  }
}

// Boot splash: a quiet pulse while we ask the gateway who this browser is.
function showLoading(label) {
  app.className = "login-screen";
  app.replaceChildren(
    h("main", { class: "login-scroll" },
      h("div", { class: "inline-loading", role: "status" }, pulse(), h("span", {}, label)),
    ),
  );
}

function showLogin(message = "") {
  app.className = "login-screen";
  const input = h("input", {
    type: "password",
    name: "token",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Access token",
    required: true,
  });
  const form = h("form", {
    class: "login-form",
    onsubmit: async event => {
      event.preventDefault();
      try {
        state.session = await api.login(input.value);
        showConsole();
        await loadCollection();
      } catch (error) {
        showLogin(error instanceof AuthError ? "That token was not recognised." : "The gate did not answer.");
      }
    },
  },
    sealImg("engram", 82, "engram mark"),
    h("h1", {}, "engram"),
    // Restraint is the aesthetic, but a screen that does not say what it wants
    // is not restrained, it is unusable. These three lines are the floor.
    h("p", { class: "login-blurb" }, "Shared memory for your agents. One brain, every surface."),
    h("label", { class: "field-label" },
      h("span", {}, "paste an engram token"),
      input),
    h("p", { class: "login-hint" }, "Mint one with: engram-admin token issue --name <agent>"),
    h("button", { type: "submit", class: "login-submit" }, "enter"),
    h("p", { class: "login-error", role: "status" }, message),
  );
  app.replaceChildren(h("main", { class: "login-scroll" }, form));
  input.focus();
}

function showConsole() {
  app.className = "console-shell";
  refs.search = h("input", {
    id: "search",
    type: "search",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "search",
    "aria-label": "Search memory",
    oninput: event => {
      state.query = event.currentTarget.value;
      if (clearUndoNotice()) renderList();
      window.clearTimeout(refs.searchTimer);
      refs.searchTimer = window.setTimeout(loadCollection, 140);
    },
  });
  refs.count = h("p", { class: "result-count", "aria-live": "polite" });
  // The ink fade is meaningless to anyone who was not told what it encodes.
  refs.viewToggle = h("div", { class: "view-toggle", role: "group", "aria-label": "View" });
  refs.legend = h("p", { class: "collection-legend" },
    h("span", {}, "weight follows recency"),
    h("span", { class: "legend-keys" }, "/ search · j k move · enter open · c write · ? keys"),
  );
  refs.list = h("section", { class: "ink-list", role: "listbox", "aria-label": "Memory pages" });
  refs.capture = h("div", { class: "capture-host" });
  refs.keyHelp = h("div", { class: "key-help-host" });
  refs.paneHost = h("div", { class: "pane-host" });

  const rail = h("aside", { class: "left-rail", "aria-label": "Sections" },
    sealImg(state.session?.name || "engram", 40, "session mark"),
    h("h1", { class: "rail-title" }, "engram"),
    labelBlock("collection"),
    labelBlock("search"),
    labelBlock("memory"),
    h("div", { class: "rail-foot" },
      h("span", {}, state.session?.name || "guest"),
      h("button", { type: "button", class: "text-button", onclick: logout }, "leave"),
    ),
  );

  window.addEventListener("scroll", maybeLoadMore, { passive: true });
  window.addEventListener("resize", maybeLoadMore, { passive: true });

  const main = h("main", { class: "scroll-column" },
    refs.viewToggle,
    refs.capture,
    h("section", { class: "search-field", "aria-label": "Search" },
      h("label", { for: "search", class: "visually-hidden" }, "search"),
      refs.search,
    ),
    refs.count,
    refs.legend,
    refs.keyHelp,
    refs.list,
  );
  app.replaceChildren(rail, main, refs.paneHost);
  renderChrome();
  startActivityPolling();
  renderCapture();
  renderKeyHelp();
}

async function loadCollection() {
  clearUndoNotice();
  state.loading = true;
  renderList();
  try {
    if (state.query.trim()) {
      const data = await api.search({ q: state.query.trim(), limit: PAGE_SIZE });
      state.items = data.results ?? [];
      // Search returns what it found; there is no second page to ask for.
      state.more = false;
    } else {
      const data = await api.pages({ limit: PAGE_SIZE, offset: 0, sort: "updated_desc" });
      state.items = data.pages ?? [];
      state.scopes = data.scopes ?? [];
      state.more = data.more === true;
    }
    state.selected = Math.min(state.selected, Math.max(0, state.items.length - 1));
    state.message = "";
  } catch (error) {
    return handleError(error);
  } finally {
    state.loading = false;
    renderList();
  }
}

// Called when the sentinel below the last row comes into view. Guarded on both
// flags because the observer fires again while the request is still open.
async function loadMore() {
  if (!state.more || state.loadingMore || state.loading || state.query.trim()) return;
  state.loadingMore = true;
  try {
    const data = await api.pages({
      limit: PAGE_SIZE,
      offset: state.items.length,
      sort: "updated_desc",
    });
    const next = data.pages ?? [];
    // Re-fetching a window whose rows moved could repeat one. Keyed by slug so a
    // row can never appear twice in the list.
    const seen = new Set(state.items.map(item => item.slug));
    state.items = state.items.concat(next.filter(item => !seen.has(item.slug)));
    state.more = data.more === true && next.length > 0;
  } catch (error) {
    state.more = false;
    state.message = "could not load more";
  } finally {
    state.loadingMore = false;
    renderList();
  }
}

// How often the console asks what is in use. Slow enough to be free, quick enough
// that a memory being read still looks live when you glance at the screen.
const ACTIVITY_POLL_MS = 8000;

async function pollActivity() {
  // A hidden tab has nobody looking at it, so stop asking.
  if (document.hidden || !state.session) return;
  try {
    const data = await api.activity({ window: 90 });
    const next = new Map((data.active ?? []).map(entry => [entry.slug, entry]));
    // Re-render only when the set actually changed, or the list would rebuild every
    // eight seconds and drop the reader's selection for nothing.
    const changed = next.size !== state.active.size
      || [...next.keys()].some(slug => !state.active.has(slug));
    state.active = next;
    if (changed && state.view === "collection") renderList();
  } catch {
    // Live decoration: a failure shows nothing moving, which is the honest default.
  }
}

function startActivityPolling() {
  pollActivity();
  window.setInterval(pollActivity, ACTIVITY_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollActivity();
  });
}

async function switchView(next) {
  if (state.view === next) return;
  state.view = next;
  if (state.graphController) {
    state.graphController.destroy();
    state.graphController = null;
  }
  renderChrome();
  renderList();
  if (next === "graph" && !state.graph) await loadGraph();
}

async function loadGraph() {
  state.graphError = "";
  renderList();
  try {
    state.graph = await api.graph();
  } catch (error) {
    if (error instanceof AuthError) return handleError(error);
    state.graphError = "could not load the graph";
  }
  renderList();
}

function renderChrome() {
  if (!refs.viewToggle) return;
  refs.viewToggle.replaceChildren(
    ...[["collection", "collection"], ["graph", "graph"]].map(([id, label]) => h("button", {
      type: "button",
      class: `chip${state.view === id ? " is-on" : ""}`,
      "aria-pressed": state.view === id ? "true" : "false",
      onclick: () => switchView(id),
    }, label)),
  );
}

function renderGraphCard() {
  if (state.graphError) {
    return h("section", { class: "card graph-card" },
      h("div", { class: "card-bar" }, h("span", {}, "graph"), h("span", { class: "card-bar-count" }, "error")),
      h("p", { class: "graph-empty" }, state.graphError),
    );
  }
  if (!state.graph) {
    return h("section", { class: "card graph-card" },
      h("div", { class: "card-bar" }, h("span", {}, "graph"), h("span", { class: "card-bar-count" }, "loading")),
      h("div", { class: "graph-empty" }, pulse(), h("span", {}, "reading every page for its links")),
    );
  }

  const { nodes, edges, truncated } = state.graph;
  const canvas = h("canvas", {
    class: "graph-canvas",
    role: "img",
    "aria-label": `${nodes.length} pages, ${edges.length} links between them. The collection view lists the same pages as text.`,
  });
  const card = h("section", { class: "card graph-card" },
    h("div", { class: "card-bar" },
      h("span", {}, "graph"),
      h("span", { class: "card-bar-count" },
        `${nodes.length} nodes · ${edges.length} links${truncated ? " · capped" : ""}`),
    ),
    canvas,
    h("p", { class: "graph-hint" }, "drag to pan · scroll to zoom · click a node to open it"),
  );

  // The canvas has to be in the document and sized before the layout can solve
  // against its real dimensions, so this waits a tick rather than measuring zero.
  queueMicrotask(() => {
    if (!canvas.isConnected) return;
    state.graphController = renderGraph(canvas, { nodes, edges }, {
      onSelect: node => openItem({ slug: node.slug, title: node.title }, null),
    });
  });
  return card;
}

function renderList() {
  if (!refs.list) return;
  refs.list.replaceChildren();
  const noun = state.items.length === 1 ? "page" : "pages";
  renderResultCount(noun);
  if (state.view === "graph") {
    refs.list.append(renderGraphCard());
    return;
  }
  if (state.loading) {
    refs.list.append(h("div", { class: "inline-loading", role: "status" }, pulse(), h("span", {}, "loading")));
    return;
  }
  if (state.items.length === 0) {
    refs.list.append(renderEmpty());
    return;
  }

  const card = h("section", { class: "card collection" },
    h("div", { class: "card-bar" },
      h("span", {}, state.query.trim() ? "results" : "collection"),
      h("span", { class: "card-bar-count" }, `${state.items.length}${state.more ? "+" : ""} ${noun}`),
    ),
    // Column names are for sighted scanning; the rows are buttons with their own
    // labels, so a screen reader is told to skip this strip rather than read it
    // as content between every row.
    h("div", { class: "table-head", "aria-hidden": "true" },
      h("span", {}, "page"),
      h("span", {}, "origin"),
      h("span", {}, "contributors"),
      h("span", {}, "updated"),
    ),
  );
  state.items.forEach((item, index) => card.append(renderRow(item, index)));
  refs.list.append(card);
  // Attach first, observe second. An IntersectionObserver given a target that is
  // not yet in the document has nothing to intersect with and never fires.
  if (state.more) {
    card.append(renderSentinel());
    // The first window may not fill the viewport, in which case the reader has
    // nothing to scroll and the next one has to be asked for immediately.
    maybeLoadMore();
  }
}

function renderRow(item, index) {
  const step = inkStepFor(item.updated_at, state.now);
  const selected = index === state.selected;
  const provenance = item.provenance || { origin: null, contributors: [] };
  const live = state.active.get(item.slug);
  const row = h("button", {
    type: "button",
    class: `ink-row${selected ? " is-selected" : ""}${live ? " is-live" : ""}`,
    role: "option",
    "aria-selected": selected ? "true" : "false",
    "data-index": index,
    onclick: event => openItem(item, event.currentTarget),
  },
    h("span", { class: "cell cell-page" },
      h("span", { class: "row-title", style: { color: inkColor(step) } }, item.title || item.slug),
      h("span", { class: "row-slug" }, item.slug),
      live ? h("span", { class: "row-live" },
        agentMark(live.by, 13),
        h("span", {}, `${live.by} is ${live.tool === "remember" || live.tool === "put_page" ? "writing" : "reading"} this`),
      ) : "",
      item.snippet ? h("span", { class: "snippet" }, item.snippet) : "",
    ),
    h("span", { class: "cell cell-origin" }, originLabel(provenance)),
    h("span", { class: "cell cell-contributors" }, ...contributorLabels(provenance)),
    h("span", {
      class: "cell cell-updated",
      "aria-label": `updated ${relativeDate(item.updated_at, state.now)}`,
    }, `${inkGlyph(step)} ${relativeDate(item.updated_at, state.now)}`),
  );
  return row;
}

// A page whose writes all predate attribution has no recoverable author. Saying so
// is the honest answer; naming whoever touched it since would be a guess.
function originLabel(provenance) {
  if (!provenance.origin) return h("span", { class: "unrecorded" }, "unrecorded");
  return h("span", {}, `${provenance.origin.by} ${provenance.origin.at.slice(0, 10)}`);
}

function contributorLabels(provenance) {
  const all = provenance.contributors || [];
  if (!all.length) return [h("span", { class: "unrecorded" }, "none recorded")];
  const shown = all.slice(0, 2).map(who => h("span", {
    class: "who",
    title: `${who.name}: ${who.writes} ${who.writes === 1 ? "write" : "writes"}`,
  }, agentMark(who.name, 12), h("span", {}, who.name)));
  if (all.length > 2) shown.push(h("span", { class: "who-more" }, `+${all.length - 2}`));
  return shown;
}

// An observer rather than a scroll handler: it fires once when the row actually
// comes into view and costs nothing while it has not. The margin asks early enough
// that the next window usually lands before the reader reaches the end.
function renderSentinel() {
  return h("div", { class: "row-sentinel", role: "status" }, pulse(), h("span", {}, "loading more"));
}

// Deliberately not an IntersectionObserver. Its callbacks are delivered by the
// rendering loop, which a browser throttles in a tab it considers hidden, so the
// next window would silently never load. This repo already learned that lesson
// about requestAnimationFrame when the reader pane would not open. Measuring on a
// real scroll event answers the same question and cannot be throttled away.
const LOAD_AHEAD = 500;

function maybeLoadMore() {
  if (!state.more || state.loadingMore || state.loading || state.query.trim()) return;
  const sentinel = refs.list?.querySelector(".row-sentinel");
  if (!sentinel) return;
  if (sentinel.getBoundingClientRect().top < window.innerHeight + LOAD_AHEAD) loadMore();
}

async function openItem(item, invoker) {
  const rerendered = clearUndoNotice();
  if (rerendered) renderList();
  const liveIndex = state.items.findIndex(row => row.slug === item.slug);
  state.activeRow = (rerendered && liveIndex >= 0 ? rowAt(liveIndex) : null) ?? invoker ?? document.activeElement;
  state.pane = { loading: true, item };
  renderPane();
  try {
    const data = await api.page({ slug: item.slug, scope: item.scope });
    state.pane = { loading: false, ...data };
    renderPane();
    requestAnimationFrame(() => refs.paneHost.querySelector(".reader-pane")?.focus());
  } catch (error) {
    handleError(error);
  }
}

function renderPane() {
  refs.paneHost.replaceChildren();
  if (!state.pane) return;
  const pane = h("aside", {
    class: "reader-pane",
    tabindex: "-1",
    "aria-label": "Memory reader",
  });
  const close = h("button", { type: "button", class: "pane-close", onclick: closePane, "aria-label": "Close reader" }, "close");
  const actions = h("div", { class: "pane-actions" }, close);
  pane.append(actions);
  if (state.pane.loading) {
    pane.append(h("div", { class: "pane-loading" }, pulse(), h("span", {}, "loading")));
  } else {
    const page = state.pane.page;
    actions.append(h("button", { type: "button", class: "text-button pane-forget", onclick: forgetOpenPage }, "forget"));
    const body = h("article", { class: "reader-body" });
    body.append(renderMarkdown(page.body || ""));
    // A [[wikilink]] in the prose opens the same way a link in the links panel does.
    body.addEventListener("click", event => {
      const slug = event.target.closest?.(".wikilink")?.dataset.slug;
      if (!slug) return;
      event.preventDefault();
      openItem({ slug, title: slug, scope: page.scope }, state.activeRow);
    });
    pane.append(
      h("header", { class: "pane-head" },
        sealImg(page.source_id || page.scope || page.slug, 28, "source mark"),
        h("div", {}, h("p", { class: "pane-kicker" }, `${page.type || "page"} · ${relativeDate(page.updated_at, state.now)}`), h("h2", {}, page.title || page.slug)),
      ),
      renderLinks(page, state.pane.links ?? [], openItem),
      body,
      renderTimeline(state.pane.timeline ?? []),
    );
  }
  refs.paneHost.append(pane);
  // Reading layout flushes the closed state so the transition still runs, without
  // depending on rAF — a backgrounded tab throttles rAF and the pane would open
  // stuck off-screen, with its content unreachable.
  pane.getBoundingClientRect();
  pane.classList.add("is-open");
}

function closePane() {
  const pane = refs.paneHost.querySelector(".reader-pane");
  if (!pane) return;
  pane.classList.add("is-closing");
  window.setTimeout(() => {
    state.pane = null;
    refs.paneHost.replaceChildren();
    state.activeRow?.focus?.({ preventScroll: true });
  }, reducedMotion() ? 0 : 440);
}

function renderResultCount(noun) {
  refs.count.replaceChildren();
  if (state.loading) {
    refs.count.append("reading...");
    return;
  }

  refs.count.append(`${state.items.length} ${noun}`);
  if (state.undo) {
    refs.count.append(
      " · forgotten · ",
      h("button", {
        type: "button",
        class: "inline-undo",
        disabled: state.undo.pending || state.undo.restoring,
        onclick: undoForget,
      }, "undo"),
      " · recoverable for 72 hours",
    );
  } else if (state.message) {
    refs.count.append(` · ${state.message}`);
  }
}

async function forgetOpenPage() {
  const page = state.pane?.page;
  const slug = page?.slug;
  if (!slug) return;

  const index = state.items.findIndex(item => item.slug === slug);
  const item = index >= 0 ? state.items[index] : pageToItem(page);
  state.items = state.items.filter(row => row.slug !== slug);
  state.selected = Math.min(state.selected, Math.max(0, state.items.length - 1));
  state.message = "";
  state.undo = { slug, item, index: Math.max(0, index), pending: true, restoring: false };
  renderList();
  closePane();

  try {
    await api.forget(slug);
    if (state.undo?.slug === slug) {
      state.undo.pending = false;
      renderList();
    }
  } catch (error) {
    if (state.undo?.slug === slug) state.undo = null;
    restoreItem(item, index);
    handleError(error);
  }
}

async function undoForget() {
  const undo = state.undo;
  if (!undo || undo.pending || undo.restoring) return;

  undo.restoring = true;
  renderList();
  try {
    await api.restore(undo.slug);
    restoreItem(undo.item, undo.index);
    state.undo = null;
    renderList();
  } catch (error) {
    undo.restoring = false;
    handleError(error);
  }
}

function restoreItem(item, index) {
  if (!item?.slug || state.items.some(row => row.slug === item.slug)) return;
  const safeIndex = Math.max(0, Math.min(index, state.items.length));
  state.items.splice(safeIndex, 0, item);
  state.selected = safeIndex;
}

function pageToItem(page) {
  return {
    slug: page.slug,
    title: page.title || page.slug,
    type: page.type || "note",
    source_id: page.source_id || "default",
    scope: page.scope || "shared",
    updated_at: page.updated_at || "",
  };
}

function clearUndoNotice() {
  if (!state.undo) return false;
  state.undo = null;
  return true;
}

function renderCapture() {
  refs.capture.replaceChildren();
  if (!state.captureOpen) {
    refs.capture.append(h("button", { type: "button", class: "capture-tab", "aria-expanded": "false", title: "Write a note (c)", onclick: openCapture },
      h("span", { class: "tab-label" }, "write"),
      ));
    return;
  }
  const textarea = h("textarea", {
    rows: "7",
    placeholder: "write a memory",
    oninput: event => state.captureText = event.currentTarget.value,
    onkeydown: event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitCapture();
    },
  });
  textarea.value = state.captureText;
  const form = h("form", { class: "capture-panel", onsubmit: event => { event.preventDefault(); submitCapture(); } },
    textarea,
    h("div", { class: "capture-actions" },
      h("button", { type: "button", class: "text-button", onclick: collapseCapture }, "fold"),
      h("button", { type: "submit", class: "primary-action" }, "capture"),
    ),
    h("p", { class: "capture-error", role: "status" }, state.captureError),
  );
  refs.capture.append(form);
  requestAnimationFrame(() => textarea.focus());
}

async function submitCapture() {
  const text = state.captureText.trim();
  if (!text) return;
  try {
    const result = await api.capture({ text, slug: null, title: null });
    const panel = refs.capture.querySelector(".capture-panel");
    panel?.classList.add("is-folding");
    await wait(reducedMotion() ? 0 : 320);
    state.captureText = "";
    state.captureOpen = false;
    state.captureError = "";
    state.query = "";
    if (refs.search) refs.search.value = "";
    renderCapture();
    state.message = `captured ${result.slug}`;
    await loadCollection();
  } catch (error) {
    if (error instanceof AuthError) handleError(error);
    else {
      state.captureError = error.status === 403 ? "This token cannot write here." : "The ink would not take.";
      renderCapture();
    }
  }
}

function renderEmpty() {
  const hint = "Press c to write.";
  return h("section", { class: "yohaku", "aria-label": "Empty memory state" },
    sealImg("empty", 72, "empty mark"),
    h("p", { class: "empty-hint" }, hint),
  );
}

function renderKeyHelp() {
  refs.keyHelp.replaceChildren();
  if (!state.keyHelp) return;
  refs.keyHelp.append(h("aside", { class: "key-legend", "aria-label": "Keyboard shortcuts" },
    h("span", {}, "/ search"),
    h("span", {}, "j/k move"),
    h("span", {}, "enter open"),
    h("span", {}, "c capture"),
    h("span", {}, "esc close"),
  ));
}

function onKeydown(event) {
  const tag = document.activeElement?.tagName;
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  if (event.key === "Escape") {
    if (state.pane) closePane();
    else if (state.captureOpen) collapseCapture();
    else if (state.keyHelp) toggleKeys();
    return;
  }
  if (typing) return;
  if (event.key === "?") return void (event.preventDefault(), toggleKeys());
  if (event.key === "/") return void (event.preventDefault(), refs.search?.focus());
  if (event.key === "c") return void (event.preventDefault(), openCapture());
  if (event.key === "j" || event.key === "k") return void (event.preventDefault(), moveSelection(event.key === "j" ? 1 : -1));
  if (event.key === "Enter" && state.items[state.selected]) return void openItem(state.items[state.selected], rowAt(state.selected));
}

function moveSelection(delta) {
  if (!state.items.length) return;
  clearUndoNotice();
  state.selected = Math.max(0, Math.min(state.items.length - 1, state.selected + delta));
  renderList();
  rowAt(state.selected)?.focus({ preventScroll: true });
  rowAt(state.selected)?.scrollIntoView({ block: "nearest" });
}

function openCapture() {
  state.captureOpen = true;
  state.captureError = "";
  renderCapture();
}

function collapseCapture() {
  state.captureOpen = false;
  state.captureError = "";
  renderCapture();
}

function toggleKeys() {
  state.keyHelp = !state.keyHelp;
  renderKeyHelp();
}

async function logout() {
  await api.logout().catch(() => null);
  state.session = null;
  showLogin();
}

function handleError(error) {
  if (error instanceof AuthError) showLogin();
  else {
    state.message = "the paper tore";
    renderList();
  }
}

function labelBlock(name) {
  return h("div", { class: "rail-label" }, h("span", { class: "rail-name" }, name));
}

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === false || value === undefined || value === null) return;
    if (key === "class") node.className = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  });
  children.flat().forEach(child => {
    if (child === "" || child === null || child === undefined) return;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return node;
}

const rowAt = index => refs.list?.querySelector(`[data-index="${index}"]`);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
