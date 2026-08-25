import type { Viewport } from "@apatureai/verdict-types";
import type { InteractiveElement, TextNodeStyle } from "./checks.js";
import { flattenBackground, flattenGradientBackdrops } from "./color.js";
import type { ExtractedElement, ExtractedPage } from "./browser-port.js";
import type { RawGeometryElement } from "./geometry.js";

/**
 * In-page DOM extraction (TRD §4.2). One `page.evaluate` round-trip collects
 * everything the grounded prompt needs: landmark rects for the geometry map
 * (#18), computed text styles for the deterministic contrast/overflow checks
 * (#19), pointer-target rects for the touch-target check, and the post-
 * `fonts.ready` font statuses that reveal a silently substituted web font (#83).
 *
 * The script is a plain expression string so the browser port stays a single
 * `evaluate(expression)` method; the normalizers below are pure and unit-tested
 * against recorded extractor payloads, with no browser needed.
 */

/**
 * Named allow-list (judge-unlock spec §2.3 Part A). The historic list was the
 * navigation + text-node vocabulary; the F3 failure was that `table`, `section`,
 * `header`, `footer`, `main`, `td`, `th` (and every card/bar) were never
 * captured, so the biggest defects on a page did not exist in any artifact this
 * system produces. Widened to the page-structure vocabulary, plus a bounded
 * structural scan (Part B, in the expression below) for the `div`-based layouts
 * CSS cannot name.
 */
const EXTRACT_SELECTOR =
  "h1,h2,h3,h4,h5,h6,nav,header,footer,main,section,article,aside,form,fieldset,legend," +
  "button,a,input,select,textarea,summary,details,dialog," +
  "p,li,ul,ol,dl,dt,dd,label,span,blockquote,pre,code," +
  "table,thead,tbody,tfoot,tr,th,td,caption," +
  "img,picture,figure,figcaption,video,canvas,iframe,svg,hr," +
  "[role]";

/**
 * The extractor, as an IIFE expression. Deliberately dependency-free and
 * defensive: a page that throws in a getter must not fail the capture.
 */
