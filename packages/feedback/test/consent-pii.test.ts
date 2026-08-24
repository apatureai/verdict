import { pgliteExecutor, runMigrations } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { isPiiClean, scanForPii, TrainingConsentStore, trainingEligible } from "../src/index.js";

describe("PII scan (#74)", () => {
  it("flags emails, SSNs, credit cards, and phone numbers in text", () => {
    expect(scanForPii("contact a@b.com").some((m) => m.kind === "email")).toBe(true);
    expect(scanForPii("ssn 123-45-6789").some((m) => m.kind === "ssn")).toBe(true);
    expect(scanForPii("card 4111 1111 1111 1111").some((m) => m.kind === "credit_card")).toBe(true);
    expect(isPiiClean("just a normal spacing finding", "use the 8px scale")).toBe(true);
    expect(isPiiClean("email me at a@b.com")).toBe(false);
  });

  it("training-eligible only with consent AND clean text", () => {
    expect(trainingEligible({ consent: true, piiClean: true })).toBe(true);
    expect(trainingEligible({ consent: false, piiClean: true })).toBe(false);
    expect(trainingEligible({ consent: true, piiClean: false })).toBe(false);
  });
});

describe("TrainingConsentStore (#74)", () => {
  it("defaults to no consent and upserts the flag", async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    const store = new TrainingConsentStore(pgliteExecutor(db));

    expect(await store.getConsent("acme")).toBe(false); // default off
    await store.setConsent("acme", true);
    expect(await store.getConsent("acme")).toBe(true);
    await store.setConsent("acme", false);
    expect(await store.getConsent("acme")).toBe(false);
  });
});
