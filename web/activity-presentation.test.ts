import { describe, expect, test } from "bun:test";
import { actionPresentation, activityPresentation, chronologicalActions, contributorName, memoryOperationContext, memoryToolLabel, resourcePresentation } from "./activity-presentation.js";
import { activityCard, activityDetail, activityDetailHeader, activityFeed } from "./activity-view.js";

const operation = { id: "event:1", summary: "get page", tools: ["get_page"], status: "completed", evidence: "observed", actionCount: 1, agents: [{ name: "reviewer", status: "completed" }],
  updatedAt: "2026-10-23T10:00:00Z", actions: [{ id: "1", agent: "reviewer", tool: "get_page", summary: "get page", resource: "engram://deployment-approvals", status: "completed", evidence: "observed", occurredAt: "2026-10-23T09:00:00Z", recordedAt: "2026-10-23T10:00:00Z" }] };

// Scoped lightweight DOM seam: no browser, network, global module mocks or dependency.
class Element {
  tag: string; attrs: Record<string, string> = {}; children: Element[] = []; events: Record<string, Function> = {}; value: string;
  constructor(tag: string, value = "") { this.tag = tag; this.value = value; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(key: string, value: Function) { this.events[key] = value; }
  append(...children: Element[]) { this.children.push(...children); }
  set className(value: string) { this.attrs.class = value; }
  get className(): string { return this.attrs.class || ""; }
  set textContent(value: string) { this.value = String(value); this.children = []; }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join(""); }
}
function render(work: () => Element) {
  const original = { Node: globalThis.Node, document: globalThis.document };
  try {
    Object.assign(globalThis, { Node: Element, document: { createElement: (tag: string) => new Element(tag), createElementNS: (_: string, tag: string) => new Element(tag), createTextNode: (value: string) => new Element("#text", value) } });
    return work();
  } finally { Object.assign(globalThis, original); }
}
function nodes(node: Element): Element[] { return [node, ...node.children.flatMap(nodes)]; }