export const DOM_EXTRACT_EXPRESSION = `(() => {
  const MAX_ELEMENTS = 900;
  const MAX_SCANNED_NODES = 2000;
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html" && parts.length < 6) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
      const index = siblings.indexOf(node) + 1;
      parts.unshift(siblings.length > 1 ? tag + ":nth-of-type(" + index + ")" : tag);
      node = parent;
    }
    return parts.join(" > ");
  };
  // The background-color of the element and each ancestor, nearest first, up to
  // and including the first fully opaque one. Reporting the whole stack instead
  // of one pre-resolved color keeps every judgement (is this layer opaque? what
  // does a translucent one composite to?) in the pure, unit-tested normalizer
  // below, where it can be tested without a browser.
  //
  // It also reports whether anything in that stack paints something a flattened
  // COLOR cannot represent: a background-image or a backdrop-filter. White text
  // on a photo over a white base flattens to a 1:1 ratio nobody experiences, so
  // the contrast measurement is still emitted and marked as not gateable.
  //
  // The background-image VALUES come back too, one per layer, with a separate
  // flag for a backdrop-filter. "Obscured" lumps a photograph together with a
  // two-stop linear-gradient whose endpoints are ordinary sRGB colors, and only
  // one of those is genuinely unknowable. Telling them apart is a parsing
  // question, so it is answered in the pure normalizer below rather than in a
  // page script no unit test can reach.
  const backgroundStack = (el) => {
    const stack = [];
    const images = [];
    let obscured = false;
    let filtered = false;
    let node = el;
    while (node && stack.length < 32) {
      const style = getComputedStyle(node);
      const image = style.backgroundImage;
      if (image && image !== "none") obscured = true;
      const filter = style.backdropFilter || style.webkitBackdropFilter;
      if (filter && filter !== "none") { obscured = true; filtered = true; }
      // A paint effect composites the text against pixels no colour walk can
      // reach. mix-blend-mode was the sharper miss of the two: an element
      // rendering grey on black measured 5.24:1 against the real pixels and the
      // engine reported 3.95:1 against a white it never painted, which is a
      // false merge blocker on the one measurement nominated as ready to gate.
      // Partial opacity is the same blind spot in the other direction, hiding
      // text that genuinely renders at 2:1.
      // No backticks in this comment on purpose: this whole function is a
      // template literal injected into the page, and one would end the string.
      const blend = style.mixBlendMode;
      if (blend && blend !== "normal") { obscured = true; filtered = true; }
      const nodeOpacity = Number(style.opacity);
      if (Number.isFinite(nodeOpacity) && nodeOpacity > 0 && nodeOpacity < 1) {
        obscured = true;
        filtered = true;
      }
      const bg = style.backgroundColor;
      if (bg) {
        stack.push(bg);
        images.push(image || "none");
        const alpha = /^rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)$/.exec(bg);
        if (alpha === null || Number(alpha[1]) >= 1) break;
      }
      node = node.parentElement;
    }
    return { stack: stack, images: images, obscured: obscured, filtered: filtered };
  };
  // Whether any ANCESTOR scrolls horizontally. The overflowing element is very
  // often not the scroller: a wide row inside a .table-wrap, a long line inside
  // a scrolling code shell. Both compute overflow-x: visible on the text itself
  // and are reachable by the reader, so neither is the page coming apart.
  // Only auto/scroll/overlay count; a hidden or clipped ancestor really does
  // cut the content off, and that stays reportable.
  const SCROLLS_X = new Set(["auto", "scroll", "overlay"]);
  const ancestorScrollsX = (el) => {
    let node = el.parentElement;
    let hops = 0;
    while (node && hops < 32) {
      if (SCROLLS_X.has(getComputedStyle(node).overflowX)) return true;
      node = node.parentElement;
      hops += 1;
    }
    return false;
  };
  const isAnimated = (el) => {
    const s = getComputedStyle(el);
    if (s.animationName && s.animationName !== "none") return true;
    if (s.transitionDuration && s.transitionDuration !== "0s") return true;
    return typeof el.getAnimations === "function" && el.getAnimations().length > 0;
  };
  const INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "summary"]);
  const hasOwnText = (el) =>
    Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  // The element's OWN text (direct text nodes only), for the geometry label.
  const ownTextOf = (el) => {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.trim();
  };
  // Judge-unlock (spec §2.2): a compact, EXACT computed-style digest. Every value
  // is read off getComputedStyle, never estimated from pixels. No backticks in
  // this block: the whole function is a template literal injected into the page.
  const pxOf = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
  const firstFamily = (v) => {
    const first = String(v || "").split(",")[0] || "";
    return first.trim().replace(/^["']|["']$/g, "");
  };
  const toColor = (c) => {
    const s2 = String(c == null ? "" : c);
    const m = /^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*(?:,\\s*([0-9.]+)\\s*)?\\)$/.exec(s2);
    if (!m) return s2;
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if (a === 0) return "transparent";
    if (a < 1) return s2;
    const hex = (n) => ("0" + (Number(n) & 255).toString(16)).slice(-2);
    return "#" + hex(m[1]) + hex(m[2]) + hex(m[3]);
  };
  const styleDigest = (s) => {
    const disp = s.display;
    const isFlexGrid = disp === "flex" || disp === "inline-flex" || disp === "grid" || disp === "inline-grid";
    const lh = s.lineHeight;
    const radii = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map(pxOf);
    let maxRadius = 0;
    for (const r of radii) if (r > maxRadius) maxRadius = r;
    return {
      fontFamily: firstFamily(s.fontFamily),
      fontSizePx: pxOf(s.fontSize),
      fontWeight: parseInt(s.fontWeight, 10) || 400,
      lineHeightPx: (lh === "normal" || lh === "" || lh == null) ? null : pxOf(lh),
      color: toColor(s.color),
      backgroundColor: toColor(s.backgroundColor),
      paddingPx: [pxOf(s.paddingTop), pxOf(s.paddingRight), pxOf(s.paddingBottom), pxOf(s.paddingLeft)],
      marginPx: [pxOf(s.marginTop), pxOf(s.marginRight), pxOf(s.marginBottom), pxOf(s.marginLeft)],
      gapPx: isFlexGrid ? [pxOf(s.columnGap), pxOf(s.rowGap)] : null,
      borderRadiusPx: maxRadius,
      display: (disp === "block" || disp === "inline") ? null : disp,
    };
  };
  // True when this element's own box escapes the viewport, or it overflows itself.
  const overflowsXOf = (el, rect) => {
    try {
      if (rect.right + window.scrollX > window.innerWidth + 1) return true;
      if (el.scrollWidth > el.clientWidth + 1) return true;
    } catch (_) { /* getters may throw */ }
    return false;
  };
  const stableSel = (el) => {
    if (el.id) return "#" + el.id;
    const t = el.getAttribute("data-testid");
    if (t) return '[data-testid="' + t + '"]';
    return cssPath(el);
  };
  const isLayoutContainer = (el, s, rect) => {
    const d = s.display;
    if (d !== "flex" && d !== "inline-flex" && d !== "grid" && d !== "inline-grid") return false;
    if (el.children.length < 2) return false;
    return rect.width * rect.height >= 0.02 * window.innerWidth * window.innerHeight;
  };
  const out = [];
  const offenders = [];
  const namedSet = new Set(document.querySelectorAll(${JSON.stringify(EXTRACT_SELECTOR)}));
  const all = document.body ? document.body.querySelectorAll("*") : [];
  let scanned = 0;
  for (const el of all) {
    if (out.length >= MAX_ELEMENTS) break;
    let rect;
    try { rect = el.getBoundingClientRect(); } catch (_) { continue; }
    if (rect.width <= 0 || rect.height <= 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    // Part B (spec §2.3): a bounded structural scan admits div-based layout the
    // named allow-list cannot reach — anything escaping the viewport, overflowing
    // itself, or a substantial flex/grid container. Named elements are always
    // admitted; the scan cap only bounds the structural test.
    const isNamed = namedSet.has(el);
    let structural = false;
    if (!isNamed && scanned < MAX_SCANNED_NODES) {
      scanned += 1;
      structural = overflowsXOf(el, rect) || isLayoutContainer(el, style, rect);
    }
    // Record every escaping element as a candidate overflow offender.
    if (rect.right + window.scrollX > window.innerWidth + 1 && !ancestorScrollsX(el)) {
      offenders.push({ selector: stableSel(el), rightEdgePx: Math.round(rect.right + window.scrollX), widthPx: Math.round(rect.width) });
    }
    if (!isNamed && !structural) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const ownText = ownTextOf(el);
    const record = {
      tag: tag,
      id: el.id || null,
      testId: el.getAttribute("data-testid"),
      role: role,
      cssPath: cssPath(el),
      rect: {
        x: rect.x + window.scrollX,
        y: rect.y + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      animated: isAnimated(el),
      interactive: INTERACTIVE.has(tag) || role === "button" || role === "link",
      style: styleDigest(style),
      overflowsX: overflowsXOf(el, rect),
      ownText: ownText.length > 0 ? ownText : undefined,
      text: null,
    };
    if (record.interactive) {
      // The "Inline" exception both target-size criteria carry: a link in a
      // sentence is sized by the line-height of the prose around it. Detected
      // as "computes to an inline box AND its parent carries text of its own",
      // which is the shape of a link inside a paragraph and not the shape of a
      // nav item that merely happens to be inline.
      const parent = el.parentElement;
      const display = style.display;
      record.inlineTarget =
        (display === "inline" || display === "inline flow") &&
        parent !== null &&
        hasOwnText(parent);
    }
    if (hasOwnText(el)) {
      const backdrop = backgroundStack(el);
      record.text = {
        fontSizePx: parseFloat(style.fontSize) || 0,
        fontWeight: parseInt(style.fontWeight, 10) || 400,
        color: style.color,
        backgroundStack: backdrop.stack,
        backgroundImages: backdrop.images,
        backdropObscured: backdrop.obscured,
        backdropFiltered: backdrop.filtered,
        contentWidthPx: el.scrollWidth,
        // Reported so the overflow check can tell breakage from a deliberate
        // scroll container: a scrollWidth wider than the box is true of every
        // pre element with a scrollbar and every carousel, and those work.
        overflowX: style.overflowX,
        ancestorScrollsX: ancestorScrollsX(el),
        // The two properties that separate a clip the author chose from a clip
        // that lost content. A single nowrap line ending in an ellipsis is a
        // truncation with an affordance: the reader can SEE that the text was
        // cut. The same clip with text-overflow: clip shows a word ending
        // mid-glyph and says nothing. Reported raw; the check decides.
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
      };
    }
    out.push(record);
  }
  const fonts = [];
  try {
    document.fonts.forEach((f) => fonts.push({ family: f.family, status: f.status }));
  } catch (_) { /* FontFaceSet iteration is optional */ }
  const bodyText = document.body ? String(document.body.innerText || "").slice(0, 4000) : "";
  // What the root element itself composites over. The UA canvas is white unless
  // the page opted into a dark color-scheme, in which case the exact shade is a
  // UA implementation detail, so report it unknown and let the contrast check stay
  // silent rather than publish a guessed measurement as a fact.
  const rootScheme = String(getComputedStyle(document.documentElement).colorScheme || "normal").toLowerCase();
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const darkCanvas = rootScheme.indexOf("dark") >= 0 && (rootScheme.indexOf("light") < 0 || prefersDark);
  // Page-level overflow metrics (judge-unlock spec §2.3/§3.5). The widest
  // escaping element is what attributes the document scroll width to a concrete
  // selector (e.g. a 900px table), so the page_overflow finding names it.
  const SCROLLS_X2 = new Set(["auto", "scroll", "overlay"]);
  const rootOX = getComputedStyle(document.documentElement).overflowX;
  const bodyOX = document.body ? getComputedStyle(document.body).overflowX : "visible";
  offenders.sort((a, b) => b.rightEdgePx - a.rightEdgePx);
  return {
    elements: out,
    fonts: fonts,
    bodyText: bodyText,
    canvasBackground: darkCanvas ? null : "rgb(255, 255, 255)",
    documentHeight: Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
    ),
    documentWidth: Math.max(
      document.documentElement.scrollWidth,
      document.body ? document.body.scrollWidth : 0,
    ),
    viewportWidth: window.innerWidth,
    rootScrollsX: SCROLLS_X2.has(rootOX) || SCROLLS_X2.has(bodyOX),
    overflowOffenders: offenders.slice(0, 5),
  };
})()`;

