import { api, AuthError } from "./api.js";
import { inkColor, inkStepFor } from "./ink.js";
import { renderMarkdown } from "./markdown.js";
import { inkGlyph, relativeDate, renderKintsugi, renderTimeline, seigaiha, sealImg } from "./mechanics.js";
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
  now: new Date(),
};

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
    else showLogin("The gate did not answer.");
  }
}

// Boot splash: the seigaiha arcs breathe while we ask the gate who this browser is.
function showLoading(label) {
  app.className = "login-screen";
  app.replaceChildren(
    h("main", { class: "login-scroll" },
      h("div", { class: "inline-loading", role: "status" }, seigaiha(), h("span", {}, label)),
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
        showLogin(error instanceof AuthError ? "The seal did not open." : "The gate did not answer.");
      }
    },
  },
    sealImg("engram bunko", 82, "engram hanko"),
    h("h1", {}, "engram 文庫"),
    h("label", {}, h("span", { class: "sr-only" }, "Access token"), input),
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
      window.clearTimeout(refs.searchTimer);
      refs.searchTimer = window.setTimeout(loadCollection, 140);
    },
  });
  refs.count = h("p", { class: "result-count", "aria-live": "polite" });
  refs.list = h("section", { class: "ink-list", role: "listbox", "aria-label": "Memory pages" });
  refs.capture = h("div", { class: "capture-host" });
  refs.keyHelp = h("div", { class: "key-help-host" });
  refs.paneHost = h("div", { class: "pane-host" });

  const rail = h("aside", { class: "left-rail", "aria-label": "Sections" },
    sealImg(state.session?.name || "engram", 54, "console hanko"),
    h("h1", { class: "rail-title" }, "文庫"),
    labelBlock("文庫", "collection"),
    labelBlock("検索", "search"),
    labelBlock("記憶", "memory"),
    h("div", { class: "rail-foot" },
      h("span", {}, state.session?.name || "guest"),
      h("button", { type: "button", class: "text-button", onclick: logout }, "leave"),
    ),
  );

  const main = h("main", { class: "scroll-column" },
    refs.capture,
    h("section", { class: "search-field", "aria-label": "Search" },
      h("label", { for: "search" }, "検索"),
      refs.search,
    ),
    refs.count,
    refs.keyHelp,
    refs.list,
  );
  app.replaceChildren(rail, main, refs.paneHost);
  renderCapture();
  renderKeyHelp();
}

