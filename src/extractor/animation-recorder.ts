import { chromium, type Page } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AnimationsOutput,
  CssAnimationRule,
  CssTransitionRule,
  HoverDiff,
  KeyframesRule,
  StyleMutationRecord,
  WebAnimationCall,
} from '../types/index.js';

export interface RecordAnimationsOptions {
  timeout?: number;
  settleMs?: number;
  hoverLimit?: number;
}

// Injected before any page script runs. Installs hooks that framer-motion
// ultimately funnels into — Element.animate (WAAPI) and inline `style` mutations —
// since the motion() component itself lives inside a bundled module and cannot
// be monkey-patched directly.
const INIT_SCRIPT = `
(() => {
  if (window.__FRAMER_EXTRACT_ANIMATIONS__) return;
  const store = {
    webAnimations: [],
    styleMutations: [],
  };
  window.__FRAMER_EXTRACT_ANIMATIONS__ = store;

  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    const eid = el.getAttribute && el.getAttribute('data-extract-id');
    if (eid) return '[data-extract-id="' + eid + '"]';
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(part + '#' + cur.id); break; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || 'html';
  }
  window.__FRAMER_EXTRACT_SELECTOR__ = selectorFor;

  // --- WAAPI hook (framer-motion v11+ emits animations here) ---
  const origAnimate = Element.prototype.animate;
  Element.prototype.animate = function(keyframes, timing) {
    try {
      let serKeyframes = null;
      try { serKeyframes = JSON.parse(JSON.stringify(keyframes)); } catch (e) {}
      let serTiming = null;
      if (typeof timing === 'number') serTiming = { duration: timing };
      else if (timing) { try { serTiming = JSON.parse(JSON.stringify(timing)); } catch (e) {} }
      store.webAnimations.push({
        selector: selectorFor(this),
        keyframes: serKeyframes,
        timing: serTiming,
        timestamp: performance.now(),
      });
    } catch (e) {}
    return origAnimate.apply(this, arguments);
  };

  // --- Inline style mutation observer ---
  function startObserver() {
    try {
      const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && m.attributeName === 'style' && m.target && m.target.nodeType === 1) {
            store.styleMutations.push({
              selector: selectorFor(m.target),
              timestamp: performance.now(),
              style: m.target.getAttribute('style') || '',
            });
          }
        }
      });
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style'],
        subtree: true,
      });
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  } else {
    startObserver();
  }
})();
`;

export async function recordAnimations(
  pageUrl: string,
  outputDir: string,
  options: RecordAnimationsOptions = {},
): Promise<AnimationsOutput & { path: string }> {
  const timeout = options.timeout ?? 60_000;
  const settleMs = options.settleMs ?? 1200;
  const hoverLimit = options.hoverLimit ?? 50;

  await fs.mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript({ content: INIT_SCRIPT });
    const page = await context.newPage();

    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout });
    await settle(page, settleMs);

    const parsed = (await page.evaluate(PARSE_STYLESHEETS_SCRIPT)) as {
      keyframes: Record<string, KeyframesRule>;
      cssTransitions: Record<string, CssTransitionRule[]>;
      cssAnimations: Record<string, CssAnimationRule[]>;
      hoverSelectors: string[];
      whileInViewCandidates: string[];
    };

    await scrollThroughPage(page);
    await settle(page, 400);

    const hoverStates = await simulateHovers(page, parsed.hoverSelectors, hoverLimit);

    // Return to top so any post-hover viewport state is neutral
    await page.evaluate(`window.scrollTo(0, 0)`);

    const recorded = (await page.evaluate(
      `window.__FRAMER_EXTRACT_ANIMATIONS__`,
    )) as { webAnimations: WebAnimationCall[]; styleMutations: StyleMutationRecord[] };

    await context.close();

    const output: AnimationsOutput = {
      url: pageUrl,
      keyframes: parsed.keyframes,
      cssTransitions: parsed.cssTransitions,
      cssAnimations: parsed.cssAnimations,
      webAnimations: recorded.webAnimations,
      styleMutations: recorded.styleMutations,
      hoverStates,
      whileInViewCandidates: parsed.whileInViewCandidates,
    };

    const outPath = path.join(outputDir, 'animations.json');
    await fs.writeFile(outPath, JSON.stringify(output, null, 2));
    return { ...output, path: outPath };
  } finally {
    await browser.close();
  }
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page
    .evaluate(
      `(() => { try { return document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true; } catch (e) { return true; } })()`,
    )
    .catch(() => {});
  await page.waitForTimeout(ms);
}

async function scrollThroughPage(page: Page): Promise<void> {
  const height = (await page.evaluate(`document.body.scrollHeight`)) as number;
  const step = 500;
  for (let y = 0; y <= height; y += step) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await page.waitForTimeout(180);
  }
}

