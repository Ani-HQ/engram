import { expect, test } from "bun:test";
import { configuredJevModel, DEFAULT_JEV_MODEL, isJevModel, jevModelMatches } from "../gateway/src/jev-model";

test("the default is the stable alias, with explicit version overrides preserved", () => {
  expect(DEFAULT_JEV_MODEL).toBe("jev-latest");
  expect(configuredJevModel({})).toBe("jev-latest");
  expect(configuredJevModel({ REFLEX_MODEL: " jev-1.13.0 ", TYPESAFE_MODEL: "jev-latest" })).toBe("jev-1.13.0");
  expect(configuredJevModel({ TYPESAFE_MODEL: "jev-1.14.0" })).toBe("jev-1.14.0");
  expect(isJevModel(configuredJevModel({ REFLEX_MODEL: "" }))).toBe(false);
});

test("stable alias resolution is accepted without weakening explicit version matching", () => {
  expect(jevModelMatches("jev-latest", "jev-latest")).toBe(true);
  expect(jevModelMatches("jev-latest", "jev-1.13.0")).toBe(true);
  expect(jevModelMatches("jev-1.13.0", "jev-1.13.0")).toBe(true);
  expect(jevModelMatches("jev-1.13.0", "jev-1.14.0")).toBe(false);
  expect(jevModelMatches("jev-1.13.0", "jev-latest")).toBe(false);
  for (const model of ["jev-preview", "jev-next", "another-model", "jev-1.13", "jev-1.13.0\n", `jev-${"1".repeat(65)}.0.0`, "", null, 1]) {
    expect(isJevModel(model)).toBe(false);
    expect(jevModelMatches("jev-latest", model)).toBe(false);
    expect(jevModelMatches(model, "jev-latest")).toBe(false);
  }
});
