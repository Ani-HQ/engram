import { sealSvg } from "./seal.js";

const VERSIONS = [
  { id: "archive", label: "archive" },
  { id: "strand", label: "strand" },
  { id: "handoff", label: "handoff" },
  { id: "door", label: "door" },
];

const REPO = ["https", "github.com/Ani-HQ/engram"].join("://");

const MEDIA = [
  {
    year: "1963",
    name: "Cassette",
    line: "A sequence you played from the start. Handing it over meant handing over the whole tape.",
    draw: cassette,
  },
  {
    year: "1971",
    name: "Floppy",
    line: "A disk you could pass across a desk. The memory lived in the object, and the object lived with one person.",
    draw: floppy,
  },
  {
    year: "1990",
    name: "Drive",
    line: "A machine that stayed in the room. Anyone who wanted the memory had to come to it.",
    draw: drive,
  },
  {
    year: "2006",
    name: "Cloud file",
    line: "A file any person could open. Agents still start from zero, because a file is not a handoff.",
    draw: cloud,
  },
  {
    year: "now",
    name: "engram",
    line: "One memory any agent can continue. Claude, ChatGPT, Grok, Cursor, or the next one. Nothing has to be pasted back in.",
    draw: null,
  },
];

const RUNGS = [
  { agent: "Claude", line: "Decision: one brain. A token names who wrote it. It does not fence anyone else out." },
  { agent: "ChatGPT", line: "Continuing that. The note stays on the topic page. I will not open a second copy." },
  { agent: "Grok", line: "Recall returns five short hits. The page itself stays the source." },
  { agent: "Cursor", line: "A conflict goes to a person. Nothing rewrites the original memory on its own." },
  { agent: "Codex", line: "Same strand. I can start from the last line instead of the beginning of the work." },
];

const HANDOFF = [
  { agent: "Claude", text: "Decision: one shared brain.\nTokens name the writer." },
  { agent: "ChatGPT", text: "Decision: one shared brain.\nTokens name the writer.\nI'll append to the topic page." },
  { agent: "Grok", text: "Decision: one shared brain.\nTokens name the writer.\nI'll append to the topic page.\nRecall keeps five. The page keeps the rest." },
];

const stage = document.querySelector("#stage");
const nav = document.querySelector("#switch");
let stop = () => {};

for (const version of VERSIONS) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = version.label;
  button.dataset.id = version.id;
  button.addEventListener("click", () => select(version.id));
  nav.append(button);
}

window.addEventListener("hashchange", () => select(currentId(), false));
document.addEventListener("keydown", (event) => {
  const index = Number(event.key) - 1;
  if (index >= 0 && index < VERSIONS.length && event.target === document.body) {
    select(VERSIONS[index].id);
  }
});

select(currentId(), false);

function currentId() {
  const id = location.hash.replace("#", "");
  return VERSIONS.some((version) => version.id === id) ? id : "strand";
}

