import { h } from "./profile.js";
import { emptyState, loadingState, pill, showToast } from "./design-system.js";
import { icon } from "./icons.js";
import { settingsCard, settingsRow } from "./account.js";

// Connections › linked teams.
// Personal workspace: let one of your agent connections read a team you belong
// to. Read-only, and team owners can see and revoke it.
// Team workspace: who has linked a personal connection here; owners revoke.

let sequence = 0;
const cache = new Map();
const button = (label, onclick, attrs = {}) => h("button", { type: "button", onclick, ...attrs }, label);
const when = iso => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
const toast = (message, tone = "success") => { try { showToast(message, { tone, glyph: icon(tone === "danger" ? "circle-alert" : "circle-check", { size: 16 }) }); } catch {} };
const quiet = (glyph, title, description) => { const node = emptyState({ glyph: icon(glyph, { size: 22 }), title, description }); node.setAttribute("data-variant", "dashed"); return node; };
const agentLabel = name => String(name).replace(/^linked:/, "").replace(/^oauth:[^:]*:/, "");

export function linkedWorkspacesPanel({ api, workspaceId, kind, role, fail = () => {}, isCurrent = () => true }) {
  const prefix = `linked-${++sequence}`;
  let disposed = false, request = 0, data = cache.get(workspaceId) || null, error = "", confirming = null;
  const busy = new Set();
  const status = h("p", { class: "ds-sr-only", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "linked-body" });
  const element = h("div", { class: "linked-workspaces" }, status, body);
  const live = () => !disposed && isCurrent();

  function card(...content) {
    const personal = kind === "personal";
    return settingsCard({
      title: personal ? "Let agents read your teams" : "Linked from personal workspaces",
      description: personal
        ? "Turn on a team for a connection and that agent can read the team's memory as well as yours. It can't write there. Team owners can see and revoke this."
        : "Members' personal agent connections that can read this team's memory. They can't write here.",
    }, ...content);
  }

  function render() {
    if (!live()) return;
    if (!data && !error) { body.replaceChildren(card(loadingState({ label: "Loading linked teams…", lines: 2, compact: true }))); return; }
    if (!data) { body.replaceChildren(card(h("div", { class: "notice", role: "alert" }, error, button("Try again", load, { class: "text small" })))); return; }
    body.replaceChildren(kind === "personal" ? personalView() : teamView());
  }

  function personalView() {
    const teams = data.teams || [], connections = data.connections || [];
    if (!teams.length) return card(quiet("users", "No teams to link", "Join a team workspace and its memory can be read from here."));
    if (!connections.length) return card(quiet("plug", "No active connections", "Connect an agent to this workspace first, then let it read a team."));
    return card(...connections.map(connection => {
      const toggles = teams.map(team => {
        const link = data.links.find(item => item.agent === connection.agent && item.teamId === team.id);
        const key = `${connection.agent}|${team.id}`;
        const id = `${prefix}-${connection.agent.length}-${team.id}-${teams.indexOf(team)}-${connections.indexOf(connection)}`;
        const control = h("input", { type: "checkbox", class: "ds-switch", role: "switch", id, checked: Boolean(link), disabled: busy.has(key) || (!link && !team.linkedReads),
          onchange: event => { event.target.checked = Boolean(link); link ? unlink(link, connection, team) : ask(connection, team); } });
        const confirm = confirming === key ? h("div", { class: "linked-confirm", role: "group", "aria-label": `Confirm linking ${team.name}` },
          h("p", {}, `Let ${connection.displayName} read ${team.name}'s memory? It can't write there, and ${team.name}'s owners can see and revoke this.`),
          h("div", { class: "ds-row" }, button("Cancel", () => { confirming = null; render(); document.getElementById(id)?.focus(); }, { class: "text small" }),
            button([icon("check", { size: 14 }), `Let it read ${team.name}`], () => link_(connection, team, id), { class: "primary small", "data-autofocus": "true" }))) : null;
        return h("div", { class: "linked-team" },
          h("label", { class: "linked-team-label", for: id }, h("span", {}, team.name), !team.linkedReads && pill("Turned off by owners")),
          control, confirm);
      });
      return settingsRow(connection.displayName, agentLabel(connection.agent) !== connection.displayName ? agentLabel(connection.agent) : "", h("div", { class: "linked-teams" }, toggles));
    }), h("div", { class: "ds-settings-foot" }, h("p", { class: "ds-settings-note" }, icon("info", { size: 13 }), " Agents ask with workspace: \"<team>\" on recall and search, or \"all\" to search everything they can read.")));
  }

  function teamView() {
    const links = data.links || [];
    const rows = links.map(link => settingsRow(link.agent, `${link.member} · since ${when(link.createdAt)}`,
      data.canRevoke ? button("Revoke", () => revokeTeam(link), { class: "small", disabled: busy.has(String(link.id)), "aria-label": `Revoke ${link.member}'s linked connection` }) : pill("Read only")));
    return card(
      !data.linkedReads && h("div", { class: "notice", role: "status" }, "Linked reads are turned off for this team in Workspace settings. Existing links are paused."),
      ...(rows.length ? rows : [quiet("link", "No linked connections", "When a member lets one of their personal agents read this team, it shows up here.")]));
  }

  function ask(connection, team) {
    confirming = `${connection.agent}|${team.id}`; render();
    element.querySelector("[data-autofocus]")?.focus();
  }

  async function link_(connection, team, focusId) {
    const key = `${connection.agent}|${team.id}`;
    confirming = null; busy.add(key); render();
    try {
      const result = await api.linkWorkspace({ agent: connection.agent, teamId: team.id });
      if (!live()) return;
      data = { ...data, links: [...data.links.filter(item => !(item.agent === connection.agent && item.teamId === team.id)), result.link] };
      cache.set(workspaceId, data);
      status.textContent = `${connection.displayName} can now read ${team.name}.`;
      toast(`${connection.displayName} can read ${team.name}`);
    } catch (err) { if (live()) { fail(err); toast(err.message || "The team could not be linked.", "danger"); } }
    finally { busy.delete(key); render(); document.getElementById(focusId)?.focus(); }
  }

  async function unlink(link, connection, team) {
    const key = `${connection.agent}|${team.id}`;
    busy.add(key); render();
    try {
      await api.unlinkWorkspace(link.id);
      if (!live()) return;
      data = { ...data, links: data.links.filter(item => item.id !== link.id) };
      cache.set(workspaceId, data);
      status.textContent = `${connection.displayName} can no longer read ${team.name}.`;
      toast(`${connection.displayName} can no longer read ${team.name}`);
    } catch (err) { if (live()) { fail(err); toast(err.message || "The link could not be removed.", "danger"); } }
    finally { busy.delete(key); render(); }
  }

  async function revokeTeam(link) {
    busy.add(String(link.id)); render();
    try {
      await api.unlinkWorkspace(link.id);
      if (!live()) return;
      data = { ...data, links: data.links.filter(item => item.id !== link.id) };
      cache.set(workspaceId, data);
      toast("Linked connection revoked");
    } catch (err) { if (live()) { fail(err); toast(err.message || "The link could not be revoked.", "danger"); } }
    finally { busy.delete(String(link.id)); render(); }
  }

  async function load() {
    const id = ++request;
    error = ""; body.setAttribute("aria-busy", "true"); render();
    try {
      const result = await api.linkedWorkspaces();
      if (!live() || id !== request) return;
      data = result; cache.set(workspaceId, result);
    } catch (err) {
      if (!live() || id !== request) return;
      fail(err); error = err.message || "Linked teams could not be loaded.";
    } finally { if (live() && id === request) { body.setAttribute("aria-busy", "false"); render(); } }
  }

  if (!["owner", "member"].includes(role) || (kind === "personal" && role !== "owner")) return { element: h("div", { hidden: true }), dispose() { disposed = true; } };
  load();
  return { element, dispose() { disposed = true; } };
}
