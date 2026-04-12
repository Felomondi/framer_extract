import { chromium, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  DOMNode,
  DomExtractResult,
  PseudoElementStyles,
  ViewportLabel,
  ViewportSnapshot,
} from '../types/index.js';

const VIEWPORTS: Array<{ label: ViewportLabel; width: number; height: number }> = [
  { label: 'xl', width: 1440, height: 900 },
  { label: 'lg', width: 1024, height: 768 },
  { label: 'md', width: 768, height: 1024 },
  { label: 'sm', width: 375, height: 812 },
];

const BASE: ViewportLabel = 'xl';
const EXTRACT_ATTR = 'data-extract-id';

// ---------------------------------------------------------------------------
// Browser-side scripts – plain ES5 strings for page.evaluate()
// ---------------------------------------------------------------------------

const WALK_SCRIPT = `(() => {
  var ATTR = ${JSON.stringify(EXTRACT_ATTR)};

  function styleOf(el) {
    var cs = getComputedStyle(el);
    var out = {};
    for (var i = 0; i < cs.length; i++) {
      var name = cs.item(i);
      out[name] = cs.getPropertyValue(name);
    }
    return out;
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function framerMetaFromAttrs(attrs) {
    var framerAttrs = {};
    var keys = Object.keys(attrs);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('data-framer-') === 0) framerAttrs[k] = attrs[k];
    }
    if (Object.keys(framerAttrs).length === 0) return undefined;
    return {
      attrs: framerAttrs,
      name: framerAttrs['data-framer-name'],
      componentType: framerAttrs['data-framer-component-type'],
      componentIdentifier: framerAttrs['data-framer-component-identifier'],
      appearId: framerAttrs['data-framer-appear-id'],
      isComponentRoot: 'data-framer-component-root' in framerAttrs,
      isBackgroundImage: 'data-framer-background-image-wrapper' in framerAttrs,
    };
  }

  function directText(el) {
    var t = '';
    var childNodes = el.childNodes;
    for (var i = 0; i < childNodes.length; i++) {
      var c = childNodes[i];
      if (c.nodeType === 3) t += c.nodeValue || '';
    }
    return t.trim();
  }

  function walk(el, id) {
    el.setAttribute(ATTR, id);

    var attributes = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes.item(i);
      if (!a || a.name === ATTR) continue;
      attributes[a.name] = a.value;
    }

    var children = [];
    var kids = el.children;
    for (var j = 0; j < kids.length; j++) {
      children.push(walk(kids[j], id + '.' + j));
    }

    var text = directText(el);
    var snap = {
      id: id,
      tag: el.tagName.toLowerCase(),
      attributes: attributes,
      framer: framerMetaFromAttrs(attributes),
      rect: rectOf(el),
      computedStyle: styleOf(el),
      responsive: {},
      children: children,
    };
    if (text) snap.text = text;
    return snap;
  }

  return walk(document.documentElement, '0');
})()`;

const RESPONSIVE_SCRIPT = `(() => {
  var ATTR = ${JSON.stringify(EXTRACT_ATTR)};
  var result = {};
  var nodes = document.querySelectorAll('[' + ATTR + ']');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var id = el.getAttribute(ATTR);
    if (!id) continue;
    var cs = getComputedStyle(el);
    var style = {};
    for (var j = 0; j < cs.length; j++) {
      var name = cs.item(j);
      style[name] = cs.getPropertyValue(name);
    }
    var r = el.getBoundingClientRect();
    result[id] = {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      computedStyle: style,
    };
  }
  return result;
})()`;

// Extracts ::before and ::after computed styles for every tagged element.
const PSEUDO_ELEMENTS_SCRIPT = `(() => {
  var ATTR = ${JSON.stringify(EXTRACT_ATTR)};
  var result = {};
  var els = document.querySelectorAll('[' + ATTR + ']');

  function pseudoStyle(el, pseudo) {
    var cs = getComputedStyle(el, pseudo);
    var content = cs.getPropertyValue('content');
    if (!content || content === 'none' || content === 'normal') return null;
    var out = {};
    for (var i = 0; i < cs.length; i++) {
      var name = cs.item(i);
      out[name] = cs.getPropertyValue(name);
    }
    return out;
  }

  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var id = el.getAttribute(ATTR);
    if (!id) continue;
    var before = pseudoStyle(el, '::before');
    var after  = pseudoStyle(el, '::after');
    if (before || after) {
      var entry = {};
      if (before) entry.before = before;
      if (after)  entry.after  = after;
      result[id] = entry;
    }
  }
  return result;
})()`;

