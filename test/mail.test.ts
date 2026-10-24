import { describe, expect, test } from "bun:test";

process.env.ENGRAM_DB_URL_TEMPLATE ??= "postgresql://postgres:postgres@localhost:1/__DB__";

const {
  inviteLinkText,
  loginLinkResponse,
  loginLinkText,
  mailConfigured,
  mailFrom,
  sendMail,
  devLoginLinksAllowed,
} = await import("../gateway/src/mail");

describe("mail config", () => {
  test("defaults to the updates.ani.computer from-address", () => {
    expect(mailFrom({})).toBe("engram@updates.ani.computer");
    expect(mailConfigured({})).toBe(false);
    expect(mailConfigured({ RESEND_API_KEY: "re_test", ENGRAM_MAIL_FROM: "engram@updates.ani.computer" })).toBe(true);
    expect(mailConfigured({ RESEND_API_KEY: "unset" })).toBe(false);
  });
});

describe("mail copy", () => {
  test("login and invite bodies carry the link and an expiry", () => {
    expect(loginLinkText("https://engram.example/app#join=inv_x")).toContain("https://engram.example/app#join=inv_x");
    expect(loginLinkText("https://engram.example/app#join=inv_x")).toContain("24 hours");
    expect(inviteLinkText({
      orgName: "Ani HQ",
      invitedBy: "ada@ani.computer",
      url: "https://engram.example/app#join=inv_y",
    })).toContain("Ani HQ");
  });
});

describe("login link response", () => {
  test("omits the url once Resend accepted the message", () => {
    expect(loginLinkResponse("sent", "https://secret.example")).toEqual({
      status: 200,
      body: { sent: true },
    });
  });

  test("reveals a local development URL only with explicit opt-in", () => {
    expect(loginLinkResponse("skipped", "https://local.example", { ENGRAM_DEV_LOGIN_LINKS: "1" })).toEqual({
      status: 200,
      body: { sent: false, url: "https://local.example" },
    });
  });

  test("hosted mode never exposes a magic link even when the dev flag is set", () => {
    const env = { ENGRAM_DEPLOYMENT_MODE: "hosted", ENGRAM_DEV_LOGIN_LINKS: "1" };
    expect(devLoginLinksAllowed(env)).toBe(false);
    expect(loginLinkResponse("skipped", "https://secret.example", env)).toEqual({
      status: 503,
      body: { error: "email login is not configured" },
    });
    expect(loginLinkResponse("skipped", "https://secret.example", {}).body).not.toHaveProperty("url");
  });

  test("fails closed without leaking the url", () => {
    expect(loginLinkResponse("failed", "https://secret.example")).toEqual({
      status: 502,
      body: { error: "could not send email" },
    });
  });
});

describe("sendMail", () => {
  test("skips when the key is missing", async () => {
    let called = 0;
    const delivery = await sendMail(
      { to: "ada@example.com", subject: "x", text: "y" },
      { apiKey: "", from: "engram@updates.ani.computer", fetchImpl: (async () => {
        called += 1;
        return new Response("ok", { status: 200 });
      }) as typeof fetch },
    );
    expect(delivery).toBe("skipped");
    expect(called).toBe(0);
  });

  test("posts to Resend and reports sent", async () => {
    let body = "";
    const delivery = await sendMail(
      { to: "ada@example.com", subject: "Your engram login link", text: "link" },
      {
        apiKey: "re_test",
        from: "engram@updates.ani.computer",
        fetchImpl: (async (_url, init) => {
          body = String(init?.body ?? "");
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      },
    );
    expect(delivery).toBe("sent");
    expect(body).toContain("engram@updates.ani.computer");
    expect(body).toContain("ada@example.com");
  });

  test("reports failed when Resend rejects", async () => {
    const delivery = await sendMail(
      { to: "ada@example.com", subject: "x", text: "y" },
      {
        apiKey: "re_test",
        from: "engram@updates.ani.computer",
        fetchImpl: (async () => new Response("no", { status: 401 })) as typeof fetch,
      },
    );
    expect(delivery).toBe("failed");
  });
});
