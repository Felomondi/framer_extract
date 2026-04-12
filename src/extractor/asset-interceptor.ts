import { chromium, type Page, type Response } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { AssetManifest, AssetType, InterceptResult } from '../types/index.js';

const SUBDIRS: Record<AssetType, string> = {
  image: 'images',
  svg: 'svgs',
  font: 'fonts',
  video: 'videos',
  css: 'css',
  js: 'js',
  other: 'other',
};

const EXT_TO_TYPE: Record<string, AssetType> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.avif': 'image',
  '.svg': 'svg',
  '.woff': 'font',
  '.woff2': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.mp4': 'video',
  '.webm': 'video',
  '.css': 'css',
  '.js': 'js',
  '.mjs': 'js',
};

const MIME_PATTERNS: Array<[RegExp, AssetType]> = [
  [/^image\/svg\+xml/, 'svg'],
  [/^image\//, 'image'],
  [/^font\//, 'font'],
  [/application\/font/, 'font'],
  [/application\/x-font/, 'font'],
  [/application\/vnd\.ms-fontobject/, 'font'],
  [/^video\//, 'video'],
  [/^text\/css/, 'css'],
  [/javascript/, 'js'],
];

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'text/css': '.css',
  'application/javascript': '.js',
  'text/javascript': '.js',
};

function normalizeContentType(contentType: string | undefined): string | undefined {
  return contentType?.split(';')[0].trim().toLowerCase();
}

function classify(url: string, contentType: string | undefined): AssetType | null {
  const ct = normalizeContentType(contentType);
  if (ct) {
    for (const [re, type] of MIME_PATTERNS) {
      if (re.test(ct)) return type;
    }
  }
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return EXT_TO_TYPE[ext] ?? null;
  } catch {
    return null;
  }
}

function extensionFor(type: AssetType, contentType: string | undefined, url: string): string {
  const ct = normalizeContentType(contentType);
  if (ct && MIME_TO_EXT[ct]) return MIME_TO_EXT[ct];
  try {
    const urlExt = path.extname(new URL(url).pathname).toLowerCase();
    if (urlExt && EXT_TO_TYPE[urlExt] === type) return urlExt;
  } catch {
    // fall through
  }
  return '';
}

function filenameFor(url: string, type: AssetType, contentType: string | undefined): string {
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = '';
  }
  const base = path.basename(pathname) || 'asset';
  const stem = (base.replace(/\.[^.]+$/, '') || 'asset')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 64);
  // Framer CDN transforms images via query params (?scale-down-to=512, etc).
  // Hash the full URL so transforms of the same source produce distinct files.
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  const ext = extensionFor(type, contentType, url);
  return `${stem}-${hash}${ext}`;
}

export interface InterceptOptions {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
}

export async function interceptAssets(
  pageUrl: string,
  outputDir: string,
  options: InterceptOptions = {},
): Promise<InterceptResult> {
  const assetsDir = path.join(outputDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const manifest: AssetManifest = {};
  const errors: Array<{ url: string; error: string }> = [];
  const pending: Array<Promise<void>> = [];
  const seen = new Set<string>();

  async function handleResponse(response: Response): Promise<void> {
    const url = response.url();
    if (seen.has(url)) return;
    seen.add(url);

    const status = response.status();
    if (status >= 400) return;
    if (url.startsWith('data:') || url.startsWith('blob:')) return;

    const contentType = response.headers()['content-type'];
    const type = classify(url, contentType);
    if (!type) return;

    try {
      const body = await response.body();
      const filename = filenameFor(url, type, contentType);
      const subdir = SUBDIRS[type];
      const relPath = path.posix.join('assets', subdir, filename);
      const absPath = path.join(outputDir, relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, body);
      manifest[url] = {
        localPath: relPath,
        type,
        contentType,
        size: body.length,
      };
    } catch (err) {
      errors.push({ url, error: (err as Error).message });
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('response', (response) => {
      pending.push(handleResponse(response));
    });

    await page.goto(pageUrl, {
      waitUntil: options.waitUntil ?? 'networkidle',
      timeout: options.timeout ?? 60_000,
    });

    // Scroll through the entire page so IntersectionObserver-driven lazy
    // images, videos, and fonts below the fold actually request themselves.
    await scrollThroughPage(page);
    await page.waitForLoadState('networkidle').catch(() => {});

    await Promise.all(pending);
    await context.close();
  } finally {
    await browser.close();
  }

  const manifestPath = path.join(assetsDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { manifest, manifestPath, assetsDir, errors };
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
  await page.evaluate(`window.scrollTo(0, 0)`);
}