function select(id, writeHash = true) {
  stop();
  stop = () => {};
  if (writeHash && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
  for (const button of nav.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", button.dataset.id === id ? "true" : "false");
  }
  stage.replaceChildren();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (id === "archive") renderArchive();
  else if (id === "strand") stop = renderStrand(reduced);
  else if (id === "handoff") stop = renderHandoff(reduced);
  else renderDoor();
  window.scrollTo(0, 0);
}

function renderArchive() {
  const root = el("div", "archive");
  MEDIA.forEach((item, index) => {
    const plate = el("section", "plate");
    const art = el("div");
    art.innerHTML = item.draw ? item.draw() : sealSvg("engram", 280);
    const copy = el("div");
    copy.append(
      el("p", "year", `${String(index + 1).padStart(2, "0")}  /  ${item.year}`),
      el("h2", "", item.name),
      el("p", "", item.line),
    );
    if (index === MEDIA.length - 1) copy.append(actions());
    else copy.append(el("p", "hint", "scroll sideways"));
    plate.append(art, copy);
    root.append(plate);
  });
  stage.append(root);
}

function renderStrand(reduced) {
  const scroll = el("div", "strand-scroll");
  const sticky = el("div", "strand-stage");
  const copy = el("div", "strand-copy");
  const memory = el("div", "memory");
  const bar = el("div", "memory-bar");
  const who = el("span", "", RUNGS[0].agent);
  const step = el("span", "", "01");
  const quote = el("p", "", RUNGS[0].line);
  bar.append(who, step);
  memory.append(bar, quote);
  copy.append(
    el("p", "kicker", "one strand"),
    el("h1", "", "Every agent. Same memory."),
    el("p", "lede", "Scroll the strand. Each rung is an agent picking up the last line, not a new file."),
    memory,
    actions(),
  );

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "helix");
  svg.setAttribute("viewBox", "0 0 640 900");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Agents connected along one strand");
  const left = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const right = document.createElementNS("http://www.w3.org/2000/svg", "path");
  left.setAttribute("class", "live");
  svg.append(left, right);

  const nodes = RUNGS.map((rung) => {
    const rungLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    rungLine.setAttribute("class", "rung");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("class", "node");
    circle.setAttribute("r", "7");
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("class", "node-name");
    label.textContent = rung.agent;
    svg.append(rungLine, circle, label);
    return { rungLine, circle, label };
  });
  const bead = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  bead.setAttribute("class", "bead");
  bead.setAttribute("r", "4");
  svg.append(bead);

  sticky.append(copy, svg);
  scroll.append(sticky);
  stage.append(scroll);

  const points = buildHelix();
  left.setAttribute("d", pathFrom(points.a));
  right.setAttribute("d", pathFrom(points.b));

  function paint(progress) {
    const active = Math.min(RUNGS.length - 1, Math.floor(progress * RUNGS.length));
    who.textContent = RUNGS[active].agent;
    step.textContent = String(active + 1).padStart(2, "0");
    quote.textContent = RUNGS[active].line;
    nodes.forEach((node, index) => {
      const t = (index + 0.5) / RUNGS.length;
      const a = helixAt(t, 0);
      const b = helixAt(t, Math.PI);
      node.rungLine.setAttribute("x1", String(a.x));
      node.rungLine.setAttribute("y1", String(a.y));
      node.rungLine.setAttribute("x2", String(b.x));
      node.rungLine.setAttribute("y2", String(b.y));
      node.circle.setAttribute("cx", String(a.x));
      node.circle.setAttribute("cy", String(a.y));
      node.label.setAttribute("x", "470");
      node.label.setAttribute("y", String(a.y + 4));
      const on = index <= active;
      node.circle.classList.toggle("on", index === active);
      node.label.classList.toggle("on", on);
      node.rungLine.classList.toggle("on", on);
    });
    const beadPoint = helixAt(progress, 0);
    bead.setAttribute("cx", String(beadPoint.x));
    bead.setAttribute("cy", String(beadPoint.y));
  }

  function onScroll() {
    const bounds = scroll.getBoundingClientRect();
    const total = scroll.offsetHeight - window.innerHeight;
    const seen = Math.min(total, Math.max(0, -bounds.top));
    paint(total === 0 ? 1 : seen / total);
  }

  paint(reduced ? 1 : 0);
  if (!reduced) {
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }
  return () => {};
}

function renderHandoff(reduced) {
  const root = el("section", "handoff");
  root.append(
    el("p", "kicker", "no missed context"),
    el("h1", "", "The next agent already knows."),
    el("p", "lede", "One decision, written once. The next window continues it. Nothing is pasted back in."),
  );
  const windows = el("div", "windows");
  const bodies = HANDOFF.map((pane, index) => {
    const frame = el("article", "window");
    const head = document.createElement("header");
    head.append(el("span", "", pane.agent), el("span", "", String(index + 1).padStart(2, "0")));
    const body = el("div", "body");
    frame.append(head, body);
    windows.append(frame);
    return body;
  });
  const replay = el("button", "replay", "play the handoff");
  replay.type = "button";
  root.append(windows, replay, actions());
  stage.append(root);

  let timer = 0;
  function play() {
    window.clearInterval(timer);
    bodies.forEach((body) => { body.replaceChildren(); });
    let step = 0;
    const tick = () => {
      if (step >= HANDOFF.length) {
        window.clearInterval(timer);
        return;
      }
      const shown = bodies[step];
      shown.textContent = HANDOFF[step].text;
      if (!reduced && step === HANDOFF.length - 1) shown.append(el("span", "caret"));
      else if (!reduced) shown.append(el("span", "caret"));
      if (step > 0) bodies[step - 1].querySelector(".caret")?.remove();
      step += 1;
      if (step >= HANDOFF.length) window.clearInterval(timer);
    };
    tick();
    if (!reduced) timer = window.setInterval(tick, 900);
  }
  replay.addEventListener("click", play);
  play();
  return () => window.clearInterval(timer);
}

