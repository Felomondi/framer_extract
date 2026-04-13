#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { captureForRebuild } from './visual-rebuild/index.js';
import { identifySections } from './visual-rebuild/agents/section-identifier.js';
import { generateComponents } from './visual-rebuild/agents/component-generator.js';
import { assembleProject } from './visual-rebuild/agents/page-assembler.js';
import { runVisualQA } from './visual-rebuild/agents/visual-qa.js';

const program = new Command();

program
  .name('framer-extract')
  .description('Rebuild websites from screenshots using Claude vision')
  .version('0.1.0');

// Rebuild command (default)
program
  .command('rebuild', { isDefault: true })
  .description('Rebuild a website from screenshots using Claude vision')
  .argument('<url>', 'URL to capture and rebuild')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('--debug', 'Keep intermediate files (screenshots, sections.json, qa reports)', false)
  .option('--skip-qa', 'Skip the visual QA refinement loop', false)
  .option('--sections <names>', 'Only regenerate specific sections (comma-separated)', '')
  .option('--model <model>', 'Claude model to use', 'claude-sonnet-4-20250514')
  .action(async (url: string, rawOptions: {
    output: string;
    debug: boolean;
    skipQa: boolean;
    sections: string;
    model: string;
  }) => {
    await runRebuild(url, {
      output: path.resolve(rawOptions.output),
      debug: rawOptions.debug,
      skipQa: rawOptions.skipQa,
      sections: rawOptions.sections
        ? rawOptions.sections.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      model: rawOptions.model,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

interface RebuildOptions {
  output: string;
  debug: boolean;
  skipQa: boolean;
  sections: string[];
  model: string;
}

async function runRebuild(url: string, options: RebuildOptions): Promise<void> {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const { output: outputDir, model } = options;
  const started = Date.now();

  console.log(`→ framer-extract rebuild`);
  console.log(`  url:      ${url}`);
  console.log(`  output:   ${outputDir}`);
  console.log(`  model:    ${model}`);
  console.log(`  skip-qa:  ${options.skipQa}`);
  if (options.sections.length > 0) {
    console.log(`  sections: ${options.sections.join(', ')}`);
  }
  console.log(`  debug:    ${options.debug}`);
  console.log();

  await fs.mkdir(outputDir, { recursive: true });

  // ---- Step 1: Capture ----
  await step('Capturing screenshots, text, and assets', async () => {
    const result = await captureForRebuild(url, outputDir);
    const parts = [
      `${result.screenshots.length} screenshots`,
      `${result.assetCount} assets`,
    ];
    if (result.errors.length > 0) {
      parts.push(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}`);
    }
    return parts.join(', ');
  });

  // ---- Step 2: Identify sections ----
  const sectionResult = await step2('Identifying page sections', async () => {
    const result = await identifySections(outputDir, model);
    const names = result.sections.map((s) => s.name).join(', ');
    return {
      detail: `${result.sections.length} sections (${names})`,
      value: result,
    };
  });

  // ---- Step 3: Generate components ----
  const genResult = await step2('Generating React components', async () => {
    const sectionsToGen = options.sections.length > 0 ? options.sections : undefined;
    const result = await generateComponents(outputDir, {
      model,
      filterSections: sectionsToGen,
    });
    const parts = [`${result.components.length} components`];
    if (result.errors.length > 0) {
      parts.push(`${result.errors.length} failed`);
    }
    return {
      detail: parts.join(', '),
      value: result,
    };
  });

  // ---- Step 4: Assemble project ----
  await step('Assembling Vite + React + Tailwind project', async () => {
    const result = await assembleProject(outputDir, genResult.components, model);
    const parts = [
      `${result.files.length} files`,
      `${Object.keys(result.brandColors).length} brand colors`,
    ];
    if (result.fontFamilies.length > 0) {
      parts.push(`${result.fontFamilies.length} font families`);
    }
    return parts.join(', ');
  });

  // ---- Step 5: Visual QA ----
  if (!options.skipQa) {
    await step('Running visual QA loop', async () => {
      const result = await runVisualQA(outputDir, model);
      const status = result.converged ? 'converged' : `stopped after ${result.iterations.length} iterations`;
      return `${result.totalFixesApplied} fixes applied, ${status}`;
    });
  }

  // ---- Step 6: Clean up intermediates ----
  if (!options.debug) {
    await step('Cleaning intermediate files', async () => {
      const targets = [
        'sections.json',
        'content.txt',
        'qa-report.json',
      ];
      let removed = 0;
      for (const rel of targets) {
        try {
          await fs.unlink(path.join(outputDir, rel));
          removed++;
        } catch {
          // missing — ignore
        }
      }
      // Remove QA iteration screenshots
      const screenshotsDir = path.join(outputDir, 'screenshots');
      try {
        const entries = await fs.readdir(screenshotsDir);
        for (const entry of entries) {
          if (entry.startsWith('qa-iteration-')) {
            await fs.rm(path.join(screenshotsDir, entry), { recursive: true });
            removed++;
          }
        }
      } catch {
        // missing — ignore
      }
      return `removed ${removed} intermediate${removed === 1 ? '' : 's'}`;
    });
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log();
  console.log(`✓ Rebuild complete in ${seconds}s`);
  console.log(`  Project: ${outputDir}/`);
  console.log(`  Next:    cd ${outputDir} && npm install && npm run dev`);

  if (genResult.errors.length > 0) {
    console.log();
    console.log(`  Warnings:`);
    for (const err of genResult.errors) {
      console.log(`    - ${err.section}: ${err.error}`);
    }
  }
  if (sectionResult.sections.length > 0 && options.sections.length > 0) {
    const skipped = sectionResult.sections.length - genResult.components.length;
    if (skipped > 0) {
      console.log(`  (${skipped} section${skipped === 1 ? '' : 's'} skipped due to --sections filter)`);
    }
  }
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

async function step2<T>(
  label: string,
  fn: () => Promise<{ detail: string; value: T }>,
): Promise<T> {
  const start = Date.now();
  process.stdout.write(`• ${label}… `);
  try {
    const { detail, value } = await fn();
    const ms = Date.now() - start;
    process.stdout.write(`done (${detail}, ${ms}ms)\n`);
    return value;
  } catch (err) {
    process.stdout.write(`failed\n`);
    throw err;
  }
}
