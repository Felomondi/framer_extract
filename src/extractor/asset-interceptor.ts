import { chromium, type Page, type Response } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { AssetManifest, AssetType, InterceptResult, SrcsetEntry } from '../types/index.js';

// ---------------------------------------------------------------------------
// Public folder structure — assets land in the correct subdirectory
// ---------------------------------------------------------------------------

const PUBLIC_SUBDIRS: Record<AssetType, string> = {
  image: 'images',
  svg: 'icons',
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
  '.eot': 'font',
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
  'application/vnd.ms-fontobject': '.eot',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'text/css': '.css',
  'application/javascript': '.js',
  'text/javascript': '.js',
};

// ---------------------------------------------------------------------------
// Framer CDN URL handling
// ---------------------------------------------------------------------------

const FRAMER_CDN_HOSTS = [
  'framerusercontent.com',
  'framer.com',
  'assets.framer.com',
];

const FRAMER_TRANSFORM_PARAMS = [
  'scale-down-to',
  'lossless',
  'quality',
  'format',
  'w',
  'h',
  'fit',
  'dpr',
  'blur',
];

const SRCSET_WIDTHS = [640, 768, 1024, 1280, 1920];

function isFramerCdnUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return FRAMER_CDN_HOSTS.some((h) => u.hostname.includes(h));
  } catch {
    return false;
  }
}

