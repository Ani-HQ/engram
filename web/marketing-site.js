// Public-page interactions: header menus, mobile navigation, card spotlight,
// tabs, copy buttons, scroll reveal and the example handoff session.
// Every page reads correctly without this file; it only adds motion and menus.
const root = document.documentElement;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
root.classList.add("ds-js");

// Header: hairline and blur once the page scrolls.
const header = document.querySelector(".m-header");
if (header) {
  const update = () => header.toggleAttribute("data-scrolled", scrollY > 8);
  update();
  addEventListener("scroll", update, { passive: true });
}

// Header dropdown menus.
const triggers = [...document.querySelectorAll("[data-menu-trigger]")];
const menuFor = trigger => document.getElementById(trigger.getAttribute("aria-controls"));
function setMenu(trigger, open) {
  const menu = menuFor(trigger);
  if (!menu) return;
  trigger.setAttribute("aria-expanded", String(open));
  menu.dataset.open = String(open);
}
function closeMenus(except) { for (const t of triggers) if (t !== except) setMenu(t, false); }
for (const trigger of triggers) {
  const item = trigger.parentElement;
  let timer;
  trigger.addEventListener("click", () => {
    const open = trigger.getAttribute("aria-expanded") !== "true";
    closeMenus(trigger);
    setMenu(trigger, open);
  });
  item.addEventListener("pointerenter", () => { if (!finePointer.matches) return; clearTimeout(timer); closeMenus(trigger); setMenu(trigger, true); });
  item.addEventListener("pointerleave", () => { if (!finePointer.matches) return; timer = setTimeout(() => setMenu(trigger, false), 120); });
  item.addEventListener("focusout", event => { if (!item.contains(event.relatedTarget)) setMenu(trigger, false); });
}
document.addEventListener("click", event => { if (!event.target.closest(".m-nav-item")) closeMenus(); });
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const open = triggers.find(t => t.getAttribute("aria-expanded") === "true");
  if (open) { setMenu(open, false); open.focus(); }
  if (document.body.dataset.navOpen === "true") toggleNav(false);
});

// Mobile navigation sheet.
const navToggle = document.querySelector("[data-nav-toggle]");
function toggleNav(open) {
  if (!navToggle) return;
  document.body.dataset.navOpen = String(open);
  navToggle.setAttribute("aria-expanded", String(open));
  navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}
navToggle?.addEventListener("click", () => toggleNav(document.body.dataset.navOpen !== "true"));
matchMedia("(min-width: 901px)").addEventListener("change", event => { if (event.matches) toggleNav(false); });

// Cursor spotlight on hairline cards.
for (const card of document.querySelectorAll(".ds-spotlight")) {
  card.addEventListener("pointermove", event => {
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${event.clientX - box.left}px`);
    card.style.setProperty("--my", `${event.clientY - box.top}px`);
  });
}

// Tabs with arrow-key navigation.
for (const list of document.querySelectorAll("[role='tablist']")) {
  const tabs = [...list.querySelectorAll("[role='tab']")];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  list.addEventListener("click", event => { const tab = event.target.closest("[role='tab']"); if (tab) select(tab, false); });
  list.addEventListener("keydown", event => {
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length], true);
  });
}

// Copy buttons: data-copy holds the exact text, or data-copy-from names an element id.
for (const button of document.querySelectorAll("[data-copy], [data-copy-from]")) {
  const label = button.querySelector("[data-copy-label]");
  button.addEventListener("click", async () => {
    const source = button.dataset.copyFrom ? document.getElementById(button.dataset.copyFrom) : null;
    const panel = source?.querySelector("[role='tabpanel']:not([hidden])") ?? source;
    const text = button.dataset.copy ?? panel?.dataset.command ?? panel?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text.trim());
      button.dataset.copied = "true";
      if (label) label.textContent = "Copied";
    } catch {
      if (label) label.textContent = "Press ⌘C";
    }
    setTimeout(() => { delete button.dataset.copied; if (label) label.textContent = "Copy"; }, 1600);
  });
}

// Scroll reveal.
const revealed = document.querySelectorAll("[data-reveal]");
for (const element of revealed) if (element.dataset.revealDelay) element.style.setProperty("--ds-reveal-delay", `${Number(element.dataset.revealDelay) || 0}ms`);
if (!reduceMotion.matches && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("is-visible"); observer.unobserve(entry.target); }
  }, { rootMargin: "0px 0px -8% 0px", threshold: .08 });
  for (const element of revealed) observer.observe(element);
} else {
  for (const element of revealed) element.classList.add("is-visible");
}

// Example handoff session: types each [data-step] line in order, once, when visible.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function playHandoff(demo) {
  const steps = [...demo.querySelectorAll("[data-step]")];
  const replay = demo.querySelector("[data-handoff-replay]");
  if (replay) replay.disabled = true;
  for (const step of steps) { step.hidden = true; step.dataset.full ??= step.textContent; }
  for (const pane of demo.querySelectorAll("[data-pane]")) pane.removeAttribute("data-active");
  for (const step of steps) {
    const pane = step.closest("[data-pane]");
    for (const p of demo.querySelectorAll("[data-pane]")) p.toggleAttribute("data-active", p === pane);
    step.hidden = false;
    if (step.dataset.step === "type") {
      const text = step.dataset.full;
      const caret = Object.assign(document.createElement("span"), { className: "ds-caret" });
      step.textContent = "";
      const prompt = step.dataset.prompt ?? "";
      for (let i = 0; i <= text.length - prompt.length; i++) {
        step.textContent = prompt + text.slice(prompt.length, prompt.length + i);
        step.append(caret);
        await wait(18 + Math.random() * 26);
      }
      await wait(380);
      caret.remove();
    } else {
      step.classList.add("m-step-in");
      await wait(Number(step.dataset.delay ?? 420));
    }
  }
  if (replay) replay.disabled = false;
}
for (const demo of document.querySelectorAll("[data-handoff]")) {
  const replay = demo.querySelector("[data-handoff-replay]");
  if (reduceMotion.matches || !("IntersectionObserver" in window)) { replay?.remove(); continue; }
  for (const step of demo.querySelectorAll("[data-step]")) step.hidden = true;
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); playHandoff(demo); }
  }, { threshold: .35 });
  observer.observe(demo);
  replay?.addEventListener("click", () => playHandoff(demo));
}
