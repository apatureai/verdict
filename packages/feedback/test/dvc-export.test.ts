import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "@apatureai/verdict-storage";
import {
  buildDvcDataset,
  dvcCachePath,
  pullDataset,
  pushDataset,
  removeSubject,
} from "../src/dvc-export.js";
import type { PreferenceExample } from "../src/preference-export.js";

function example(over: Partial<PreferenceExample> = {}): PreferenceExample {
  return {
    findingId: "finding-1",
    installationId: "inst-1",
    promptVersion: "stub@0",
    imageRef: "jobs/job-1/screenshot/home-desktop",
    contextHash: "ctx-abc",
    finding: {
      dimension: "spacing",
      severity: "minor",
      route: "/home",
      viewport: "desktop",
      elementRef: "main > section",
    },
    verdict: "endorsed",
    label: "desirable",
    trainingGrade: true,
    ...over,
  };
}

describe("buildDvcDataset", () => {
  it("content-addresses each tuple and produces a `.dir` version id", () => {
    const ds = buildDvcDataset([example()]);
    expect(ds.version).toMatch(/^[0-9a-f]{32}\.dir$/);
    expect(ds.objects).toHaveLength(1);
    expect(ds.objects[0]?.md5).toMatch(/^[0-9a-f]{32}$/);
    expect(ds.dir).toEqual([{ md5: ds.objects[0]?.md5, relpath: "stub@0/finding-1.json" }]);
  });

  it("is point-in-time reproducible (same tuples -> same version) regardless of input order", () => {
    const a = example({ findingId: "a" });
    const b = example({ findingId: "b" });
    const v1 = buildDvcDataset([a, b]).version;
    const v2 = buildDvcDataset([b, a]).version;
    expect(v1).toBe(v2);
  });

  it("sorts .dir entries by canonical UTF-8 relpath bytes", () => {
    const ids = [
      "cafe",
      "café",
      "cafz",
      "Apple",
      "apple",
      "a-b",
      "a.b",
      "a@b",
      "a_b",
      "ab",
      "finding-2",
      "finding-10",
      "finding.1",
      "finding_1",
      "βeta",
      "я",
      "あ",
      "中",
    ];
    const ds = buildDvcDataset(ids.map((findingId) => example({ findingId })));

    expect(ds.dir.map((entry) => entry.relpath)).toEqual([
      "stub@0/Apple.json",
      "stub@0/a-b.json",
      "stub@0/a.b.json",
      "stub@0/a@b.json",
      "stub@0/a_b.json",
      "stub@0/ab.json",
      "stub@0/apple.json",
      "stub@0/cafe.json",
      "stub@0/cafz.json",
      "stub@0/café.json",
      "stub@0/finding-10.json",
      "stub@0/finding-2.json",
      "stub@0/finding.1.json",
      "stub@0/finding_1.json",
      "stub@0/βeta.json",
      "stub@0/я.json",
      "stub@0/あ.json",
      "stub@0/中.json",
    ]);
  });

  it("changing one tuple changes only that object's id (and the dir), not its siblings", () => {
    const a = example({ findingId: "a" });
    const b = example({ findingId: "b" });
    const before = buildDvcDataset([a, b]);
    const after = buildDvcDataset([a, example({ findingId: "b", verdict: "dismissed", label: "undesirable" })]);

    const aBefore = before.objects.find((o) => o.relpath.endsWith("a.json"))?.md5;
    const aAfter = after.objects.find((o) => o.relpath.endsWith("a.json"))?.md5;
    const bBefore = before.objects.find((o) => o.relpath.endsWith("b.json"))?.md5;
    const bAfter = after.objects.find((o) => o.relpath.endsWith("b.json"))?.md5;

    expect(aAfter).toBe(aBefore); // unaffected sibling keeps its content address
    expect(bAfter).not.toBe(bBefore); // mutated tuple re-hashes
    expect(after.version).not.toBe(before.version); // dir changes
  });

  it("carries lineage from each entry back to finding / verdict / screenshot", () => {
    const ds = buildDvcDataset([example()]);
    expect(ds.lineage[0]).toEqual({
      relpath: "stub@0/finding-1.json",
      findingId: "finding-1",
      installationId: "inst-1",
      promptVersion: "stub@0",
      verdict: "endorsed",
      label: "desirable",
      screenshotRef: "jobs/job-1/screenshot/home-desktop",
      contextHash: "ctx-abc",
    });
  });
});

describe("dvcCachePath", () => {
  it("maps a file hash to files/md5/<aa>/<rest>", () => {
    expect(dvcCachePath("abcdef0123456789abcdef0123456789")).toBe(
      "files/md5/ab/cdef0123456789abcdef0123456789",
    );
  });

  it("keeps the .dir suffix on directory objects", () => {
    expect(dvcCachePath("abcdef0123456789abcdef0123456789.dir")).toBe(
      "files/md5/ab/cdef0123456789abcdef0123456789.dir",
    );
  });
});

describe("pushDataset / pullDataset (R2-backed remote)", () => {
  it("pushes objects + manifest, dedups on re-push, and reproduces the tuples", async () => {
    const store = new InMemoryObjectStore();
    const ds = buildDvcDataset([example({ findingId: "a" }), example({ findingId: "b" })]);

    const first = await pushDataset(store, ds);
    expect(first.pushed).toBe(3); // 2 tuples + 1 .dir manifest
    expect(first.skipped).toBe(0);

    // Content-addressed: a second push of the same version writes nothing new.
    const second = await pushDataset(store, ds);
    expect(second.pushed).toBe(0);
    expect(second.skipped).toBe(3);

    const pulled = await pullDataset(store, ds.dir);
    expect(pulled.map((p) => p.relpath)).toEqual(["stub@0/a.json", "stub@0/b.json"]);
  });

  it("fails a pull when a manifest-referenced object is missing", async () => {
    const store = new InMemoryObjectStore();
    const ds = buildDvcDataset([example()]);
    await expect(pullDataset(store, ds.dir)).rejects.toThrow(/missing/);
  });
});

describe("removeSubject (data-subject deletion)", () => {
  it("re-versions without a subject while surviving objects keep their content address", async () => {
    const keep = example({ findingId: "a", installationId: "inst-1" });
    const erase = example({ findingId: "b", installationId: "inst-2" });
    const store = new InMemoryObjectStore();

    const full = buildDvcDataset([keep, erase]);
    await pushDataset(store, full);

    const erased = removeSubject([keep, erase], (ex) => ex.installationId === "inst-2");
    expect(erased.lineage.map((l) => l.findingId)).toEqual(["a"]);
    expect(erased.version).not.toBe(full.version);

    // The kept tuple's object is unchanged, so the older version still resolves
    // its surviving objects from the remote (content-addressed history).
    const keptMd5 = full.objects.find((o) => o.relpath.endsWith("a.json"))?.md5;
    expect(erased.objects.find((o) => o.relpath.endsWith("a.json"))?.md5).toBe(keptMd5);
  });
});
