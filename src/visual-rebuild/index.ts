import { chromium } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { interceptAssets } from '../extractor/asset-interceptor.js';

// ---------------------------------------------------------------------------
// Breakpoints
// ---------------------------------------------------------------------------

const BREAKPOINTS = [
  { name: 'desktop', width: 1440 },
  { name: 'tablet', width: 1024 },
  { name: 'mobile-lg', width: 768 },
  { name: 'mobile', width: 375 },
] as const;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RebuildCaptureResult {
  screenshots: Array<{ name: string; path: string; width: number }>;
  contentPath: string;
  assetsDir: string;
  assetCount: number;
  errors: Array<{ url: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface RebuildOptions {
  timeout?: number;
}

export async function captureForRebuild(
  pageUrl: string,
  outputDir: string,
  options: RebuildOptions = {},
): Promise<RebuildCaptureResult> {
  const timeout = options.timeout ?? 60_000;

  const screenshotsDir = path.join(outputDir, 'screenshots');
  await fs.mkdir(screenshotsDir, { recursive: true });

  // ---- Step 1: Take screenshots at each breakpoint ----
  const screenshots: RebuildCaptureResult['screenshots'] = [];
  let textContent = '';

  const browser = await chromium.launch({ headless: true });
  try {
    for (const bp of BREAKPOINTS) {
      const context = await browser.newContext({
        viewport: { width: bp.width, height: 900 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();

      await page.goto(pageUrl, { waitUntil: 'networkidle', timeout });

      // Scroll through the page to trigger lazy loading
      await scrollThrough(page);
      await page.waitForLoadState('networkidle').catch(() => {});

      // Scroll back to top before screenshot
      await page.evaluate('window.scrollTo(0, 0)');
      await page.waitForTimeout(300);

      const screenshotPath = path.join(screenshotsDir, `${bp.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      screenshots.push({ name: bp.name, path: `screenshots/${bp.name}.png`, width: bp.width });

      // Extract text content from the first (desktop) breakpoint only
      if (bp.name === 'desktop') {
        textContent = await page.evaluate('document.body.innerText') as string;
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  // ---- Step 2: Save text content ----
  const contentPath = path.join(outputDir, 'content.txt');
  await fs.writeFile(contentPath, textContent, 'utf8');

  // ---- Step 3: Download assets (reuse existing interceptor) ----
  const interceptResult = await interceptAssets(pageUrl, outputDir, {
    downloadOriginals: true,
    generateSrcset: false,
  });

  return {
    screenshots,
    contentPath: 'content.txt',
    assetsDir: 'assets',
    assetCount: Object.keys(interceptResult.manifest).length,
    errors: interceptResult.errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function scrollThrough(page: import('playwright').Page): Promise<void> {
  const height = (await page.evaluate('document.body.scrollHeight')) as number;
  const step = 600;
  for (let y = 0; y <= height + step; y += step) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await page.waitForTimeout(150);
  }
}
