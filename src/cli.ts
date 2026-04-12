#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { interceptAssets } from './extractor/asset-interceptor.js';
import { extractDom } from './extractor/dom-extractor.js';
import { recordAnimations } from './extractor/animation-recorder.js';
import { extractFonts } from './extractor/font-extractor.js';
import { generateReactApp, type GeneratorFormat } from './generator/react-generator.js';

interface CliOptions {
  output: string;
  debug: boolean;
  format: GeneratorFormat;
}

const program = new Command();

program
  .name('framer-extract')
  .description('Extract and regenerate code from a Framer site')
  .version('0.1.0')
  .argument('<url>', 'Framer site URL to extract')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('--debug', 'Keep intermediate JSON files in the output directory', false)
  .option('--format <format>', 'Project scaffold format: "vite" or "nextjs"', 'vite')
  .action(async (url: string, rawOptions: { output: string; debug: boolean; format: string }) => {
    const options: CliOptions = {
      output: path.resolve(rawOptions.output),
      debug: rawOptions.debug,
      format: validateFormat(rawOptions.format),
    };

    await run(url, options);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

function validateFormat(value: string): GeneratorFormat {
  if (value === 'vite' || value === 'nextjs') return value;
  throw new Error(`Invalid --format "${value}" — expected "vite" or "nextjs"`);
}

async function run(url: string, options: CliOptions): Promise<void> {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const started = Date.now();
  console.log(`→ framer-extract`);
  console.log(`  url:    ${url}`);
  console.log(`  output: ${options.output}`);
  console.log(`  format: ${options.format}`);
  console.log(`  debug:  ${options.debug}`);
  console.log();

  await fs.mkdir(options.output, { recursive: true });

  await step('Intercepting network assets', async () => {
    const result = await interceptAssets(url, options.output);
    const count = Object.keys(result.manifest).length;
    return `${count} asset${count === 1 ? '' : 's'} saved`;
  });

  await step('Extracting DOM tree and computed styles', async () => {
    const result = await extractDom(url, options.output);
    return `tree rooted at <${result.tree.tag}> across ${Object.keys(result.viewports).length} viewports`;
  });

  await step('Recording animations', async () => {
    const result = await recordAnimations(url, options.output);
    const parts = [
      `${Object.keys(result.keyframes).length} @keyframes`,
      `${result.webAnimations.length} WAAPI calls`,
      `${result.hoverStates.length} hover states`,
    ];
    return parts.join(', ');
  });

  await step('Extracting fonts and typography tokens', async () => {
    const result = await extractFonts(options.output);
    return `${result.faces.length} @font-face, ${result.tokens.length} typography tokens`;
  });

  await step(`Generating React app (${options.format})`, async () => {
    await generateReactApp(options.output, { format: options.format });
    return 'src/, public/, package.json written';
  });

  if (!options.debug) {
    await step('Cleaning intermediate files', async () => {
      const removed = await cleanIntermediates(options.output);
      return `removed ${removed.length} file${removed.length === 1 ? '' : 's'}`;
    });
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log();
  console.log(`✓ Done in ${seconds}s`);
  console.log(`  Next: cd ${options.output} && npm install && npm run dev`);
}

async function step(label: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  process.stdout.write(`• ${label}… `);
  try {
    const detail = await fn();
    const ms = Date.now() - start;
    process.stdout.write(`done (${detail}, ${ms}ms)\n`);
  } catch (err) {
    process.stdout.write(`failed\n`);
    throw err;
  }
}

async function cleanIntermediates(outputDir: string): Promise<string[]> {
  const targets = ['dom-tree.json', 'animations.json', 'assets/manifest.json'];
  const removed: string[] = [];
  for (const rel of targets) {
    const abs = path.join(outputDir, rel);
    try {
      await fs.unlink(abs);
      removed.push(rel);
    } catch {
      // missing — ignore
    }
  }
  return removed;
}
