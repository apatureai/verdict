/**
 * TS<->Python schema contract generator for the preference-dataset tuples (#123).
 *
 * The Python fine-tuning stack (`python/preference-dataset`) mirrors the
 * TypeScript `PreferenceExample` by hand. Nothing stops the two from silently
 * drifting: a renamed field or a new `Dimension` member on the TS side would
 * quietly poison a training set on the Python side. This script derives a single
 * canonical **contract artifact** straight from the TS source of truth:
 *
 *   - `packages/types/src/findings.ts`:             Dimension / Severity / Viewport
 *   - `packages/feedback/src/preference-export.ts`: PreferenceExample + KtoSource
 *   - `packages/feedback/src/dvc-export.ts`:         the real `canonicalJson`
 *
 * The artifact records every enum's members and every `PreferenceExample` /
 * `Finding` field, plus a few canonical-JSON samples produced by the *real*
 * serializer. Two guards consume it:
 *
 *   1. a TS regen check (`test/preference-contract.test.ts`) fails if the
 *      committed artifact no longer matches what this script regenerates, i.e.
 *      someone changed the TS types without regenerating;
 *   2. a Python pytest (`tests/test_contract.py`) asserts `schema.py` matches the
 *      artifact field-for-field and enum-for-enum, and that its `canonical_json`
 *      is byte-identical to the pinned samples.
 *
 * Extraction is purely syntactic (`ts.createSourceFile`, no type checker / no
 * module resolution), so this stays a cheap transform over the two files' text.
 *
 * Lives under `scripts/` (outside the `src/**` tsc build) so it can run directly
 * with Node's type stripping: `pnpm --filter @apatureai/verdict-feedback contract:gen`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { canonicalJson } from "../src/dvc-export.ts";
import type { PreferenceExample } from "../src/preference-export.ts";

/** A single field of a contract type. */
export interface ContractField {
  name: string;
  /** Underlying shape: a primitive, a named enum, or a nested type ref. */
  kind: "string" | "boolean" | "enum" | "ref";
  /** Enum name (when `kind === "enum"`), keyed into `enums`. */
  enum?: string;
  /** Referenced type name (when `kind === "ref"`), keyed into `types`. */
  ref?: string;
  /** The TS type admits `null`. */
  nullable: boolean;
  /** The TS property is optional (`?`). */
  optional: boolean;
}

export interface ContractType {
  fields: ContractField[];
}

export interface ContractSample {
  name: string;
  example: PreferenceExample;
  /** `canonicalJson(example)` from dvc-export.ts: the byte-exact wire form. */
  canonicalJson: string;
}

export interface Contract {
  $generatedBy: string;
  $sources: string[];
  $doc: string;
  version: number;
  enums: Record<string, string[]>;
  types: Record<string, ContractType>;
  canonicalSamples: ContractSample[];
}

/** Walk up from this file until the pnpm workspace root, so source-file reads are stable. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}

const ROOT = repoRoot();
const FINDINGS = join(ROOT, "packages/types/src/findings.ts");
const PREFERENCE_EXPORT = join(ROOT, "packages/feedback/src/preference-export.ts");
const ARTIFACT = join(ROOT, "contracts/preference-example.contract.json");

/** Absolute path of the committed contract artifact. */
export function contractArtifactPath(): string {
  return ARTIFACT;
}

function sourceFileFor(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
  );
}

function isNullNode(node: ts.TypeNode): boolean {
  return ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword;
}

function stringLiteralText(node: ts.TypeNode): string | null {
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
    ? node.literal.text
    : null;
}

/** Members of a string-literal union (or a single string-literal), in source order. */
function literalUnionMembers(type: ts.TypeNode): string[] {
  const nodes = ts.isUnionTypeNode(type) ? [...type.types] : [type];
  const members: string[] = [];
  for (const n of nodes) {
    const lit = stringLiteralText(n);
    if (lit !== null) members.push(lit);
  }
  return members;
}

function typeAliasUnion(sf: ts.SourceFile, name: string): string[] {
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && stmt.name.text === name) {
      const members = literalUnionMembers(stmt.type);
      if (members.length === 0) {
        throw new Error(`type alias ${name} in ${sf.fileName} is not a string-literal union`);
      }
      return members;
    }
  }
  throw new Error(`type alias ${name} not found in ${sf.fileName}`);
}

function interfaceDecl(sf: ts.SourceFile, name: string): ts.InterfaceDeclaration {
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === name) return stmt;
  }
  throw new Error(`interface ${name} not found in ${sf.fileName}`);
}

/** Enum names the classifier resolves by type reference (imported or aliased). */
const REFERENCED_ENUMS = new Set(["Dimension", "Severity", "Viewport", "KtoSource"]);

interface FieldContext {
  /** Nested TypeLiterals discovered on a property, keyed by the type name to emit. */
  nestedTypes: Map<string, ts.TypeLiteralNode>;
  /** Inline string-literal unions discovered on a property, keyed by enum name. */
  inlineEnums: Map<string, string[]>;
}