function renderDoor() {
  const root = el("section", "door");
  const mark = el("div", "door-mark");
  mark.innerHTML = sealSvg("engram", 84);
  root.append(
    mark,
    el("p", "kicker", "shared memory"),
    el("h1", "", "engram"),
    el("p", "lede", "The memory layer for your agents. Open source if you want to run it. Or we set it up."),
    actions(),
    el("p", "offer", "Any MCP client. Claude, ChatGPT, Grok, Cursor, and whatever you add next."),
  );
  stage.append(root);
}

function actions() {
  const row = el("div", "actions");
  const start = el("a", "cta solid", "start an org");
  start.href = "/app#start";
  const enter = el("a", "cta", "I have a token");
  enter.href = "/app#enter";
  const self = el("a", "cta", "self-host");
  self.href = REPO;
  self.rel = "noreferrer";
  row.append(start, enter, self);
  return row;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function helixAt(t, phase) {
  const turns = 3.2;
  const y = 70 + t * 760;
  const x = 250 + Math.sin(t * turns * Math.PI * 2 + phase) * 110;
  return { x, y };
}

function buildHelix() {
  const a = [];
  const b = [];
  for (let i = 0; i <= 80; i += 1) {
    const t = i / 80;
    a.push(helixAt(t, 0));
    b.push(helixAt(t, Math.PI));
  }
  return { a, b };
}

function pathFrom(points) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
}

function cassette() {
  return `<svg class="object" viewBox="0 0 440 300" aria-hidden="true">
    <rect x="20" y="40" width="400" height="220" />
    <rect class="ink" x="70" y="78" width="300" height="110" />
    <circle cx="150" cy="133" r="34" />
    <circle cx="290" cy="133" r="34" />
    <circle class="fill-ink" cx="150" cy="133" r="6" />
    <circle class="fill-ink" cx="290" cy="133" r="6" />
    <path class="ink" d="M184 133 H256" />
    <rect x="150" y="206" width="140" height="28" />
  </svg>`;
}

function floppy() {
  return `<svg class="object" viewBox="0 0 440 300" aria-hidden="true">
    <rect x="110" y="28" width="220" height="244" />
    <rect x="150" y="28" width="140" height="70" />
    <rect class="ink" x="150" y="168" width="140" height="70" />
    <rect x="196" y="186" width="48" height="18" />
    <circle cx="168" cy="214" r="6" />
  </svg>`;
}

function drive() {
  return `<svg class="object" viewBox="0 0 440 300" aria-hidden="true">
    <ellipse cx="220" cy="168" rx="150" ry="36" />
    <ellipse cx="220" cy="148" rx="150" ry="36" />
    <ellipse class="ink" cx="220" cy="128" rx="150" ry="36" />
    <ellipse cx="220" cy="128" rx="28" ry="8" />
    <path d="M220 128 V70" />
    <rect x="200" y="48" width="70" height="22" />
  </svg>`;
}

function cloud() {
  return `<svg class="object" viewBox="0 0 440 300" aria-hidden="true">
    <rect x="70" y="70" width="300" height="170" />
    <path class="ink" d="M110 150 H250" />
    <path d="M110 178 H210" />
    <path d="M110 206 H180" />
    <rect x="286" y="132" width="48" height="64" />
  </svg>`;
}
