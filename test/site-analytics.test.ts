import { describe, expect, test } from "bun:test";
import { cleanHost, cleanPath, handleSiteEvent, parseAttribution, parseSiteEvent, recordSiteEvent, visitorFor } from "../gateway/src/site-analytics";

function fakeDb() {
  const rows: any[][] = [];
  const db: any = async (strings: TemplateStringsArray, ...values: any[]) => { if (strings.join("?").includes("INSERT INTO site_events")) rows.push(values); return []; };
  return { db, rows };
}
const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://engram.example/api/e", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", origin: "https://engram.example", "user-agent": "Mozilla/5.0 Safari", "cf-connecting-ip": "203.0.113.9", ...headers },
});

describe("site event parsing", () => {
  test("keeps only a clean path, never a query or fragment", () => {
    expect(cleanPath("/pricing?invite=abc#x")).toBe("/pricing");
    expect(cleanPath("/app")).toBe("/app");
    for (const bad of ["pricing", "//evil.example/x", "/a b", "/<script>", 42]) expect(cleanPath(bad)).toBeUndefined();
  });

  test("reduces referrers to a host and validates campaign tags", () => {
    expect(cleanHost("https://www.x.com/anirudh_twt/status/1?s=20")).toBe("x.com");
    expect(parseAttribution({ utmSource: "X", utmMedium: "social", utmCampaign: "launch-day", referrerHost: "news.ycombinator.com", landingPath: "/?ref=1" }))
      .toEqual({ utmSource: "x", utmMedium: "social", utmCampaign: "launch-day", referrerHost: "news.ycombinator.com", landingPath: "/" });
    expect(parseAttribution({ utmSource: "a b", utmCampaign: "x".repeat(200), email: "a@b.c" })).toEqual({ utmCampaign: "x".repeat(80) });
  });

  test("accepts only known events and calls to action", () => {
    expect(parseSiteEvent({ name: "pageview", path: "/" })?.name).toBe("pageview");
    expect(parseSiteEvent({ name: "cta", path: "/", cta: "ask-invite" })?.cta).toBe("ask-invite");
    for (const bad of [{ name: "cta", path: "/", cta: "anything" }, { name: "signup_submitted", path: "/app" }, { name: "pageview" }, null, []]) expect(parseSiteEvent(bad)).toBeNull();
  });
});

describe("collection", () => {
  test("records a page view with a daily visitor hash and no address or user agent", async () => {
    const { db, rows } = fakeDb();
    const response = await handleSiteEvent(request({ name: "pageview", path: "/pricing", utmSource: "x" }), { db, secret: "s" });
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows[0])).not.toContain("Safari");
  });

  test("respects Do Not Track, Global Privacy Control, bots and other origins", async () => {
    const { db, rows } = fakeDb();
    for (const headers of [{ dnt: "1" }, { "sec-gpc": "1" }, { "user-agent": "Googlebot/2.1" }, { origin: "https://elsewhere.example" }]) {
      expect((await handleSiteEvent(request({ name: "pageview", path: "/" }, headers), { db, secret: "s" })).status).toBe(204);
    }
    expect(await handleSiteEvent(request("not json"), { db, secret: "s" }).then(r => r.status)).toBe(204);
    expect(await handleSiteEvent(request("x".repeat(5000)), { db, secret: "s" }).then(r => r.status)).toBe(204);
    expect(rows).toHaveLength(0);
  });

  test("visitor hashes rotate daily and depend on a server secret", () => {
    const req = request({});
    const day1 = visitorFor(req, "s", new Date("2026-10-28T10:00:00Z")), sameDay = visitorFor(req, "s", new Date("2026-10-28T23:00:00Z"));
    expect(day1).toBe(sameDay);
    expect(visitorFor(req, "s", new Date("2026-10-29T00:00:00Z"))).not.toBe(day1);
    expect(visitorFor(req, "other", new Date("2026-10-28T10:00:00Z"))).not.toBe(day1);
  });

  test("a single visitor is rate limited and storage failures never throw", async () => {
    const { db, rows } = fakeDb();
    const req = () => request({ name: "pageview", path: "/" }, { "cf-connecting-ip": "198.51.100.77" });
    for (let i = 0; i < 40; i++) await handleSiteEvent(req(), { db, secret: "rate" });
    expect(rows.length).toBe(30);
    const failing: any = async () => { throw new Error("table missing"); };
    expect(await recordSiteEvent({ name: "pageview", path: "/" }, request({}, { "cf-connecting-ip": "192.0.2.1" }), { db: failing, secret: "s" })).toBe(false);
  });
});