// Walks the CSSOM to extract:
//  - CSS custom properties (:root and per-element scopes)
//  - Authored property values (preserves var() refs, gradient strings, transforms)
//  - Pseudo-class rule styles (:hover, :focus, :active)
const CSSOM_EXTRACT_SCRIPT = `(() => {
  var ATTR = ${JSON.stringify(EXTRACT_ATTR)};

  var rootVars = {};
  var elementVars = {};
  var authoredStyles = {};
  var pseudoClasses = {};

  var AUTHORED_PROPS = [
    'background', 'background-image', 'background-color',
    'transform', 'transform-origin',
    'filter', 'backdrop-filter',
    'box-shadow', 'text-shadow',
    'border-image', 'mask-image',
    'color', 'border-color', 'outline-color',
    'opacity', 'mix-blend-mode',
    'transition', 'animation'
  ];

  function getRules(sheet) {
    try { return sheet.cssRules || sheet.rules || []; }
    catch (e) { return []; }
  }

  function stripPseudo(selector) {
    var pseudos = [':hover', ':focus-visible', ':focus-within', ':focus', ':active'];
    var found = null;
    var base = selector;
    for (var i = 0; i < pseudos.length; i++) {
      if (selector.indexOf(pseudos[i]) !== -1) {
        found = pseudos[i];
        base = selector.split(pseudos[i]).join('');
        break;
      }
    }
    var key = null;
    if (found) {
      key = found.replace(/^:/, '');
      if (key === 'focus-visible' || key === 'focus-within') key = 'focus';
    }
    return { base: base.trim(), pseudo: key };
  }

  function isVarRef(val) { return val.indexOf('var(') !== -1; }
  function isGradient(val) { return /(?:linear|radial|conic)-gradient/i.test(val); }

  function shouldCapture(prop, val) {
    if (prop.indexOf('--') === 0) return false;
    if (isVarRef(val)) return true;
    if (isGradient(val)) return true;
    for (var i = 0; i < AUTHORED_PROPS.length; i++) {
      if (prop === AUTHORED_PROPS[i]) return true;
    }
    return false;
  }

  function processRule(rule) {
    if (rule.type !== 1 && rule.type !== 4 && rule.type !== 12) {
      if (rule.cssRules) {
        var nested = rule.cssRules;
        for (var n = 0; n < nested.length; n++) processRule(nested[n]);
      }
      return;
    }

    if (rule.type === 4) {
      try {
        var mql = rule.conditionText || rule.media.mediaText;
        if (!window.matchMedia(mql).matches) return;
      } catch (e) { /* proceed anyway */ }
      var mediaRules = rule.cssRules;
      for (var m = 0; m < mediaRules.length; m++) processRule(mediaRules[m]);
      return;
    }

    if (rule.type === 12) {
      var supRules = rule.cssRules;
      for (var s2 = 0; s2 < supRules.length; s2++) processRule(supRules[s2]);
      return;
    }

    var selectors = rule.selectorText.split(',');
    for (var s = 0; s < selectors.length; s++) {
      var rawSel = selectors[s].trim();

      // Skip pseudo-element selectors (handled separately)
      if (rawSel.indexOf('::') !== -1) continue;

      var parsed = stripPseudo(rawSel);

      // :root / html custom properties
      if (/^(:root|html)$/.test(rawSel)) {
        var rstyle = rule.style;
        for (var ri = 0; ri < rstyle.length; ri++) {
          var rp = rstyle.item(ri);
          if (rp.indexOf('--') === 0) {
            rootVars[rp] = rstyle.getPropertyValue(rp).trim();
          }
        }
        continue;
      }

      var baseSelector = parsed.base;
      if (!baseSelector) continue;

      var els;
      try { els = document.querySelectorAll(baseSelector); }
      catch (e) { continue; }

      for (var e = 0; e < els.length; e++) {
        var el = els[e];
        var id = el.getAttribute(ATTR);
        if (!id) continue;

        var style = rule.style;

        if (parsed.pseudo) {
          if (!pseudoClasses[id]) pseudoClasses[id] = {};
          if (!pseudoClasses[id][parsed.pseudo]) pseudoClasses[id][parsed.pseudo] = {};
          for (var pi = 0; pi < style.length; pi++) {
            var pp = style.item(pi);
            pseudoClasses[id][parsed.pseudo][pp] = style.getPropertyValue(pp).trim();
          }
        } else {
          for (var ci = 0; ci < style.length; ci++) {
            var cp = style.item(ci);
            var cv = style.getPropertyValue(cp).trim();

            if (cp.indexOf('--') === 0) {
              if (!elementVars[id]) elementVars[id] = {};
              elementVars[id][cp] = cv;
            }

            if (shouldCapture(cp, cv)) {
              if (!authoredStyles[id]) authoredStyles[id] = {};
              authoredStyles[id][cp] = cv;
            }
          }
        }
      }
    }
  }

  var sheets = document.styleSheets;
  for (var si = 0; si < sheets.length; si++) {
    var rules = getRules(sheets[si]);
    for (var ri2 = 0; ri2 < rules.length; ri2++) processRule(rules[ri2]);
  }

  // Also extract from inline styles (highest specificity, overrides sheet values)
  var tagged = document.querySelectorAll('[' + ATTR + ']');
  for (var ti = 0; ti < tagged.length; ti++) {
    var tel = tagged[ti];
    var tid = tel.getAttribute(ATTR);
    if (!tid) continue;
    var tstyle = tel.style;
    for (var tsi = 0; tsi < tstyle.length; tsi++) {
      var tp = tstyle.item(tsi);
      var tv = tstyle.getPropertyValue(tp).trim();

      if (tp.indexOf('--') === 0) {
        if (!elementVars[tid]) elementVars[tid] = {};
        elementVars[tid][tp] = tv;
      }

      if (shouldCapture(tp, tv)) {
        if (!authoredStyles[tid]) authoredStyles[tid] = {};
        authoredStyles[tid][tp] = tv;
      }
    }
  }

  return {
    rootVars: rootVars,
    elementVars: elementVars,
    authoredStyles: authoredStyles,
    pseudoClasses: pseudoClasses
  };
})()`;