async function loadCollection() {
  state.loading = true;
  renderList();
  try {
    if (state.query.trim()) {
      const data = await api.search({ q: state.query.trim(), limit: 48 });
      state.items = data.results ?? [];
    } else {
      const data = await api.pages({ limit: 48, sort: "updated_desc" });
      state.items = data.pages ?? [];
      state.scopes = data.scopes ?? [];
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

function renderList() {
  if (!refs.list) return;
  refs.list.replaceChildren();
  const noun = state.items.length === 1 ? "page" : "pages";
  refs.count.textContent = state.loading ? "reading..." : `${state.items.length} ${noun}${state.message ? ` · ${state.message}` : ""}`;
  if (state.loading) {
    refs.list.append(h("div", { class: "inline-loading", role: "status" }, seigaiha(), h("span", {}, "wet ink settling")));
    return;
  }
  // Yohaku is for a truly empty result — never a reason to hide a page that exists.
  if (state.items.length === 0) {
    refs.list.append(renderYohaku());
    return;
  }
  state.items.forEach((item, index) => refs.list.append(renderRow(item, index)));
}

function renderRow(item, index) {
  const step = inkStepFor(item.updated_at, state.now);
  const selected = index === state.selected;
  const row = h("button", {
    type: "button",
    class: `ink-row${selected ? " is-selected" : ""}`,
    role: "option",
    "aria-selected": selected ? "true" : "false",
    "data-index": index,
    onclick: event => openItem(item, event.currentTarget),
  },
    h("span", { class: "row-title", style: { color: inkColor(step) } }, item.title || item.slug),
    h("span", { class: "row-meta" },
      h("span", { class: "scope-tag" }, item.scope || "shared"),
      h("span", { class: "slug" }, item.slug),
      h("span", { class: "ink-age", "aria-label": `updated ${relativeDate(item.updated_at, state.now)}` }, `${inkGlyph(step)} ${relativeDate(item.updated_at, state.now)}`),
    ),
    item.snippet ? h("span", { class: "snippet" }, item.snippet) : "",
  );
  row.style.setProperty("--row-delay", `${Math.min(index, 12) * 55}ms`);
  return row;
}

async function openItem(item, invoker) {
  state.activeRow = invoker ?? document.activeElement;
  state.pane = { loading: true, item };
  renderPane();
  try {
    const data = await api.page({ slug: item.slug, scope: item.scope });
    state.pane = { loading: false, ...data };
    renderPane();
    requestAnimationFrame(() => refs.paneHost.querySelector(".shoji-pane")?.focus());
  } catch (error) {
    handleError(error);
  }
}

function renderPane() {
  refs.paneHost.replaceChildren();
  if (!state.pane) return;
  const pane = h("aside", {
    class: "shoji-pane",
    tabindex: "-1",
    "aria-label": "Memory reader",
  });
  const close = h("button", { type: "button", class: "pane-close", onclick: closePane, "aria-label": "Close reader" }, "close");
  pane.append(close);
  if (state.pane.loading) {
    pane.append(h("div", { class: "pane-loading" }, seigaiha(), h("span", {}, "ink rising")));
  } else {
    const page = state.pane.page;
    const body = h("article", { class: "reader-body" });
    body.append(renderMarkdown(page.body || ""));
    // A [[wikilink]] in the prose opens the same way a kintsugi seam does.
    body.addEventListener("click", event => {
      const slug = event.target.closest?.(".wikilink")?.dataset.slug;
      if (!slug) return;
      event.preventDefault();
      openItem({ slug, title: slug, scope: page.scope }, state.activeRow);
    });
    pane.append(
      h("header", { class: "pane-head" },
        sealImg(page.source_id || page.scope || page.slug, 34, "source hanko"),
        h("div", {}, h("p", { class: "pane-kicker" }, `${page.type || "page"} · ${relativeDate(page.updated_at, state.now)}`), h("h2", {}, page.title || page.slug)),
      ),
      renderKintsugi(page, state.pane.links ?? [], openItem),
      body,
      renderTimeline(state.pane.timeline ?? []),
    );
  }
  refs.paneHost.append(pane);
  requestAnimationFrame(() => pane.classList.add("is-open"));
}

function closePane() {
  const pane = refs.paneHost.querySelector(".shoji-pane");
  if (!pane) return;
  pane.classList.add("is-closing");
  window.setTimeout(() => {
    state.pane = null;
    refs.paneHost.replaceChildren();
    state.activeRow?.focus?.({ preventScroll: true });
  }, reducedMotion() ? 0 : 440);
}

function renderCapture() {
  refs.capture.replaceChildren();
  if (!canWrite()) return;
  if (!state.captureOpen) {
    refs.capture.append(h("button", { type: "button", class: "tanzaku-tab", "aria-expanded": "false", onclick: openCapture }, "記す"));
    return;
  }
  const textarea = h("textarea", {
    rows: "7",
    placeholder: "記憶",
    oninput: event => state.captureText = event.currentTarget.value,
    onkeydown: event => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitCapture();
    },
  });
  textarea.value = state.captureText;
  const form = h("form", { class: "tanzaku-panel", onsubmit: event => { event.preventDefault(); submitCapture(); } },
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
    const result = await api.capture({ text, slug: null, title: null, scope: writableScope() });
    const panel = refs.capture.querySelector(".tanzaku-panel");
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

function renderYohaku() {
  const hint = canWrite() ? "Press c to write." : "Press / to search.";
  return h("section", { class: "yohaku", "aria-label": "Empty memory state" },
    sealImg("empty paper", 72, "empty seal"),
    h("p", { class: "empty-kanji" }, "空"),
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
  if (event.key === "c" && canWrite()) return void (event.preventDefault(), openCapture());
  if (event.key === "j" || event.key === "k") return void (event.preventDefault(), moveSelection(event.key === "j" ? 1 : -1));
  if (event.key === "Enter" && state.items[state.selected]) return void openItem(state.items[state.selected], rowAt(state.selected));
}

function moveSelection(delta) {
  if (!state.items.length) return;
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

function labelBlock(kanji, roman) {
  return h("div", { class: "rail-label" }, h("span", { class: "rail-kanji" }, kanji), h("span", { class: "rail-roman" }, roman));
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

function canWrite() {
  return Object.values(state.session?.scopes ?? {}).includes("rw");
}

function writableScope() {
  return Object.entries(state.session?.scopes ?? {}).find(([, value]) => value === "rw")?.[0] ?? null;
}

const rowAt = index => refs.list?.querySelector(`[data-index="${index}"]`);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));
