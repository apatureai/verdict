import { pgliteExecutor, runMigrations, type SqlExecutor } from "@apatureai/verdict-db";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FeedbackStore,
  extractSuggestionTokens,
  mergedWithBlockersUnresolved,
  suggestionMatchesDiff,
} from "../src/index.js";

describe("suggestion string-match (#39)", () => {
  it("extracts only significant tokens (classes, colors, values, hyphenated)", () => {
    const tokens = extractSuggestionTokens('Use the `gap-4` utility and set color to #1a73e8 (16px)');
    expect(tokens).toEqual(expect.arrayContaining(["gap-4", "#1a73e8", "16px"]));
  });

  it("records an implicit-positive only on a real token match in the later diff", () => {
    const suggestion = "Use the gap-4 utility on the card";
    expect(suggestionMatchesDiff(suggestion, '+ <div className="card gap-4">')).toBe(true);
    expect(suggestionMatchesDiff(suggestion, "+ <div className=\"card\">")).toBe(false);
  });

  it("does not false-positive on generic prose with no significant tokens", () => {
    expect(suggestionMatchesDiff("make the spacing nicer and more balanced", "+ lots of unrelated code")).toBe(false);
  });

  it("matches a token as a WHOLE unit, never as a substring of a different value", () => {
    // A dimension/hex/utility token must not match a DIFFERENT value that merely
    // contains it, which would label a fix "applied" when it was not.
    expect(suggestionMatchesDiff("set the gap to 16px", "+ padding: 116px;")).toBe(false); // 16px ⊄ 116px
    expect(suggestionMatchesDiff("set the gap to 16px", "+ gap: 16px;")).toBe(true); // exact value applied
    expect(suggestionMatchesDiff("use the gap-4 utility", '+ className="gap-40"')).toBe(false); // gap-4 ⊄ gap-40
    expect(suggestionMatchesDiff("use color #1a7", "+ color: #1a7;")).toBe(true);
    expect(suggestionMatchesDiff("use color #1a7", "+ color: #1a73e8;")).toBe(false); // #1a7 ⊄ #1a73e8
  });

  it("flags merged-with-blockers-unresolved", () => {
    expect(mergedWithBlockersUnresolved({ merged: true, unresolvedBlockerCount: 2 })).toBe(true);
    expect(mergedWithBlockersUnresolved({ merged: true, unresolvedBlockerCount: 0 })).toBe(false);
    expect(mergedWithBlockersUnresolved({ merged: false, unresolvedBlockerCount: 3 })).toBe(false);
  });
});

describe("FeedbackStore.recordImplicit (#39)", () => {
  let exec: SqlExecutor;
  let store: FeedbackStore;
  let findingId: string;

  beforeEach(async () => {
    const db = new PGlite();
    await runMigrations(pgliteExecutor(db));
    exec = pgliteExecutor(db);
    store = new FeedbackStore(exec);
    const { rows } = await exec.query<{ id: string }>(
      `INSERT INTO findings (installation_id, route, viewport, dimension, severity, confidence, model, prompt_version, engine_version, capture_version)
       VALUES ('1','/','desktop','spacing','blocker',0.9,'qwen3-vl-plus','v1','1.0.0','c1') RETURNING id`,
    );
    findingId = rows[0]!.id;
  });

  it("persists applied + merged_blockers_unresolved as implicit (no rater)", async () => {
    const applied = await store.recordImplicit(findingId, "applied");
    expect(applied).toMatchObject({ signal: "applied", source: "implicit", raterId: null, raterPermission: "write" });

    await store.recordImplicit(findingId, "merged_blockers_unresolved");
    const all = await store.forFinding(findingId);
    expect(all.map((f) => f.signal).sort()).toEqual(["applied", "merged_blockers_unresolved"]);
  });
});