async function simulateHovers(
  page: Page,
  hoverSelectors: string[],
  limit: number,
): Promise<HoverDiff[]> {
  const bases = new Set<string>();
  for (const sel of hoverSelectors) {
    // Drop :hover from the rule so we can locate the base element, then diff.
    const base = sel
      .split(',')
      .map((s) => s.trim().replace(/:hover\b/g, ''))
      .filter(Boolean)
      .join(', ');
    if (base) bases.add(base);
  }

  const results: HoverDiff[] = [];
  let count = 0;
  for (const base of bases) {
    if (count++ >= limit) break;
    try {
      const locator = page.locator(base).first();
      if ((await locator.count()) === 0) continue;

      const before = (await locator.evaluate(SNAPSHOT_STYLE_FN)) as Record<string, string>;
      await locator.hover({ timeout: 1500 });
      await page.waitForTimeout(220);
      const after = (await locator.evaluate(SNAPSHOT_STYLE_FN)) as Record<string, string>;

      const changes: Record<string, { from: string; to: string }> = {};
      for (const k of Object.keys(after)) {
        if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
      }
      if (Object.keys(changes).length > 0) {
        results.push({ selector: base, changes });
      }
    } catch {
      // Unreachable / covered / not hoverable — skip
    }
  }
  return results;
}

// ---------- Browser-side scripts ----------
//
// These are kept as plain string / Function literals (built via `new Function`)
// so tsx/esbuild's named-function helpers like `__name` never leak into the
// page context when Playwright serializes them.

const SNAPSHOT_STYLE_FN = new Function(
  'el',
  `var cs = getComputedStyle(el);
   var out = {};
   for (var i = 0; i < cs.length; i++) {
     var name = cs.item(i);
     out[name] = cs.getPropertyValue(name);
   }
   return out;`,
) as (el: Element) => Record<string, string>;

const PARSE_STYLESHEETS_SCRIPT = `(() => {
  var keyframes = {};
  var cssTransitions = {};
  var cssAnimations = {};
  var hoverSelectors = [];

  function splitList(s) {
    var out = [];
    var depth = 0;
    var cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function parseTransition(style) {
    var props = splitList(style.transitionProperty || 'all');
    var durs = splitList(style.transitionDuration || '0s');
    var tfs = splitList(style.transitionTimingFunction || 'ease');
    var delays = splitList(style.transitionDelay || '0s');
    var out = [];
    for (var i = 0; i < props.length; i++) {
      out.push({
        property: props[i],
        duration: durs[i % durs.length] || '0s',
        timingFunction: tfs[i % tfs.length] || 'ease',
        delay: delays[i % delays.length] || '0s',
      });
    }
    return out;
  }

  function parseAnimation(style) {
    var names = splitList(style.animationName || '');
    var durs = splitList(style.animationDuration || '0s');
    var tfs = splitList(style.animationTimingFunction || 'ease');
    var delays = splitList(style.animationDelay || '0s');
    var iters = splitList(style.animationIterationCount || '1');
    var fills = splitList(style.animationFillMode || 'none');
    var dirs = splitList(style.animationDirection || 'normal');
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (!name || name === 'none') continue;
      out.push({
        name: name,
        duration: durs[i % durs.length] || '0s',
        timingFunction: tfs[i % tfs.length] || 'ease',
        delay: delays[i % delays.length] || '0s',
        iterationCount: iters[i % iters.length] || '1',
        fillMode: fills[i % fills.length] || 'none',
        direction: dirs[i % dirs.length] || 'normal',
      });
    }
    return out;
  }

  function visit(rule) {
    if (rule.type === 7 || (rule.constructor && rule.constructor.name === 'CSSKeyframesRule')) {
      var frames = [];
      var kfs = rule.cssRules || [];
      for (var i = 0; i < kfs.length; i++) {
        var kf = kfs[i];
        if (!kf || !kf.style) continue;
        var style = {};
        for (var j = 0; j < kf.style.length; j++) {
          var name = kf.style.item(j);
          style[name] = kf.style.getPropertyValue(name);
        }
        frames.push({ offset: kf.keyText || '', style: style });
      }
      keyframes[rule.name] = { name: rule.name, frames: frames };
      return;
    }
    if (rule.cssRules && !(rule.type === 7)) {
      for (var k = 0; k < rule.cssRules.length; k++) {
        var r = rule.cssRules[k];
        if (r) visit(r);
      }
    }
    if (rule.selectorText) {
      var sel = rule.selectorText;
      if (sel.indexOf(':hover') !== -1) hoverSelectors.push(sel);
      var st = rule.style;
      if ((st.transitionProperty && st.transitionProperty !== 'all') || st.transition) {
        var tlist = parseTransition(st);
        if (tlist.length) cssTransitions[sel] = (cssTransitions[sel] || []).concat(tlist);
      }
      if (st.animationName && st.animationName !== 'none' && st.animationName !== '') {
        var alist = parseAnimation(st);
        if (alist.length) cssAnimations[sel] = (cssAnimations[sel] || []).concat(alist);
      }
    }
  }

  var sheets = document.styleSheets;
  for (var s = 0; s < sheets.length; s++) {
    var sheet = sheets[s];
    var rules = null;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    if (!rules) continue;
    for (var r = 0; r < rules.length; r++) {
      if (rules[r]) visit(rules[r]);
    }
  }

  var whileInViewCandidates = [];
  var marked = document.querySelectorAll('[data-framer-appear-id]');
  for (var m = 0; m < marked.length; m++) {
    var id = marked[m].getAttribute('data-framer-appear-id');
    if (id) whileInViewCandidates.push(id);
  }

  return {
    keyframes: keyframes,
    cssTransitions: cssTransitions,
    cssAnimations: cssAnimations,
    hoverSelectors: hoverSelectors,
    whileInViewCandidates: whileInViewCandidates,
  };
})()`;
