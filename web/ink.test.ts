import { describe, expect, test } from "bun:test";
import { DARK_PALETTE, INK_MIX_FLOOR, LIGHT_PALETTE, contrastRatio, inkColor, inkStepFor } from "./ink.js";

describe("ink recency", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  test("maps age monotonically from fresh to old", () => {
    const dates = [
      "2026-08-18T11:00:00Z",
      "2026-08-17T12:00:00Z",
      "2026-08-11T12:00:00Z",
      "2026-07-19T12:00:00Z",
      "2025-08-18T12:00:00Z",
      "2023-08-18T12:00:00Z",
    ];
    const steps = dates.map(date => inkStepFor(date, now));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]).toBeLessThanOrEqual(steps[i - 1]);
    }
  });

  test("clamps to the documented range", () => {
    const samples = [
      inkStepFor("2027-01-01T00:00:00Z", now),
      inkStepFor("2026-08-18T12:00:00Z", now),
      inkStepFor("2020-01-01T00:00:00Z", now),
      inkStepFor("not a date", now),
    ];
    for (const step of samples) {
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThanOrEqual(1);
    }
  });

  test("keeps the faded floor at WCAG AA contrast in both themes", () => {
    const floor = inkColor(0);
    expect(INK_MIX_FLOOR).toBeGreaterThanOrEqual(0.62);
    expect(contrastRatio(floor, LIGHT_PALETTE.gofun)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(floor, DARK_PALETTE.gofun)).toBeGreaterThanOrEqual(4.5);
  });
});