const FONTS_READY_SCRIPT = `(() => {
  try { return document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true; }
  catch (e) { return true; }
})()`;

export interface DomExtractOptions {
  timeout?: number;
  settleMs?: number;
}

// Forces Framer's appear-animated elements into their final state so the walk
// doesn't capture them as invisible (opacity: 0 / translated off-screen).
// NOTE: filter is NOT reset here so backdrop-filter / filter effects survive.
const APPEAR_DEFEAT_CSS = `
  [data-framer-appear-id] {
    opacity: 1 !important;
    transform: none !important;
    visibility: visible !important;
  }
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
`;

interface CssomResult {
  rootVars: Record<string, string>;
  elementVars: Record<string, Record<string, string>>;
  authoredStyles: Record<string, Record<string, string>>;
  pseudoClasses: Record<string, Record<string, Record<string, string>>>;
}

export async function extractDom(
  pageUrl: string,
  outputDir: string,
  options: DomExtractOptions = {},
): Promise<DomExtractResult> {
  const settleMs = options.settleMs ?? 1500;
  const timeout = options.timeout ?? 60_000;

  await fs.mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  let tree: DOMNode;
  let cssCustomProperties: Record<string, string> = {};
  try {
    const context = await browser.newContext({
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
    });
    const page = await context.newPage();

    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout });
    await settle(page, settleMs);

    await page.addStyleTag({ content: APPEAR_DEFEAT_CSS });

    await scrollThroughPage(page);
    await page.evaluate(`window.scrollTo(0, 0)`);
    await settle(page, settleMs);

    // Phase 1: Walk the DOM tree (computed styles + structure)
    tree = (await page.evaluate(WALK_SCRIPT)) as DOMNode;

    // Phase 2: Extract pseudo-element styles
    const pseudoData = (await page.evaluate(PSEUDO_ELEMENTS_SCRIPT)) as Record<
      string,
      PseudoElementStyles
    >;

    // Phase 3: Extract CSSOM data (vars, authored values, pseudo-class rules)
    const cssomData = (await page.evaluate(CSSOM_EXTRACT_SCRIPT)) as CssomResult;
    cssCustomProperties = cssomData.rootVars;

    // Merge phases 2 & 3 onto the tree
    mergeCssomData(tree, cssomData, pseudoData);

    // Phase 4: Responsive snapshots
    for (const vp of VIEWPORTS) {
      if (vp.label === BASE) continue;
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await scrollThroughPage(page);
      await page.evaluate(`window.scrollTo(0, 0)`);
      await settle(page, settleMs);

      const [snapshots, vpPseudo] = await Promise.all([
        page.evaluate(RESPONSIVE_SCRIPT) as Promise<
          Record<string, { rect: ViewportSnapshot['rect']; computedStyle: Record<string, string> }>
        >,
        page.evaluate(PSEUDO_ELEMENTS_SCRIPT) as Promise<Record<string, PseudoElementStyles>>,
      ]);

      mergeResponsive(tree, vp.label, vp.width, snapshots, vpPseudo);
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const treePath = path.join(outputDir, 'dom-tree.json');
  const result: DomExtractResult = {
    url: pageUrl,
    viewports: Object.fromEntries(VIEWPORTS.map((v) => [v.label, v.width])) as Record<
      ViewportLabel,
      number
    >,
    baseViewport: BASE,
    tree,
    treePath,
    cssCustomProperties,
  };
  await fs.writeFile(treePath, JSON.stringify(result, null, 2));
  return result;
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(FONTS_READY_SCRIPT).catch(() => {});
  await page.waitForTimeout(ms);
}

