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
const { renderEmail } = await import("../gateway/src/mail-templates");

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

  test("legacy text helpers use the canonical email templates", () => {
    const url = "https://engram.example/app#join=inv_example";
    expect(loginLinkText(url)).toBe(renderEmail({ template: "login", url }).text);
    const input = { orgName: "Ani HQ", invitedBy: "ada@example.com", url };
    expect(inviteLinkText(input)).toBe(renderEmail({ template: "team-invite", ...input }).text);
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

  test("sends HTML, reply-to, and unsubscribe headers while keeping idempotency in the HTTP envelope", async () => {
    let payload: any, options: RequestInit | undefined;
    const delivery = await sendMail({ to: "ada@example.com", subject: "Welcome", text: "Plain text", html: "<p>Welcome</p>", replyTo: "support@example.com", headers: { "List-Unsubscribe": "<https://engram.example/unsubscribe>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, idempotencyKey: "engram-welcome:42" }, {
      apiKey: "re_test", from: "Engram <engram@example.com>", fetchImpl: (async (_url, init) => { options = init; payload = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); }) as typeof fetch,
    });
    expect(delivery).toBe("sent"); expect(payload).toMatchObject({ html: "<p>Welcome</p>", text: "Plain text", reply_to: "support@example.com", headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    expect(payload).not.toHaveProperty("idempotencyKey"); expect(new Headers(options?.headers).get("Idempotency-Key")).toBe("engram-welcome:42"); expect(options?.signal).toBeInstanceOf(AbortSignal); expect(options?.redirect).toBe("error");
  });

  test("times out even a transport that never settles and does not retry", async () => {
    let calls = 0, signal: AbortSignal | null | undefined;
    const result = await sendMail({ to: "ada@example.com", subject: "Example", text: "Content" }, { apiKey: "re_test", timeoutMs: 5, fetchImpl: (async (_url, init) => { calls++; signal = init?.signal; return new Promise(() => {}); }) as typeof fetch });
    expect(result).toBe("failed"); expect(calls).toBe(1); expect(signal?.aborted).toBe(true);
  });

  test("rejects malformed envelope/header values without contacting the provider", async () => {
    let calls = 0;
    const deps = { apiKey: "re_test", fetchImpl: (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch };
    const base = { to: "ada@example.com", subject: "Example", text: "Content" };
    for (const invalid of [{ subject: "Hello\r\nBcc: attacker@example.com" }, { replyTo: "bad\n@example.com" }, { headers: { From: "attacker@example.com" } }, { headers: { "X-Example": "unsafe\nvalue" } }, { idempotencyKey: "unsafe\nkey" }]) expect(await sendMail({ ...base, ...invalid }, deps)).toBe("failed");
    expect(calls).toBe(0);
  });

  test("contains a thrown provider failure without exposing its message or resending", async () => {
    let calls = 0;
    expect(await sendMail({ to: "ada@example.com", subject: "Example", text: "Content" }, { apiKey: "re_test", fetchImpl: (async () => { calls++; throw new Error("private provider information"); }) as typeof fetch })).toBe("failed");
    expect(calls).toBe(1);
  });
});