/** Round to 2dp so a sub-pixel layout jitter can't churn the serialized geometry. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Project extracted elements into the geometry module's raw input shape. */
export function toRawGeometryElements(
  page: ExtractedPage,
  route: string,
  viewport: Viewport,
): RawGeometryElement[] {
  return page.elements.map((el) => ({
    route,
    viewport,
    tag: el.tag,
    id: el.id,
    testId: el.testId,
    role: el.role,
    cssPath: el.cssPath,
    rect: {
      x: round(el.rect.x),
      y: round(el.rect.y),
      width: round(el.rect.width),
      height: round(el.rect.height),
    },
    animated: el.animated,
    // Judge-unlock (spec §2.2/§2.3): carry the computed-style digest, own text,
    // overflow flag and interactivity through so the significance selector and
    // the style census can read them. All optional/additive; a capture too old
    // to report them leaves the map byte-identical.
    ...(el.style !== undefined ? { style: el.style } : {}),
    ...(el.ownText !== undefined ? { ownText: el.ownText } : {}),
    ...(el.overflowsX !== undefined ? { overflowsX: el.overflowsX } : {}),
    interactive: el.interactive,
  }));
}

/** Stable selector for the deterministic checks; same precedence as the geometry map. */
function selectorFor(el: ExtractedElement): string {
  if (el.id) return `#${el.id}`;
  if (el.testId) return `[data-testid="${el.testId}"]`;
  return el.cssPath.length > 0 ? el.cssPath : el.tag;
}