/** Non-`null` members of a (possibly nullable) type, and whether `null` was present. */
function splitNullable(type: ts.TypeNode): { members: ts.TypeNode[]; nullable: boolean } {
  if (!ts.isUnionTypeNode(type)) return { members: [type], nullable: false };
  const members: ts.TypeNode[] = [];
  let nullable = false;
  for (const n of type.types) {
    if (isNullNode(n)) nullable = true;
    else members.push(n);
  }
  return { members, nullable };
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function classifyField(prop: ts.PropertySignature, ctx: FieldContext): ContractField {
  const name = (prop.name as ts.Identifier).text;
  const optional = prop.questionToken !== undefined;
  if (!prop.type) throw new Error(`property ${name} has no type annotation`);

  const { members, nullable } = splitNullable(prop.type);
  if (members.length === 0) throw new Error(`property ${name} resolves to only null`);

  // An inline string-literal union (e.g. verdict/label) -> an enum named after the field.
  const asLiterals = members.map(stringLiteralText);
  if (asLiterals.every((m) => m !== null)) {
    const enumName = pascal(name);
    ctx.inlineEnums.set(enumName, asLiterals as string[]);
    return { name, kind: "enum", enum: enumName, nullable, optional };
  }

  if (members.length !== 1) {
    throw new Error(`property ${name} has an unsupported union type`);
  }
  const only = members[0]!;

  if (only.kind === ts.SyntaxKind.StringKeyword) {
    return { name, kind: "string", nullable, optional };
  }
  if (only.kind === ts.SyntaxKind.BooleanKeyword) {
    return { name, kind: "boolean", nullable, optional };
  }
  if (ts.isTypeReferenceNode(only)) {
    const refName = (only.typeName as ts.Identifier).text;
    if (REFERENCED_ENUMS.has(refName)) {
      return { name, kind: "enum", enum: refName, nullable, optional };
    }
    throw new Error(`property ${name} references unsupported type ${refName}`);
  }
  if (ts.isTypeLiteralNode(only)) {
    // A nested object literal (e.g. `finding`) -> a named contract type.
    const typeName = pascal(name);
    ctx.nestedTypes.set(typeName, only);
    return { name, kind: "ref", ref: typeName, nullable, optional };
  }
  throw new Error(`property ${name} has an unsupported type (kind ${only.kind})`);
}

function fieldsOf(members: readonly ts.TypeElement[], ctx: FieldContext): ContractField[] {
  const fields: ContractField[] = [];
  for (const m of members) {
    if (!ts.isPropertySignature(m)) {
      throw new Error("unexpected non-property member in contract type");
    }
    fields.push(classifyField(m, ctx));
  }
  return fields;
}

/** Representative tuples pinned for the cross-language byte-match. */
function canonicalSamples(): ContractSample[] {
  const full: PreferenceExample = {
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
    source: "thumbs",
    trainingGrade: true,
  };
  const dismissedWithNulls: PreferenceExample = {
    findingId: "finding-2",
    installationId: "inst-2",
    promptVersion: "v2",
    imageRef: null,
    contextHash: null,
    finding: {
      dimension: "color_contrast",
      severity: "blocker",
      route: "/pricing",
      viewport: "mobile",
      elementRef: null,
    },
    verdict: "dismissed",
    label: "undesirable",
    source: "implicit",
    trainingGrade: false,
  };
  return [
    { name: "full-endorsed", example: full, canonicalJson: canonicalJson(full) },
    {
      name: "dismissed-with-nulls",
      example: dismissedWithNulls,
      canonicalJson: canonicalJson(dismissedWithNulls),
    },
  ];
}

/** Build the contract descriptor from the current TS source of truth. */
export function buildContract(): Contract {
  const findings = sourceFileFor(FINDINGS);
  const prefExport = sourceFileFor(PREFERENCE_EXPORT);

  const enums: Record<string, string[]> = {
    Dimension: typeAliasUnion(findings, "Dimension"),
    Severity: typeAliasUnion(findings, "Severity"),
    Viewport: typeAliasUnion(findings, "Viewport"),
    KtoSource: typeAliasUnion(prefExport, "KtoSource"),
  };

  const ctx: FieldContext = { nestedTypes: new Map(), inlineEnums: new Map() };
  const example = interfaceDecl(prefExport, "PreferenceExample");
  const exampleFields = fieldsOf(example.members, ctx);

  const types: Record<string, ContractType> = {};
  // Emit nested types (e.g. Finding) discovered while classifying PreferenceExample.
  for (const [typeName, literal] of ctx.nestedTypes) {
    types[typeName] = { fields: fieldsOf(literal.members, ctx) };
  }
  types.PreferenceExample = { fields: exampleFields };

  // Fold in inline enums (verdict/label) discovered during classification.
  for (const [enumName, membersList] of ctx.inlineEnums) {
    enums[enumName] = membersList;
  }

  return {
    $generatedBy: "packages/feedback/scripts/preference-contract.ts",
    $sources: [
      "packages/types/src/findings.ts",
      "packages/feedback/src/preference-export.ts",
      "packages/feedback/src/dvc-export.ts",
    ],
    $doc:
      "Canonical TS<->Python schema contract for PreferenceExample. Generated; " +
      "regenerate with `pnpm --filter @apatureai/verdict-feedback contract:gen`. DO NOT EDIT BY HAND.",
    version: 1,
    enums,
    types,
    canonicalSamples: canonicalSamples(),
  };
}

/** The committed artifact's exact bytes (stable 2-space JSON, trailing newline). */
export function contractToJson(): string {
  return JSON.stringify(buildContract(), null, 2) + "\n";
}

// `node packages/feedback/scripts/preference-contract.ts` (re)writes the artifact.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(ARTIFACT, contractToJson(), "utf8");
  process.stdout.write(`wrote ${ARTIFACT}\n`);
}