function stripFramerTransforms(url: string): string {
  try {
    const u = new URL(url);
    let changed = false;
    for (const param of FRAMER_TRANSFORM_PARAMS) {
      if (u.searchParams.has(param)) {
        u.searchParams.delete(param);
        changed = true;
      }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

function buildSrcsetUrls(originalUrl: string): Array<{ url: string; width: number }> {
  if (!isFramerCdnUrl(originalUrl)) return [];
  const results: Array<{ url: string; width: number }> = [];
  try {
    for (const w of SRCSET_WIDTHS) {
      const u = new URL(stripFramerTransforms(originalUrl));
      u.searchParams.set('w', String(w));
      results.push({ url: u.toString(), width: w });
    }
  } catch {
    // not a valid URL
  }
  return results;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

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
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  const ext = extensionFor(type, contentType, url);
  return `${stem}-${hash}${ext}`;
}

function filenameForOriginal(url: string, type: AssetType, contentType: string | undefined): string {
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
  const ext = extensionFor(type, contentType, url);
  return `${stem}-original${ext}`;
}

function srcsetFilename(
  baseUrl: string,
  width: number,
  type: AssetType,
  contentType: string | undefined,
): string {
  let pathname = '';
  try {
    pathname = new URL(baseUrl).pathname;
  } catch {
    pathname = '';
  }
  const base = path.basename(pathname) || 'asset';
  const stem = (base.replace(/\.[^.]+$/, '') || 'asset')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 64);
  const ext = extensionFor(type, contentType, baseUrl);
  return `${stem}-${width}w${ext}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface InterceptOptions {
  timeout?: number;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  downloadOriginals?: boolean;
  generateSrcset?: boolean;
}

export async function interceptAssets(
  pageUrl: string,
  outputDir: string,
  options: InterceptOptions = {},
): Promise<InterceptResult> {
  const assetsDir = path.join(outputDir, 'assets');
  const downloadOriginals = options.downloadOriginals ?? true;
  const generateSrcset = options.generateSrcset ?? true;

  // Create the public/ folder structure
  for (const subdir of Object.values(PUBLIC_SUBDIRS)) {
    await fs.mkdir(path.join(assetsDir, subdir), { recursive: true });
  }

  const manifest: AssetManifest = {};
  const errors: Array<{ url: string; error: string }> = [];
  const pending: Array<Promise<void>> = [];
  const seen = new Set<string>();

  // Track Framer CDN images that need original downloads
  const originals = new Map<string, { transformedUrl: string; type: AssetType; contentType?: string }>();

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
      const subdir = PUBLIC_SUBDIRS[type];
      const filename = filenameFor(url, type, contentType);
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

      // If this is a Framer CDN image with transforms, queue original download
      if (type === 'image' && isFramerCdnUrl(url)) {
        const originalUrl = stripFramerTransforms(url);
        if (originalUrl !== url) {
          manifest[url].originalUrl = originalUrl;
          originals.set(originalUrl, { transformedUrl: url, type, contentType });
        }
      }
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

    // Also extract background-image URLs from computed styles
    const bgUrls = await extractBackgroundImageUrls(page);
    for (const bgUrl of bgUrls) {
      if (!seen.has(bgUrl)) {
        pending.push(downloadUrl(bgUrl, outputDir, manifest, errors, seen));
      }
    }

    // Extract video/audio URLs from DOM (video src, source src, poster)
    const videoUrls = await extractVideoUrls(page);
    for (const vidUrl of videoUrls) {
      if (!seen.has(vidUrl)) {
        pending.push(downloadUrl(vidUrl, outputDir, manifest, errors, seen));
      }
    }

    // Scroll to trigger lazy-loaded assets
    await scrollThroughPage(page);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Second pass for bg images and videos after scroll
    const bgUrlsAfterScroll = await extractBackgroundImageUrls(page);
    for (const bgUrl of bgUrlsAfterScroll) {
      if (!seen.has(bgUrl)) {
        pending.push(downloadUrl(bgUrl, outputDir, manifest, errors, seen));
      }
    }
    const videoUrlsAfterScroll = await extractVideoUrls(page);
    for (const vidUrl of videoUrlsAfterScroll) {
      if (!seen.has(vidUrl)) {
        pending.push(downloadUrl(vidUrl, outputDir, manifest, errors, seen));
      }
    }

    await Promise.all(pending);

    // Download original (untransformed) versions of Framer CDN images
    if (downloadOriginals) {
      const originalDownloads: Promise<void>[] = [];
      for (const [originalUrl, info] of originals) {
        if (seen.has(originalUrl)) continue;
        originalDownloads.push(
          downloadOriginalImage(originalUrl, info, outputDir, manifest, errors, seen),
        );
      }
      await Promise.all(originalDownloads);
    }

    // Generate srcset variants for Framer CDN images
    if (generateSrcset) {
      const srcsetDownloads: Promise<void>[] = [];
      for (const [url, record] of Object.entries(manifest)) {
        if (record.type !== 'image' || !isFramerCdnUrl(url)) continue;
        const srcsetUrls = buildSrcsetUrls(record.originalUrl ?? url);
        if (srcsetUrls.length === 0) continue;

        const entries: SrcsetEntry[] = [];
        for (const { url: srcUrl, width } of srcsetUrls) {
          if (seen.has(srcUrl)) continue;
          const fn = srcsetFilename(url, width, record.type, record.contentType);
          const subdir = PUBLIC_SUBDIRS[record.type];
          const relPath = path.posix.join('assets', subdir, fn);

          entries.push({ url: srcUrl, localPath: relPath, width });
          srcsetDownloads.push(
            downloadAndSave(srcUrl, path.join(outputDir, relPath), errors, seen),
          );
        }
        if (entries.length > 0) {
          record.srcset = entries;
        }
      }
      await Promise.all(srcsetDownloads);
    }

    await context.close();
  } finally {
    await browser.close();
  }

  const manifestPath = path.join(assetsDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { manifest, manifestPath, assetsDir, errors };
}

// ---------------------------------------------------------------------------
// Background image extraction
// ---------------------------------------------------------------------------

async function extractBackgroundImageUrls(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    var urls = [];
    var els = document.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var cs = getComputedStyle(els[i]);
      var bg = cs.backgroundImage;
      if (!bg || bg === 'none') continue;
      var matches = bg.match(/url\\(["']?([^"')]+)["']?\\)/g);
      if (!matches) continue;
      for (var j = 0; j < matches.length; j++) {
        var m = matches[j].match(/url\\(["']?([^"')]+)["']?\\)/);
        if (m && m[1] && !m[1].startsWith('data:')) {
          try {
            urls.push(new URL(m[1], location.href).toString());
          } catch(e) {}
        }
      }
    }
    return urls;
  })()`) as Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Video / media URL extraction from DOM
// ---------------------------------------------------------------------------

async function extractVideoUrls(page: Page): Promise<string[]> {
  return page.evaluate(`(() => {
    var urls = [];
    var seen = {};
    // <video src="...">
    var videos = document.querySelectorAll('video[src]');
    for (var i = 0; i < videos.length; i++) {
      var src = videos[i].getAttribute('src');
      if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
        try {
          var u = new URL(src, location.href).toString();
          if (!seen[u]) { urls.push(u); seen[u] = true; }
        } catch(e) {}
      }
      // Also check poster attribute
      var poster = videos[i].getAttribute('poster');
      if (poster && !poster.startsWith('data:')) {
        try {
          var pu = new URL(poster, location.href).toString();
          if (!seen[pu]) { urls.push(pu); seen[pu] = true; }
        } catch(e) {}
      }
    }
    // <source src="..."> inside <video> or <audio>
    var sources = document.querySelectorAll('video source[src], audio source[src]');
    for (var j = 0; j < sources.length; j++) {
      var ssrc = sources[j].getAttribute('src');
      if (ssrc && !ssrc.startsWith('data:') && !ssrc.startsWith('blob:')) {
        try {
          var su = new URL(ssrc, location.href).toString();
          if (!seen[su]) { urls.push(su); seen[su] = true; }
        } catch(e) {}
      }
    }
    return urls;
  })()`) as Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

async function downloadUrl(
  url: string,
  outputDir: string,
  manifest: AssetManifest,
  errors: Array<{ url: string; error: string }>,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(url)) return;
  seen.add(url);

  try {
    const response = await fetch(url);
    if (!response.ok) return;

    const contentType = response.headers.get('content-type') ?? undefined;
    const type = classify(url, contentType);
    if (!type) return;

    const body = Buffer.from(await response.arrayBuffer());
    const subdir = PUBLIC_SUBDIRS[type];
    const filename = filenameFor(url, type, contentType);
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

    if (type === 'image' && isFramerCdnUrl(url)) {
      const originalUrl = stripFramerTransforms(url);
      if (originalUrl !== url) {
        manifest[url].originalUrl = originalUrl;
      }
    }
  } catch (err) {
    errors.push({ url, error: (err as Error).message });
  }
}

async function downloadOriginalImage(
  originalUrl: string,
  info: { transformedUrl: string; type: AssetType; contentType?: string },
  outputDir: string,
  manifest: AssetManifest,
  errors: Array<{ url: string; error: string }>,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(originalUrl)) return;
  seen.add(originalUrl);

  try {
    const response = await fetch(originalUrl);
    if (!response.ok) return;

    const contentType = response.headers.get('content-type') ?? info.contentType;
    const body = Buffer.from(await response.arrayBuffer());
    const subdir = PUBLIC_SUBDIRS[info.type];
    const filename = filenameForOriginal(originalUrl, info.type, contentType);
    const relPath = path.posix.join('assets', subdir, filename);
    const absPath = path.join(outputDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body);

    manifest[originalUrl] = {
      localPath: relPath,
      type: info.type,
      contentType,
      size: body.length,
    };

    // Update the transformed record to point to the original
    const transformed = manifest[info.transformedUrl];
    if (transformed) {
      transformed.originalUrl = originalUrl;
    }
  } catch (err) {
    errors.push({ url: originalUrl, error: (err as Error).message });
  }
}

async function downloadAndSave(
  url: string,
  absPath: string,
  errors: Array<{ url: string; error: string }>,
  seen: Set<string>,
): Promise<void> {
  if (seen.has(url)) return;
  seen.add(url);

  try {
    const response = await fetch(url);
    if (!response.ok) return;

    const body = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body);
  } catch (err) {
    errors.push({ url, error: (err as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Page scrolling
// ---------------------------------------------------------------------------

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