async function scrollThroughPage(page: Page): Promise<void> {
  const height = (await page.evaluate(`document.body.scrollHeight`)) as number;
  const step = 500;
  for (let y = 0; y <= height + step; y += step) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await page.waitForTimeout(220);
  }
  const after = (await page.evaluate(`document.body.scrollHeight`)) as number;
  if (after > height) {
    for (let y = height; y <= after + step; y += step) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await page.waitForTimeout(220);
    }
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

// ---------------------------------------------------------------------------
// Tree-merge helpers
// ---------------------------------------------------------------------------

function mergeCssomData(
  node: DOMNode,
  cssom: CssomResult,
  pseudoData: Record<string, PseudoElementStyles>,
): void {
  const vars = cssom.elementVars[node.id];
  if (vars && Object.keys(vars).length > 0) {
    node.cssVariables = vars;
  }

  const authored = cssom.authoredStyles[node.id];
  if (authored && Object.keys(authored).length > 0) {
    node.authoredStyles = authored;
  }

  const pseudo = cssom.pseudoClasses[node.id];
  if (pseudo && Object.keys(pseudo).length > 0) {
    node.pseudoClassStyles = pseudo;
  }

  const pe = pseudoData[node.id];
  if (pe) {
    node.pseudoElements = pe;
  }

  for (const child of node.children) {
    mergeCssomData(child, cssom, pseudoData);
  }
}

function mergeResponsive(
  node: DOMNode,
  label: ViewportLabel,
  width: number,
  snapshots: Record<string, { rect: ViewportSnapshot['rect']; computedStyle: Record<string, string> }>,
  pseudoData: Record<string, PseudoElementStyles>,
): void {
  const snap = snapshots[node.id];
  if (snap) {
    const vpSnap: ViewportSnapshot = {
      width,
      rect: snap.rect,
      computedStyle: snap.computedStyle,
    };
    const pe = pseudoData[node.id];
    if (pe) {
      vpSnap.pseudoElements = pe;
    }
    node.responsive[label] = vpSnap;
  }
  for (const child of node.children) {
    mergeResponsive(child, label, width, snapshots, pseudoData);
  }
}
