import type { GenomeRule, Embedder } from "@apatureai/verdict-context";
import {
  createOpenAICompatibleCreate,
  DashScopeModelClient,
  type ModelClientFactory,
  type OpenAILikeClient,
} from "@apatureai/verdict-critique";
import type { ObjectStore } from "@apatureai/verdict-storage";
import type { CaptureContext } from "@apatureai/verdict-types";
import OpenAI from "openai";
import { z } from "zod";
import {
  GroundingAuthorityError,
  type GroundingAuthorityKey,
  type GroundingAuthorityPort,
  type GroundingAuthorityReceipt,
} from "./authority.js";
import type { MeasuredCapture, MeasuredCaptureInSandbox } from "./measurement.js";

/**
 * What a capture service measured while it captured (#19).
 *
 * The kinds are the closed `CheckKind` enum from `@apatureai/verdict-capture`, so a service
 * cannot introduce a measurement class the prompt builders and the breakage
 * classifier have never heard of. `detail` is the sentence the deep prompt
 * quotes verbatim, so it crosses as free text; nothing downstream parses it.
 */
const deterministicFindingSchema = z.object({
  kind: z.enum(["contrast", "overflow", "touch_target", "page_overflow"]),
  route: z.string().min(1),
  viewport: z.enum(["mobile", "tablet", "desktop"]),
  selector: z.string().min(1),
  detail: z.string().min(1),
  // Judge-unlock (§4.1): whether the check REPORTED this measurement or looked
  // and DECLINED it (an exception applied). Named here for the same `.strict()`
  // reason as `blockEligible`. Absent reads as reported.
  reported: z.boolean().optional(),
  declineReason: z.string().optional(),
  // Whether the fleet judged this measurement precise enough for a consumer to
  // gate a merge on. It has to be NAMED here even though it is optional: this
  // schema is `.strict()`, so a fleet that sends the field would otherwise have
  // its whole response REJECTED, which is exactly the trap `deterministicFindings`
  // itself fell into. Absent is UNKNOWN, and every reader treats unknown as not
  // gateable.
  blockEligible: z.boolean().optional(),
  // Which BAND of badness the fleet's check put this measurement in: an
  // ordinal, higher is worse, comparable only within a `kind`. Named here for
  // the same `.strict()` reason as `blockEligible`, and constrained to a
  // non-negative integer because that is what a band is; a fractional "band"
  // would be a magnitude leaking across the boundary that exists to stop
  // exactly that.
  //
  // Absent is UNKNOWN. Not zero, and never defaulted here: a band this engine
  // invented would be indistinguishable downstream from one a check measured.
  severity: z.number().int().nonnegative().optional(),
}).strict();