/**
 * Flatten one element's background stack onto the page canvas, as the CSS
 * string the contrast check consumes. `null` means "not determinable" (the
 * element sits on a chain that never reaches an opaque, parseable color), and
 * the check is required to stay silent about it.
 */
export function resolvedBackground(stack: readonly string[], canvas: string | null): string | null {
  const flat = flattenBackground(stack, canvas);
  return flat === null ? null : `rgb(${flat.r}, ${flat.g}, ${flat.b})`;
}

/**
 * The backdrop behind this text at each stop of a computable gradient, as CSS
 * strings, or `null` when the backdrop is not a computable gradient.
 *
 * `null` is the ordinary answer and covers a photograph, a filter, a gradient
 * in a colour space this engine does not read, and a fleet too old to report
 * what it painted. Only a gradient whose stops are all plain opaque colours
 * resolves, because only then is every point of the element's backdrop known.
 */
export function resolvedGradientBackdrops(
  stack: readonly string[],
  images: readonly string[] | undefined,
  filtered: boolean | undefined,
): string[] | null {
  // A filter is not computable at all, and an unreported one could be there.
  if (images === undefined || filtered !== false) return null;
  const stops = flattenGradientBackdrops(stack, images);
  return stops === null ? null : stops.map((stop) => `rgb(${stop.r}, ${stop.g}, ${stop.b})`);
}

