import { describe, expect, test } from "bun:test";
import { RESOURCE_SERVICES, resourceIdentity, resourceService } from "./resource-model.js";

describe("recorded resource identity", () => {
  test("identifies real GitHub repository, pull request and file resources", () => {
    for (const input of ["https://github.com/Ani-HQ/engram", "https://github.com/Ani-HQ/engram.git", "github.com/Ani-HQ/engram.git", "git@github.com:Ani-HQ/engram.git"]) {
      expect(resourceIdentity(input)).toEqual({ service: "github", label: "Ani-HQ/engram", kind: "repository" });
    }
    expect(resourceIdentity("https://github.com/Ani-HQ/engram/pull/42?token=secret#review")).toEqual({ service: "github", label: "Ani-HQ/engram #42", kind: "pull-request" });
    expect(resourceIdentity("https://github.com/Ani-HQ/engram/blob/main/web/app.js")).toEqual({ service: "github", label: "Ani-HQ/engram · web/app.js", kind: "file" });
    expect(resourceIdentity("https://gitlab.com/team/subgroup/project/-/merge_requests/8")).toEqual({ service: "gitlab", label: "team/subgroup/project !8", kind: "pull-request" });
    expect(resourceService("git@gitlab.com:team/subgroup/project.git")).toBe("gitlab");
  });

  test("does not invent a repository host or infer a provider for a local file", () => {
    expect(resourceIdentity("repo:Ani-HQ/engram")).toEqual({ service: "git", label: "Ani-HQ/engram", kind: "repository" });
    expect(resourceService("repo:Ani-HQ/engram", "mcp__github__get_issue")).toBe("github");
    expect(resourceService("repo:Ani-HQ/engram", "github.create_pull_request")).toBe("github");
    for (const tool of ["mcp__github-personal__get_issue", "mygithubtracker.run", "tools.github.get_issue", "https://github.com", "mcp__github__", "mcp__evil__github_read"]) {
      expect(resourceService("repo:Ani-HQ/engram", tool)).toBe("git");
    }
    for (const input of ["web/app.js", "/Users/example/repos/engram", "C:\\work\\engram\\app.js", "./docs/plan.md", "file:///tmp/plan.md"]) {
      expect(resourceService(input, "github.read_file")).toBe("files");
    }
    expect(resourceService("123", "notion.read")).toBe("other");
    expect(resourceService(null, "github.read")).toBe("other");
  });

  test("recognizes documents and other locally supported provider identities", () => {
    const samples = [
      ["https://docs.google.com/document/d/doc-id/edit", "googledocs", "document"],
      ["https://docs.google.com/spreadsheets/d/sheet-id/edit", "googlesheets", "spreadsheet"],
      ["https://docs.google.com/presentation/d/deck-id/edit", "googledrive", "presentation"],
      ["https://drive.google.com/file/d/file-id/view", "googledrive", "file"],
      ["https://drive.google.com/drive/folders/folder-id", "googledrive", "folder"],
      ["https://www.notion.so/workspace/Saved-page-123", "notion", "document"],
      ["https://team.notion.site/Saved-page-123", "notion", "document"],
      ["https://linear.app/team/issue/ENG-42/review-layout", "linear", "issue"],
      ["https://workspace.slack.com/archives/C123/p12345", "slack", "message"],
      ["https://www.figma.com/design/KEY/Project", "figma", "design"],
      ["https://www.figma.com/proto/KEY/Project", "figma", "prototype"],
      ["https://vercel.com/team/project/deployment-id", "vercel", "deployment"],
      ["https://project.vercel.app/", "vercel", "deployment"],
      ["https://www.dropbox.com/s/id/plan.pdf", "dropbox", "file"],
      ["https://supabase.com/dashboard/project/id", "supabase", "database"],
      ["https://mail.google.com/mail/u/0/#inbox/message", "gmail", "message"],
      ["https://calendar.google.com/calendar/u/0/r", "googlecalendar", "event"],
      ["https://outlook.office.com/calendar/item", "microsoftoutlook", "event"],
      ["email://draft/weekly-update", "email", "message"],
      ["engram://topics/release-policy", "memory", "memory"],
      ["cloud://engram/preview/worker?token=secret#log", "deployment", "deployment"],
      ["deployment://project/preview", "deployment", "deployment"],
      ["database://engram/jobs", "database", "database"],
      ["sql://warehouse/schema/table", "database", "database"],
      ["postgres://db.internal/project", "postgresql", "database"],
    ];
    for (const [input, service, kind] of samples) expect(resourceIdentity(input)).toMatchObject({ service, kind });
  });

  test("rejects credentials, executable schemes and malformed provider claims", () => {
    for (const input of [
      "https://user:password@github.com/team/repo", "https://github.com@evil.example/team/repo", "https://github.com\\@evil.example/team/repo",
      "https://github.com/\nteam/repo", "https://github.com/team/%ZZ", "https://github.com/team/%2frepo", "https://github.com/team/%00repo",
      "javascript:alert(1)", "data:text/html,<img>", "engram://../secret", "engram://page?token=secret", "repo:../private", "repo:owner/repo/extra",
      "https://[github.com]/repo", "https://github.com:invalid/team/repo",
      "postgres://user:password@db.internal/project", "database://user:password@warehouse/schema", "cloud:project/worker", "cloud://project/%00worker",
    ]) expect(resourceIdentity(input)).toEqual({ service: "other", label: "Resource", kind: "resource" });
    for (const input of [
      "https://github.com.evil.example/team/repo", "https://evilgithub.com/team/repo", "https://gіthub.com/team/repo", "https://github.com./team/repo",
      "https://docs.google.com.evil.example/document/d/id", "https://evilslack.com/archives/channel", "https://slack.com.evil.example/path",
      "https://linear.app.evil.example/issue/ABC-1", "https://figma.com.evil.example/file/id", "https://github.com:8443/team/repo",
    ]) expect(resourceService(input)).toBe("browser");
  });

  test("labels exclude URL queries, fragments and user credentials", () => {
    for (const input of [
      "https://github.com/team/repo?email=ada@example.com&token=supersecret#private",
      "https://docs.google.com/document/d/doc-id/edit?email=ada@example.com&key=supersecret#private",
      "https://example.com/plan?recipient=ada@example.com&token=supersecret#private",
      "email://draft/weekly-update?to=ada@example.com&token=supersecret#private",
    ]) {
      const label = resourceIdentity(input).label;
      expect(label).not.toContain("ada@example.com"); expect(label).not.toContain("supersecret"); expect(label).not.toContain("private");
      expect(label).not.toContain("?"); expect(label).not.toContain("#private");
    }
    expect(resourceIdentity("https://ada:supersecret@example.com/plan").label).toBe("Resource");
    // Public consumers serialize service only, including when a private path
    // itself contains an email or an opaque secret rather than a URL query.
    expect(resourceService("https://example.com/ada@example.com/supersecret")).toBe("other");
    expect(resourceService("https://linear.app/team/issue/PRIVATE-42/private-title?token=secret")).toBe("linear");
  });

  test("the cross-boundary output is a finite immutable allowlist", () => {
    expect(Object.isFrozen(RESOURCE_SERVICES)).toBeTrue();
    for (const input of [null, undefined, 42, {}, [], "", "__proto__", "constructor", "x".repeat(5000), "not a provider", "https://example.com/"]) {
      expect(RESOURCE_SERVICES).toContain(resourceService(input));
    }
    expect(new Set(RESOURCE_SERVICES).size).toBe(RESOURCE_SERVICES.length);
  });
});
