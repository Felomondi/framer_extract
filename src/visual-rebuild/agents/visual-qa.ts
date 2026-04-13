import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { prepareImageForApi } from '../image-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const BREAKPOINTS = [
  { name: 'desktop', width: 1440 },
  { name: 'tablet', width: 1024 },
  { name: 'mobile-lg', width: 768 },
  { name: 'mobile', width: 375 },
] as const;

export interface VisualFix {
  component: string;
  selector: string;
  fix: string;
}

export interface QAIterationResult {
  iteration: number;
  fixes: VisualFix[];
  screenshotsDir: string;
}

export interface VisualQAResult {
  iterations: QAIterationResult[];
  converged: boolean;
  totalFixesApplied: number;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const COMPARE_PROMPT = `Compare these two screenshots. The first is the original website, the second is our generated version.

List every visual difference you can see:
- Layout issues (spacing, alignment, sizing)
- Color mismatches
- Typography differences
- Missing or incorrect elements

For each issue, specify:
- component: which component file to fix
- selector: CSS selector or element description
- fix: exact Tailwind classes or CSS to add/change

Output as JSON array of fixes. If no significant differences remain, output an empty array [].`;

const APPLY_FIXES_PROMPT_PREFIX = `Here is a React component file using Tailwind CSS:

\`\`\`tsx
`;

const APPLY_FIXES_PROMPT_SUFFIX = (fixes: string) => `\`\`\`

Apply these fixes to the component. Each fix describes a visual issue and the correction needed:

${fixes}

Output only the corrected code, no explanation.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 3;
const VITE_PORT = 3456;
const VITE_READY_TIMEOUT = 30_000;

export async function runVisualQA(
  outputDir: string,
  model = 'claude-sonnet-4-20250514',
): Promise<VisualQAResult> {
  // Install deps first
  await installDeps(outputDir);

  const iterations: QAIterationResult[] = [];
  let totalFixesApplied = 0;
  let converged = false;

  let viteProcess: ChildProcess | null = null;

  try {
    // Start Vite dev server
    viteProcess = await startVite(outputDir);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const iterationNum = i + 1;

      // Screenshot the running output at all breakpoints
      const genScreenshotsDir = path.join(
        outputDir, 'screenshots', `qa-iteration-${iterationNum}`,
      );
      await fs.mkdir(genScreenshotsDir, { recursive: true });
      await screenshotAllBreakpoints(`http://localhost:${VITE_PORT}`, genScreenshotsDir);

      // Compare original vs generated for each breakpoint, collect all fixes
      const allFixes: VisualFix[] = [];
      for (const bp of BREAKPOINTS) {
        const originalPath = path.join(outputDir, 'screenshots', `${bp.name}.png`);
        const generatedPath = path.join(genScreenshotsDir, `${bp.name}.png`);

        try {
          await fs.access(originalPath);
          await fs.access(generatedPath);
        } catch {
          continue;
        }

        const fixes = await compareScreenshots(originalPath, generatedPath, bp.name, model);
        allFixes.push(...fixes);
      }

      // Deduplicate fixes by component + selector
      const dedupedFixes = deduplicateFixes(allFixes);

      iterations.push({
        iteration: iterationNum,
        fixes: dedupedFixes,
        screenshotsDir: path.relative(outputDir, genScreenshotsDir),
      });

      if (dedupedFixes.length === 0) {
        converged = true;
        break;
      }

      // Group fixes by component and apply
      const fixesByComponent = groupByComponent(dedupedFixes);
      for (const [componentFile, fixes] of Object.entries(fixesByComponent)) {
        const applied = await applyFixes(outputDir, componentFile, fixes, model);
        if (applied) totalFixesApplied += fixes.length;
      }

      // Give Vite HMR a moment to pick up changes
      await sleep(2000);
    }
  } finally {
    if (viteProcess) {
      killProcess(viteProcess);
    }
  }

  // Save QA report
  const report = { iterations, converged, totalFixesApplied };
  await fs.writeFile(
    path.join(outputDir, 'qa-report.json'),
    JSON.stringify(report, null, 2),
  );

  return report;
}

// ---------------------------------------------------------------------------
// Vite dev server management
// ---------------------------------------------------------------------------

async function installDeps(outputDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['install'], {
      cwd: outputDir,
      stdio: 'pipe',
      shell: true,
    });

    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed (exit ${code}): ${stderr.slice(0, 500)}`));
    });

    proc.on('error', reject);
  });
}

async function startVite(outputDir: string): Promise<ChildProcess> {
  const proc = spawn('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], {
    cwd: outputDir,
    stdio: 'pipe',
    shell: true,
  });

  // Wait for "ready" or the local URL to appear in stdout
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Vite did not start within ${VITE_READY_TIMEOUT}ms`));
    }, VITE_READY_TIMEOUT);

    let output = '';
    const onData = (data: Buffer) => {
      output += data.toString();
      if (output.includes(`localhost:${VITE_PORT}`) || output.includes('ready in')) {
        clearTimeout(timeout);
        proc.stdout?.off('data', onData);
        resolve();
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(new Error(`Vite exited with code ${code}: ${output.slice(0, 500)}`));
      }
    });
  });

  // Extra buffer for Vite to be fully ready
  await sleep(1000);

  return proc;
}

