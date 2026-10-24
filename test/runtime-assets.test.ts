import { expect, test } from "bun:test";
import { remoteRuntimeReferences } from "./check-runtime-assets";

test("runtime privacy gate rejects remote scripts, styles, fonts, media and direct transports", () => {
  for (const source of ['<script src="https://cdn.example/app.js"></script>', '<script src=https://cdn.example/app.js></script>', '<link rel="stylesheet" href="//cdn.example/font.css">', '<link rel="preconnect" href="https://fonts.example">', '<img src="https://images.example/avatar.png">']) expect(remoteRuntimeReferences(source, ".html").length).toBeGreaterThan(0);
  expect(remoteRuntimeReferences('@font-face { src:url("https://fonts.example/font.woff2") }', ".css").length).toBeGreaterThan(0);
  expect(remoteRuntimeReferences('import("https://cdn.example/module.js")', ".js").length).toBeGreaterThan(0);
  expect(remoteRuntimeReferences('import "https://cdn.example/module.js"', ".js").length).toBeGreaterThan(0);
  expect(remoteRuntimeReferences('fetch("https://analytics.example/collect")', ".js").length).toBeGreaterThan(0);
});

test("ordinary external links, local assets and SVG namespaces do not create remote runtime dependencies", () => {
  expect(remoteRuntimeReferences('<a href="https://github.com/Ani-HQ/engram">Source</a><link rel="canonical" href="https://engram.ani.computer"><script src="/app.js"></script>', ".html")).toEqual([]);
  expect(remoteRuntimeReferences('document.createElementNS("http://www.w3.org/2000/svg", "svg"); fetch("/api/me")', ".js")).toEqual([]);
});
