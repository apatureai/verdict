import { describe, expect, it } from "vitest";
import { capturesDarkMode, planColorSchemeContexts } from "../src/index.js";
import type { Viewport } from "@apatureai/verdict-types";

const VIEWPORTS: Viewport[] = ["mobile", "tablet", "desktop"];

describe("planColorSchemeContexts (#21)", () => {
  it("captures only light when the repo does not declare dark-mode support", () => {
    const plan = planColorSchemeContexts({ viewports: VIEWPORTS, darkMode: false });
    expect(plan).toHaveLength(3);
    expect(plan.every((c) => c.colorScheme === "light")).toBe(true);
  });

  it("adds a dark pass for every viewport when dark mode is declared", () => {
    const plan = planColorSchemeContexts({ viewports: VIEWPORTS, darkMode: true });
    expect(plan).toHaveLength(6);
    const dark = plan.filter((c) => c.colorScheme === "dark");
    expect(dark.map((c) => c.viewport).sort()).toEqual(["desktop", "mobile", "tablet"]);
  });

  it("captures light and dark from SEPARATE contexts (one entry each per viewport)", () => {
    const plan = planColorSchemeContexts({ viewports: ["mobile"], darkMode: true });
    // Two distinct context objects for the same viewport, never one re-emulated.
    expect(plan).toEqual([
      { viewport: "mobile", colorScheme: "light", emulateBeforeGoto: true },
      { viewport: "mobile", colorScheme: "dark", emulateBeforeGoto: true },
    ]);
  });

  it("orders light before dark so the default theme is captured first", () => {
    const plan = planColorSchemeContexts({ viewports: VIEWPORTS, darkMode: true });
    const firstDark = plan.findIndex((c) => c.colorScheme === "dark");
    const lastLight = plan.map((c) => c.colorScheme).lastIndexOf("light");
    expect(lastLight).toBeLessThan(firstDark);
  });

  it("flags every context to emulate the scheme BEFORE goto (mount-time CSS-in-JS)", () => {
    const plan = planColorSchemeContexts({ viewports: VIEWPORTS, darkMode: true });
    expect(plan.every((c) => c.emulateBeforeGoto === true)).toBe(true);
  });

  it("handles an empty viewport list", () => {
    expect(planColorSchemeContexts({ viewports: [], darkMode: true })).toEqual([]);
  });
});

describe("capturesDarkMode", () => {
  it("runs the dark pass only when the repo declares support", () => {
    expect(capturesDarkMode({ darkMode: true })).toBe(true);
    expect(capturesDarkMode({ darkMode: false })).toBe(false);
  });
});