/** Project text-bearing extracted elements into contrast/overflow check inputs (#19). */
export function toTextNodeStyles(
  page: ExtractedPage,
  route: string,
  viewport: Viewport,
): TextNodeStyle[] {
  const out: TextNodeStyle[] = [];
  for (const el of page.elements) {
    if (!el.text) continue;
    // Resolved here, next to the flat backdrop and by the same rule: the check
    // consumes a backdrop, never a stack. `null` for everything that is not a
    // gradient with plain opaque stops, which is nearly every background image.
    const gradient = resolvedGradientBackdrops(
      el.text.backgroundStack,
      el.text.backgroundImages,
      el.text.backdropFiltered,
    );
    out.push({
      route,
      viewport,
      selector: selectorFor(el),
      fontSizePx: el.text.fontSizePx,
      fontWeight: el.text.fontWeight,
      color: el.text.color,
      backgroundColor: resolvedBackground(el.text.backgroundStack, page.canvasBackground),
      ...(gradient !== null ? { backgroundGradient: gradient } : {}),
      rect: {
        x: round(el.rect.x),
        y: round(el.rect.y),
        width: round(el.rect.width),
        height: round(el.rect.height),
      },
      contentWidthPx: round(el.text.contentWidthPx),
      // All five carried verbatim, and each omitted when the extractor did not
      // report it: absent has to stay UNKNOWN all the way to the check, which
      // is the only place that decides what unknown costs.
      ...(el.text.overflowX !== undefined ? { overflowX: el.text.overflowX } : {}),
      ...(el.text.ancestorScrollsX !== undefined
        ? { ancestorScrollsX: el.text.ancestorScrollsX }
        : {}),
      ...(el.text.textOverflow !== undefined ? { textOverflow: el.text.textOverflow } : {}),
      ...(el.text.whiteSpace !== undefined ? { whiteSpace: el.text.whiteSpace } : {}),
      ...(el.text.backdropObscured !== undefined
        ? { backdropObscured: el.text.backdropObscured }
        : {}),
      // Already collected for every element and never read: a marquee or ticker
      // is clipped on purpose and its affordance is the motion.
      ...(el.animated ? { animated: true } : {}),
    });
  }
  return out;
}

/** Project pointer-targetable extracted elements into touch-target check inputs (#19). */
export function toInteractiveElements(
  page: ExtractedPage,
  route: string,
  viewport: Viewport,
): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  for (const el of page.elements) {
    if (!el.interactive) continue;
    out.push({
      route,
      viewport,
      selector: selectorFor(el),
      role: el.role,
      rect: {
        x: round(el.rect.x),
        y: round(el.rect.y),
        width: round(el.rect.width),
        height: round(el.rect.height),
      },
      // Omitted when the extractor did not report it, for the same reason as
      // the text fields: unknown must reach the check as unknown.
      ...(el.inlineTarget !== undefined ? { inlineTarget: el.inlineTarget } : {}),
    });
  }
  return out;
}
