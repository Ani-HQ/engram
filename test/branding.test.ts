import { describe, expect, test } from "bun:test";
import { ImplementationSchema } from "@modelcontextprotocol/sdk/types.js";

const { connectorBranding } = require("../shim/branding.js");

describe("public connector branding", () => {
  test("provides one valid shared MCP identity with a PNG before the optional SVG", () => {
    const brand = connectorBranding("https://engram.example/");
    expect(ImplementationSchema.parse(brand)).toEqual(brand);
    expect(brand).toMatchObject({ name: "engram", title: "Engram", websiteUrl: "https://engram.example/" });
    expect(brand.icons[0]).toEqual({ src: "https://engram.example/brand/engram-mark.png", mimeType: "image/png", sizes: ["512x512"] });
    expect(brand.icons[1]).toEqual({ src: "https://engram.example/brand/engram-mark.svg", mimeType: "image/svg+xml", sizes: ["any"] });
  });

  test("never publishes userinfo, path, query or fragment values from its host", () => {
    const brand = connectorBranding("https://brand-user:brand-password@engram.example/private-path?token=brand-token#brand-fragment");
    expect(brand).toEqual(connectorBranding("https://engram.example"));
    for (const value of ["brand-user", "brand-password", "private-path", "brand-token", "brand-fragment"]) expect(JSON.stringify(brand)).not.toContain(value);
    expect(Object.keys(brand).sort()).toEqual(["description", "icons", "name", "title", "version", "websiteUrl"]);
  });

  test("supports self-hosted HTTP origins and ports without sharing mutable results", () => {
    const first = connectorBranding("http://localhost:8100/mcp");
    expect(first.websiteUrl).toBe("http://localhost:8100/");
    first.icons[0].src = "https://unrelated.example/changed.png";
    expect(connectorBranding("http://localhost:8100").icons[0].src).toBe("http://localhost:8100/brand/engram-mark.png");
  });

  test("rejects unsupported origins with a bounded error that cannot echo input", () => {
    for (const input of ["javascript:brand-secret", "data:text/plain,brand-secret", "file:///brand-secret", "not-an-origin-brand-secret"]) {
      expect(() => connectorBranding(input)).toThrow("Engram branding requires an HTTP(S) origin");
    }
  });
});