function killProcess(proc: ChildProcess): void {
  try {
    // Kill the process group (Vite spawns child processes)
    if (proc.pid) {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    // Process might already be dead
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

async function screenshotAllBreakpoints(
  baseUrl: string,
  screenshotsDir: string,
): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const bp of BREAKPOINTS) {
      const context = await browser.newContext({
        viewport: { width: bp.width, height: 900 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();

      await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });

      // Scroll through to trigger any lazy rendering
      const height = (await page.evaluate('document.body.scrollHeight')) as number;
      for (let y = 0; y <= height; y += 600) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await page.waitForTimeout(100);
      }
      await page.evaluate('window.scrollTo(0, 0)');
      await page.waitForTimeout(300);

      await page.screenshot({
        path: path.join(screenshotsDir, `${bp.name}.png`),
        fullPage: true,
      });

      await context.close();
    }
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Claude comparison
// ---------------------------------------------------------------------------

async function compareScreenshots(
  originalPath: string,
  generatedPath: string,
  breakpointName: string,
  model: string,
): Promise<VisualFix[]> {
  const [originalBuf, generatedBuf] = await Promise.all([
    fs.readFile(originalPath),
    fs.readFile(generatedPath),
  ]);

  const [origPrepared, genPrepared] = await Promise.all([
    prepareImageForApi(originalBuf),
    prepareImageForApi(generatedBuf),
  ]);

  const client = new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: origPrepared.mediaType,
              data: origPrepared.base64,
            },
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: genPrepared.mediaType,
              data: genPrepared.base64,
            },
          },
          {
            type: 'text',
            text: `[Breakpoint: ${breakpointName} (${BREAKPOINTS.find((b) => b.name === breakpointName)?.width}px)]\n\n${COMPARE_PROMPT}`,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  return parseFixesFromResponse(textBlock.text);
}

function parseFixesFromResponse(text: string): VisualFix[] {
  try {
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = fenceMatch ? fenceMatch[1] : text;

    const arrayStart = jsonStr.indexOf('[');
    const arrayEnd = jsonStr.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd === -1) return [];

    const parsed = JSON.parse(jsonStr.slice(arrayStart, arrayEnd + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed.map((item: Record<string, unknown>) => ({
      component: String(item.component ?? ''),
      selector: String(item.selector ?? ''),
      fix: String(item.fix ?? ''),
    })).filter((f) => f.component && f.fix);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fix application via Claude
// ---------------------------------------------------------------------------

async function applyFixes(
  outputDir: string,
  componentFile: string,
  fixes: VisualFix[],
  model: string,
): Promise<boolean> {
  // Resolve the component file path
  const absPath = resolveComponentPath(outputDir, componentFile);

  let source: string;
  try {
    source = await fs.readFile(absPath, 'utf8');
  } catch {
    return false;
  }

  const fixDescriptions = fixes
    .map((f, i) => `${i + 1}. [${f.selector}]: ${f.fix}`)
    .join('\n');

  const prompt = APPLY_FIXES_PROMPT_PREFIX + source + APPLY_FIXES_PROMPT_SUFFIX(fixDescriptions);

  const client = new Anthropic();

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      messages: [
        { role: 'user', content: prompt },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return false;

    const code = extractCode(textBlock.text);
    await fs.writeFile(absPath, code);
    return true;
  } catch {
    return false;
  }
}

function resolveComponentPath(outputDir: string, componentFile: string): string {
  // The model might return various forms:
  //   "Hero.tsx", "src/components/Hero.tsx", "./src/components/Hero.tsx"
  const cleaned = componentFile.replace(/^\.\//, '');

  // If it already includes src/components, use it directly
  if (cleaned.startsWith('src/components/')) {
    return path.join(outputDir, cleaned);
  }

  // If it's just a filename like "Hero.tsx" or "Hero"
  let filename = cleaned;
  if (!filename.endsWith('.tsx') && !filename.endsWith('.ts')) {
    filename += '.tsx';
  }

  return path.join(outputDir, 'src', 'components', filename);
}

function extractCode(text: string): string {
  const fenceMatch = text.match(/```(?:tsx?|jsx?|typescript|javascript)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) return fenceMatch[1].trim() + '\n';

  const trimmed = text.trim();
  if (/^(?:import |export |'use |"use |\/\/ |\/\*|const |function )/.test(trimmed)) {
    return trimmed + '\n';
  }

  return trimmed + '\n';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deduplicateFixes(fixes: VisualFix[]): VisualFix[] {
  const seen = new Set<string>();
  const result: VisualFix[] = [];
  for (const fix of fixes) {
    const key = `${fix.component}::${fix.selector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fix);
  }
  return result;
}

function groupByComponent(fixes: VisualFix[]): Record<string, VisualFix[]> {
  const groups: Record<string, VisualFix[]> = {};
  for (const fix of fixes) {
    const key = fix.component;
    if (!groups[key]) groups[key] = [];
    groups[key].push(fix);
  }
  return groups;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