const captureSchema = z.object({
  images: z.array(z.object({
    route: z.string(),
    viewport: z.enum(["mobile", "tablet", "desktop"]),
    objectKey: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict()),
  geometry: z.array(z.object({
    route: z.string(),
    viewport: z.enum(["mobile", "tablet", "desktop"]),
    selector: z.string(),
    role: z.string().nullable(),
    rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict(),
    // Judge-unlock (§2.2/§2.6): the exact computed-style digest, the sanitized
    // own-text label, and the overflow flag. All optional and additive; named
    // here so a `.strict()` schema does not reject a fleet that reports them.
    style: z.object({
      fontFamily: z.string(),
      fontSizePx: z.number(),
      fontWeight: z.number(),
      lineHeightPx: z.number().nullable(),
      color: z.string(),
      backgroundColor: z.string(),
      paddingPx: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      marginPx: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      gapPx: z.tuple([z.number(), z.number()]).nullable(),
      borderRadiusPx: z.number(),
      display: z.string().nullable(),
    }).strict().optional(),
    label: z.string().optional(),
    overflowsX: z.boolean().optional(),
  }).strict()),
  pageHealth: z.object({
    consoleErrors: z.number().int().nonnegative(),
    failedRequests: z.number().int().nonnegative(),
    unstable: z.boolean(),
    blockedFonts: z.number().int().nonnegative().optional(),
    // What the repeat-capture determinism check compared, when it ran (#15).
    // Optional for the same reason `deterministicFindings` is: this schema is
    // `.strict()` and the fleet deploys separately, so a service that answers a
    // `verifyStability` request with counts must not have its whole response
    // rejected by an engine that predates the field, and a service that ignores
    // the request must not be forced to invent one.
    //
    // Absent is "not checked". `unstable: false` on its own stays the weaker
    // claim it has always been: nothing contradicted this capture.
    stability: z.object({
      pagesCompared: z.number().int().nonnegative(),
      unstablePages: z.number().int().nonnegative(),
    }).strict().optional(),
  }).strict(),
  captureVersion: z.string().min(1),
  // The measured half of the capture. Optional because the engine and the fleet
  // deploy separately, and because this schema is `.strict()`: before these two
  // fields existed, a capture service that ran the deterministic checks and
  // reported them had its whole response REJECTED here, which is why the
  // deployed engine has never had a measured fact in a deep prompt.
  //
  // Absent means "not measured", not "measured nothing"; an empty array is the
  // positive statement that the checks ran clean. `measurementGap` in
  // `measurement.ts` is what keeps those two answers apart.
  deterministicFindings: z.array(deterministicFindingSchema).optional(),
  // Judge-unlock (§4.1): measurements the checks declined (a WCAG-excused touch
  // target, a deliberate truncation). Optional/additive so a fleet that predates
  // the field is not rejected; surfaced to the model as its own territory.
  declinedFindings: z.array(deterministicFindingSchema).optional(),
  // Visible page text per route (#53). UNTRUSTED input: it is quoted into the
  // deep prompt inside `<untrusted_page_content>` and never followed.
  pageText: z.record(z.string(), z.string()).optional(),
}).strict();

const authorityReceiptSchema = z.object({
  contract_version: z.literal("uidna-authority/1"),
  status: z.enum(["effective", "superseded", "revoked"]),
  sequence: z.number().int().positive(),
  head_event_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  checked_at: z.iso.datetime(),
}).strict();

const authorityStatusAnswerSchema = authorityReceiptSchema.extend({
  dna_version: z.string().min(1).max(128),
});

const genomeSchema = z.object({
  snapshot: z.object({
    id: z.string().min(1),
    dna_version: z.string().min(1),
    approval_state: z.enum(["approved", "superseded"]),
    authority: authorityReceiptSchema,
  }).passthrough(),
  items: z.array(z.object({
    field_id: z.string().min(1),
    kind: z.string().min(1),
    value: z.record(z.string(), z.unknown()),
    applicability: z.object({
      component_kinds: z.array(z.string()).optional(),
    }).passthrough(),
  }).passthrough()),
}).passthrough();

export interface CaptureClient {
  /**
   * The capture seam for one job. Returns `MeasuredCaptureInSandbox` rather than
   * the bare `CaptureInSandbox` so the composition root can read what the service
   * MEASURED as well as what it captured; the two are structurally compatible,
   * so anything that only wants a `CaptureInSandbox` still takes this.
   */
  forJob(jobId: string, signal: AbortSignal): MeasuredCaptureInSandbox;
  cancel(jobId: string): Promise<void>;
  ready(): Promise<boolean>;
}

/** Remote binding to the isolated capture fleet owned by Judgment Engine. */
export class HttpCaptureClient implements CaptureClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  forJob(jobId: string, signal: AbortSignal): MeasuredCaptureInSandbox {
    return async (url: string, context: CaptureContext): Promise<MeasuredCapture> => {
      const response = await this.fetchImpl(new URL("/v1/captures", this.endpoint), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-engine-job-id": jobId,
        },
        body: JSON.stringify({ jobId, url, context }),
        signal,
      });
      if (!response.ok) throw new Error(`capture service returned ${response.status}`);
      return captureSchema.parse(await response.json());
    };
  }

  async cancel(jobId: string): Promise<void> {
    const response = await this.fetchImpl(new URL(`/v1/captures/${encodeURIComponent(jobId)}`, this.endpoint), {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`capture cancellation returned ${response.status}`);
    }
  }

  async ready(): Promise<boolean> {
    const response = await this.fetchImpl(new URL("/readyz", this.endpoint), {
      headers: { authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  }
}

export interface GenomeResolver {
  resolve(repository: string, installationId: string): Promise<{
    version: string;
    rules: GenomeRule[];
    authority: GroundingAuthorityReceipt;
  } | null>;
}

function toAuthorityReceipt(parsed: z.infer<typeof authorityReceiptSchema>): GroundingAuthorityReceipt {
  return {
    contractVersion: parsed.contract_version,
    status: parsed.status,
    sequence: parsed.sequence,
    headEventHash: parsed.head_event_hash as `sha256:${string}`,
    checkedAt: parsed.checked_at,
  };
}

/**
 * Tenant-scoped Source of Truth adapter for both the approved UI-DNA bundle and
 * its exact publication-time authority recheck.
 */
export class HttpGenomeResolver implements GenomeResolver, GroundingAuthorityPort {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 2_000,
  ) {}

  async resolve(repository: string, installationId: string): Promise<{
    version: string;
    rules: GenomeRule[];
    authority: GroundingAuthorityReceipt;
  } | null> {
    const url = new URL(`/v1/repos/${encodeURIComponent(repository)}/ui-dna`, this.endpoint);
    url.searchParams.set("max_items", "100");
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-apature-installation-id": installationId,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`genome service returned ${response.status}`);
    const parsed = genomeSchema.parse(await response.json());
    return {
      version: parsed.snapshot.dna_version,
      authority: toAuthorityReceipt(parsed.snapshot.authority),
      rules: parsed.items.map((item) => ({
        id: item.field_id,
        text: JSON.stringify({ kind: item.kind, value: item.value }),
        ...(item.applicability.component_kinds?.[0]
          ? { component: item.applicability.component_kinds[0] }
          : {}),
      })),
    };
  }

  async statusFor(key: GroundingAuthorityKey): Promise<GroundingAuthorityReceipt> {
    const url = new URL(
      `/v1/repos/${encodeURIComponent(key.repository)}/ui-dna/authority/${encodeURIComponent(key.dnaVersion)}`,
      this.endpoint,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          authorization: `Bearer ${this.token}`,
          "x-apature-installation-id": key.tenantId,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GroundingAuthorityError(
        "unavailable",
        `authority service unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 404) {
      throw new GroundingAuthorityError("missing", "authority evidence is unavailable for the exact DNA version");
    }
    if (!response.ok) {
      throw new GroundingAuthorityError("unavailable", `authority service returned ${response.status}`);
    }
    try {
      const parsed = authorityStatusAnswerSchema.parse(await response.json());
      if (parsed.dna_version !== key.dnaVersion) {
        throw new GroundingAuthorityError("malformed", "authority response did not match the requested version");
      }
      return toAuthorityReceipt(parsed);
    } catch (error) {
      if (error instanceof GroundingAuthorityError) throw error;
      throw new GroundingAuthorityError(
        "malformed",
        `authority response failed validation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface OpenAIAdapterOptions {
  apiKey: string;
  baseURL: string;
  embeddingModel?: string;
  objectStore: ObjectStore;
  signedImageTtlSeconds?: number;
}

/** Bind DashScope/self-host OpenAI-compatible model and embedding clients. */
export function createOpenAIAdapters(options: OpenAIAdapterOptions): {
  modelFactory: ModelClientFactory;
  embedder?: Embedder;
} {
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
  const create = createOpenAICompatibleCreate(client as unknown as OpenAILikeClient);
  const ttl = options.signedImageTtlSeconds ?? 900;
  const modelFactory: ModelClientFactory = (config) => new DashScopeModelClient(
    create,
    { resolveImageUrl: (image) => options.objectStore.signedGetUrl(image.objectKey, ttl) },
    config.backend,
  );
  const embedder: Embedder | undefined = options.embeddingModel
    ? async (texts) => {
        const response = await client.embeddings.create({
          model: options.embeddingModel as string,
          input: [...texts],
          encoding_format: "float",
        });
        return response.data.map((row) => row.embedding);
      }
    : undefined;
  return { modelFactory, ...(embedder ? { embedder } : {}) };
}