describe("recorded activity presentation", () => {
  test("humanizes only known memory namespaces and preserves reported task intent", () => {
    expect(memoryToolLabel("mcp__engram__get_page")).toBe("Read memory");
    expect(memoryToolLabel("memory.remember")).toBe("Save memory");
    expect(memoryToolLabel("github.search")).toBeNull();
    expect(memoryToolLabel("untrusted.get_page")).toBeNull();
    expect(actionPresentation({ tool: "get_page", summary: "get page (error)", status: "failed" }).title).toBe("Could not read memory");
    expect(actionPresentation({ tool: "recall", summary: "Check the deployment policy" }).title).toBe("Check the deployment policy");
    expect(activityPresentation({ ...operation, taskTitle: "Review the release policy" }).title).toBe("Review the release policy");
  });

  test("generic memory titles describe recorded state rather than suggesting commands", () => {
    for (const [tool, completed, running, failed] of [
      ["remember", "Saved a memory", "Saving memory", "Could not save memory"],
      ["put_page", "Saved a memory", "Saving memory", "Could not save memory"],
      ["recall", "Searched memory", "Searching memory", "Could not search memory"],
      ["search", "Searched memory", "Searching memory", "Could not search memory"],
      ["get_page", "Read a memory", "Reading memory", "Could not read memory"],
      ["list_pages", "Browsed memory", "Browsing memory", "Could not browse memory"],
    ]) {
      for (const [status, expected] of [["completed", completed], ["running", running], ["failed", failed]]) {
        expect(actionPresentation({ tool, status, summary: tool.replaceAll("_", " ") }).title).toBe(expected);
      }
    }
    expect(actionPresentation({ tool: "put_page", summary: "put page", status: "completed", resource: "engram://launch-plan" }).title).toBe("Saved “Launch plan”");
    expect(actionPresentation({ tool: "get_page", summary: "get page", status: "running", resource: "engram://launch-plan" }).title).toBe("Reading “Launch plan”");
    expect(actionPresentation({ tool: "get_page", summary: "get page", status: "failed", resource: "engram://launch-plan" }).title).toBe("Could not read “Launch plan”");
    expect(actionPresentation({ tool: "remember", summary: "Saved the owner’s deployment preference", status: "completed" }).title).toBe("Saved the owner’s deployment preference");
    expect(memoryToolLabel("put_page")).toBe("Save memory");
  });

  test("does not turn tool receipts or detail prose into invented outcomes", () => {
    const presentation = activityPresentation({ ...operation, detail: "Could relate to an important release.", approaches: [] });
    expect(presentation.kind).toBe("memory");
    expect(presentation.title).toBe("Read “Deployment approvals”");
    expect(presentation.lead).toBeNull();
    expect(presentation.outcome).toBe("");
    expect(presentation.approaches).toEqual([]);
    expect(activityPresentation({ ...operation, evidence: "reported", kind: "action" }).kind).toBe("action");
  });

  test("uses explicit progress/outcome metadata in status order without changing its meaning", () => {
    const input = { ...operation, kind: "task", outcome: "Draft saved; sending awaits approval.", currentStep: "Checking the final wording." };
    expect(activityPresentation({ ...input, status: "running" }).lead).toEqual({ label: "Current step", text: input.currentStep });
    expect(activityPresentation({ ...input, status: "completed" }).lead).toEqual({ label: "Outcome", text: input.outcome });
    expect(activityPresentation({ ...input, outcome: null, status: "failed" }).lead).toEqual({ label: "Last reported step", text: input.currentStep });
  });

  test("resource descriptors permit explicit web URLs and memory slugs without executable links", () => {
    expect(resourcePresentation("engram://deployment-approvals")).toEqual({ raw: "engram://deployment-approvals", service: "memory", resourceKind: "memory", label: "Deployment approvals", kind: "memory", slug: "deployment-approvals", href: null });
    expect(resourcePresentation("topics/release-policy", { memory: true })?.slug).toBe("topics/release-policy");
    expect(resourcePresentation("https://github.com/example/repo/pull/42")?.href).toBe("https://github.com/example/repo/pull/42");
    for (const value of ["javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd", "https://user:password@example.com/", "https://example.com/\\evil", "https://example.com/\npath", "https://github.com/team/%ZZ", "https://github.com/team/%2Frepo", "engram://../secret", "engram://%2e%2e/secret", "engram://page?capture=1", "engram://javascript:alert(1)"]) {
      const descriptor = resourcePresentation(value);
      expect(descriptor?.href).toBeNull();
      expect(descriptor?.slug).toBeNull();
    }
  });

  test("does not choose an arbitrary artifact from multiple resources", () => {
    const input = { ...operation, actions: [], kind: "task", resources: ["https://example.com/input", "https://example.com/output"] };
    expect(activityPresentation(input).primaryResource).toBeNull();
    expect(activityPresentation({ ...input, resources: [input.resources[0], input.resources[0]] }).primaryResource?.raw).toBe(input.resources[0]);
    expect(activityPresentation({ ...input, resource: input.resources[1] }).primaryResource?.raw).toBe(input.resources[1]);
  });

  test("shows an unambiguous recorded repository context among several artifacts", () => {
    const repo = "repo:Ani-HQ/engram";
    const input = { ...operation, kind: "task", tools: ["github.create_pull_request", "files.write"], resources: [repo, "web/app.js"], actions: [
      { ...operation.actions[0], tool: "github.create_pull_request", resource: repo },
      { ...operation.actions[0], id: "2", tool: "files.write", resource: "web/app.js" },
    ] };
    expect(activityPresentation(input).primaryResource).toMatchObject({ raw: repo, service: "github", resourceKind: "repository", label: "Ani-HQ/engram" });
    expect(activityPresentation({ ...input, actions: [{ ...input.actions[0], resource: "elsewhere" }, input.actions[1]] }).primaryResource?.service).toBe("git");
    const conflicting = { ...input, actions: [input.actions[0], { ...input.actions[0], tool: "gitlab.create_merge_request" }] };
    expect(activityPresentation(conflicting).primaryResource?.service).toBe("git");
    expect(activityPresentation({ ...input, resources: [repo, "repo:Another/project"] }).primaryResource).toBeNull();
  });

  test("grouped cards retain one actual repository context from PR, issue and file URLs", () => {
    const github = ["https://github.com/Ani-HQ/engram/pull/42", "https://github.com/Ani-HQ/engram/issues/12", "https://github.com/Ani-HQ/engram/blob/main/web/app.js"];
    const gitlab = ["https://gitlab.com/team/subgroup/project/-/merge_requests/8", "https://gitlab.com/team/subgroup/project/-/issues/3", "https://gitlab.com/team/subgroup/project/-/blob/main/app.js"];
    const grouped = (resources: string[]) => ({ ...operation, kind: "task", tools: ["files.write", "github.create_pull_request"], resources, actions: [] });
    for (const url of [...github, ...gitlab]) {
      expect(activityPresentation(grouped(["web/app.js", url, "docs/notes.md"])).primaryResource?.raw).toBe(url);
    }
    expect(activityPresentation(grouped(["web/app.js", ...github])).primaryResource?.raw).toBe(github[0]);
    expect(activityPresentation(grouped(["web/app.js", ...gitlab])).primaryResource?.raw).toBe(gitlab[0]);
    expect(activityPresentation(grouped([...github, "https://github.com/Ani-HQ/engram"])).primaryResource?.resourceKind).toBe("repository");
    for (const resources of [
      [...github, "https://github.com/another/project/pull/42"],
      [...github, "https://github.com/another/project/blob/main/app.js"],
      [...gitlab, "https://gitlab.com/team/another/project/-/issues/3"],
      [github[0], gitlab[0]],
    ]) expect(activityPresentation(grouped(resources)).primaryResource).toBeNull();
    const card = render(() => activityCard(grouped(["web/app.js", github[0]])) as Element);
    expect(nodes(card).some(node => node.attrs.class?.includes("activity-resource") && node.textContent === "Ani-HQ/engram #42")).toBeTrue();
  });

  test("resource links are plain text without provider marks or URL query secrets in labels", () => {
    const raw = "https://github.com/Ani-HQ/engram/pull/42?token=supersecret#review";
    let selected: any;
    const input = { ...operation, kind: "task", resources: [raw], tools: ["browser.navigate"], actions: [] };
    const card = render(() => activityCard(input, { onResource: resource => { selected = resource; } }) as Element);
    const chip = nodes(card).find(node => node.attrs.class?.includes("activity-resource"))!;
    expect(chip.attrs.title).toBe("Open resource: Ani-HQ/engram #42");
    expect(chip.attrs["aria-label"]).toBe("Open resource: Ani-HQ/engram #42");
    expect(chip.textContent).toBe("Ani-HQ/engram #42");
    expect(nodes(chip).some(node => node.attrs["data-brand"] || node.attrs["data-icon"])).toBeFalse();
    expect(chip.textContent).not.toContain("supersecret");
    chip.events.click();
    expect(selected.raw).toBe(raw); expect(selected.href).toBe(raw);
    const local = render(() => activityCard({ ...input, resources: ["web/app.js"], tools: ["github.read_file"] }) as Element);
    const localChip = nodes(local).find(node => node.attrs.class?.includes("activity-resource"))!;
    expect(localChip.textContent).toBe("web/app.js");
    expect(nodes(localChip).some(node => node.attrs["data-brand"] || node.attrs["data-icon"])).toBeFalse();
  });

  test("orders logical steps by lifecycle start and keeps the source array unchanged", () => {
    const rows = [{ id: "later", startedAt: "2026-10-23T09:05:00Z", recordedAt: "2026-10-23T09:06:00Z" }, { id: "earlier", startedAt: "2026-10-23T09:00:00Z", occurredAt: "2026-10-23T09:10:00Z", recordedAt: "2026-10-23T09:10:00Z" }];
    expect(chronologicalActions(rows).map(row => row.id)).toEqual(["earlier", "later"]);
    expect(rows[0].id).toBe("later");
  });

  test("legacy memory detail stays compact and missing methods stay absent", () => {
    const view = render(() => activityDetail(operation) as Element);
    expect(view.attrs.class).toContain("is-compact-operation");
    expect(view.textContent).not.toContain("No approach");
    expect(view.textContent).not.toContain("Method");
    expect(view.textContent).not.toContain("Overview");
    expect(nodes(view).filter(node => node.tag === "details")).toHaveLength(1);
    expect(nodes(view).find(node => node.tag === "summary")?.textContent).toBe("Technical receipt");
    expect(nodes(view).find(node => node.tag === "details")?.attrs.open).toBeUndefined();
    expect(view.textContent).toContain("Observed by Engram");
    expect(view.textContent).toContain("The memory read request completed.");
  });

  test("known memory targets and queries come from complete bounded input JSON only", () => {
    const read = { tool: "get_page", summary: "get page", status: "completed", detail: '{"slug":"launch-plan","content":"PRIVATE MEMORY BODY"}' };
    expect(actionPresentation(read).title).toBe("Read “Launch plan”");
    expect(memoryOperationContext(read)?.target?.slug).toBe("launch-plan");
    expect(memoryOperationContext(read)?.explanation).toBe("The memory read request completed.");
    const search = memoryOperationContext({ tool: "recall", status: "failed", detail: '{"q":"release owner policy"}' });
    expect(search?.query).toBe("release owner policy");
    expect(search?.explanation).toBe("The memory search request failed.");
    const activity = { ...operation, resources: [], actions: [{ ...operation.actions[0], resource: null, detail: read.detail }] };
    const view = render(() => activityDetail(activity) as Element);
    // Raw arguments remain inside the closed, inspectable receipt, never the summary.
    const report = nodes(view).find(node => node.attrs.class === "activity-report activity-detail-report");
    expect(report?.textContent).toBe("OperationThe memory read request completed.");
    expect(report?.textContent).not.toContain("PRIVATE MEMORY BODY");
    expect(nodes(view).find(node => node.tag === "details")?.attrs.open).toBeUndefined();
    expect(activityPresentation(activity).primaryResource?.slug).toBe("launch-plan");
  });

  test("truncated JSON, unsafe argument types and oversized receipts yield no guessed context", () => {
    for (const detail of ['{"slug":"launch-plan","content":"truncated', '{"query":"owner policy"', '[{"slug":"launch-plan"}]', '{"slug":["launch-plan"],"q":42}', '{"slug":"../secret","query":true}', JSON.stringify({ query: "x".repeat(281) }), JSON.stringify({ slug: "launch-plan", content: "x".repeat(8192) })]) {
      const context = memoryOperationContext({ tool: "search", status: "completed", detail });
      expect(context?.query).toBe("");
      expect(context?.target).toBeNull();
    }
    expect(memoryOperationContext({ tool: "files.write", detail: '{"slug":"launch-plan"}' })).toBeNull();
  });

  test("reported tasks without outcomes show latest plain text as a report, never verified outcome", () => {
    const row = { ...operation.actions[0], tool: "files.write", evidence: "reported", detail: "The older draft was saved.", recordedAt: "2026-10-23T09:00:00Z" };
    const input = { ...operation, kind: "task", summary: "Prepare the launch draft", tools: ["files.write"], actions: [row, { ...row, id: "2", detail: "The launch draft is ready for review; it has not been sent.", recordedAt: "2026-10-23T09:01:00Z" }] };
    expect(activityPresentation(input).lead).toEqual({ label: "Latest report", text: input.actions[1].detail });
    expect(activityPresentation(input).outcome).toBe("");
    for (const detail of ['{"result":"saved"}', '{"result":"truncated', 'true', '42', '<html>Private contents</html>', 'Output:\n```json\n{"result":"saved"}\n```']) {
      expect(activityPresentation({ ...input, actions: [{ ...row, detail }] }).lead).toBeNull();
    }
    expect(activityPresentation({ ...input, actions: [{ ...row, tool: "put_page", detail: "PRIVATE MEMORY CONTENTS" }] }).lead).toBeNull();
  });

  test("completed detail does not repeat historical current step beside its result", () => {
    const input = { ...operation, kind: "task", outcome: "Draft saved for review.", currentStep: "Saving the draft now.", actions: [{ ...operation.actions[0], tool: "files.write", evidence: "reported", outcome: "Draft saved for review.", currentStep: "Saving the draft now." }] };
    const view = render(() => activityDetail(input, { expandSteps: true }) as Element);
    expect(view.textContent).toContain("Draft saved for review.");
    expect(view.textContent).not.toContain("Saving the draft now.");
  });

  test("card resource action is separate from opening the task and retains authenticated names", () => {
    let selected: any = null, opened = false;
    const activity = { ...operation, kind: "task", taskTitle: "Review policy", resources: ["engram://deployment-approvals"], agents: [{ name: "reviewer-key", harness: "codex", sourceLabel: "Codex" }] };
    const card = render(() => activityCard(activity, { onOpen: () => { opened = true; }, onResource: resource => { selected = resource; } }) as Element);
    expect(card.textContent).toContain("reviewer-key");
    const resource = nodes(card).find(node => node.attrs["aria-label"] === "Open memory: Deployment approvals")!;
    resource.events.click();
    expect(selected.slug).toBe("deployment-approvals");
    expect(opened).toBeFalse();
    const open = nodes(card).find(node => node.attrs["data-open-activity"])!;
    open.events.click();
    expect(opened).toBeTrue();
    for (const button of nodes(card).filter(node => node.tag === "button")) expect(button.children.flatMap(nodes).some(node => node.tag === "button")).toBeFalse();
  });

  test("friendly connection labels stay separate from authenticated filter and focus keys", () => {
    const name = "oauth:opaque-user:opaque-client", agent = { name, displayName: "Claude Code", harness: "claude-code" };
    let filter: any[] = [];
    const activity = { ...operation, agents: [agent] };
    const card = render(() => activityCard(activity, { onFilter: (...args) => { filter = args; } }) as Element);
    expect(card.textContent).toContain("Claude Code");
    expect(card.textContent).not.toContain(name);
    expect(contributorName(agent)).toBe("Claude Code");
    expect(contributorName({ name, displayName: " " })).toBe(name);
    const control = nodes(card).find(node => node.attrs["data-focus-key"] === `agent:${name}`)!;
    expect(control.attrs.title).toContain(name);
    control.events.click();
    expect(filter).toEqual(["agent", name]);
    const header = render(() => activityDetailHeader(activity) as Element);
    expect(header.textContent).toContain("Claude Code");
    expect(nodes(header).some(node => node.attrs["data-focus-key"] === `agent:${name}`)).toBeTrue();
  });

  test("mixed feed preserves chronology and per-item density without replaying entry animation", () => {
    const rows = [{ ...operation, id: "memory-new", kind: "memory" },
      { ...operation, id: "task-running", kind: "task", status: "running", taskTitle: "Review launch", currentStep: "Checking owner sign-off", workingActions: 0, staleActions: 1 },
      { ...operation, id: "memory-old", kind: "memory", status: "failed" }];
    const feed = render(() => activityFeed(rows, { kind: "all", freshIds: new Set(rows.map(row => row.id)) }) as Element);
    const articles = nodes(feed).filter(node => node.tag === "article");
    expect(articles.map(node => node.attrs["data-activity-id"])).toEqual(rows.map(row => row.id));
    expect(articles[0].attrs.class).toContain("activity-memory");
    expect(articles[0].attrs.class).not.toContain("has-context");
    expect(articles[1].attrs.class).toContain("has-context");
    expect(articles[1].textContent).toContain("Checking owner sign-off");
    expect(articles[1].textContent).toContain("Awaiting update");
    expect(articles.some(node => node.attrs.class.includes("is-new"))).toBeFalse();
    expect(nodes(feed).some(node => node.attrs.class === "avatar-working-dot" || node.attrs.class?.includes("working-spinner"))).toBeFalse();
  });

  test("timeline arrow navigation follows the visible mixed order immediately", () => {
    const rows = [{ ...operation, id: "first" }, { ...operation, id: "second", kind: "task", status: "running" }];
    const feed = render(() => activityFeed(rows, { kind: "all" }) as Element);
    const controls = nodes(feed).filter(node => node.attrs["data-open-activity"]);
    let focused = "", prevented = false;
    const targets = controls.map(node => ({ ...node, matches: () => true, focus: () => { focused = node.attrs["data-open-activity"]; } }));
    feed.events.keydown({ key: "ArrowDown", target: targets[0], currentTarget: { querySelectorAll: () => targets }, preventDefault: () => { prevented = true; } });
    expect(focused).toBe("second");
    expect(prevented).toBeTrue();
    expect(controls.map(node => node.attrs["data-focus-key"])).toEqual(["open:first", "open:second"]);
  });

  test("task detail exposes reported context and optional chronological steps without tabs", () => {
    const activity = { ...operation, kind: "task", taskTitle: "Review policy", outcome: "Policy review finished.", currentStep: "Checked the owner requirement.", approaches: [{ agent: "reviewer", text: "Read the saved policy before reviewing." }, { agent: "reviewer", text: " " }], actions: [...operation.actions, { ...operation.actions[0], id: "2", occurredAt: "2026-10-23T09:01:00Z", summary: "Reviewed the owner requirement" }] };
    const view = render(() => activityDetail(activity) as Element);
    expect(view.textContent).toContain("Policy review finished.");
    expect(view.textContent).toContain("Read the saved policy before reviewing.");
    expect(nodes(view).filter(node => node.attrs.class === "approach-card")).toHaveLength(1);
    expect(nodes(view).find(node => node.attrs.class === "activity-steps-expander")?.attrs.open).toBeUndefined();
    expect(nodes(view).some(node => node.attrs.role === "tab")).toBeFalse();
    const header = render(() => activityDetailHeader(activity) as Element);
    expect(header.textContent).toContain("Review policy");
    expect(header.textContent).toContain("reviewer");
  });
});
