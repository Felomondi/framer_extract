import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Section } from './section-identifier.js';
import type { AssetManifest } from '../../types/index.js';
import { prepareImageForApi } from '../image-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratedComponent {
  sectionName: string;
  componentName: string;
  filePath: string;
}

export interface ComponentGeneratorResult {
  components: GeneratedComponent[];
  errors: Array<{ section: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildPrompt(
  section: Section,
  sectionIndex: number,
  totalSections: number,
  textContent: string,
  imageList: string[],
): string {
  const imageBlock = imageList.length > 0
    ? imageList.map((f) => `- ${f}`).join('\n')
    : '(none)';

  return `You are looking at a FULL PAGE screenshot of a website. Your job is to implement ONLY section ${sectionIndex + 1} of ${totalSections}: the "${section.name}" section.

Section description: ${section.description}
Section layout: ${section.layout}
Section background: ${section.background}

IMPORTANT RULES:
- Study the full screenshot carefully. Implement ONLY the "${section.name}" section — not the entire page.
- Match the visual design EXACTLY as shown in the screenshot for this section.
- Only use images from the available list below if you can clearly see them in this specific section of the screenshot. If the section uses icons, recreate them with SVG or Tailwind — do NOT substitute stock photos as icons.
- If the section contains UI mockups or app screenshots, recreate them with HTML/CSS — do NOT use image files for these.
- Do NOT invent or add visual elements that are not visible in the screenshot.

Full page text content (use exact strings that belong to this section):
${textContent}

Available images in ../assets/images/:
${imageBlock}

Requirements:
- Use TypeScript + React functional component
- Use Tailwind CSS for all styling
- Match the layout, spacing, colors, and typography as closely as possible
- Use semantic HTML (nav, section, header, footer, etc.)
- Make it responsive (it should work at all breakpoints)
- Reference images as "../assets/images/filename" if needed
- Export as default

Output only the code, no explanation.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface GenerateOptions {
  model?: string;
  filterSections?: string[];
}

export async function generateComponents(
  outputDir: string,
  options: GenerateOptions = {},
): Promise<ComponentGeneratorResult> {
  const model = options.model ?? 'claude-sonnet-4-20250514';

  // Load sections
  const sectionsPath = path.join(outputDir, 'sections.json');
  let sections: Section[] = JSON.parse(await fs.readFile(sectionsPath, 'utf8'));

  if (options.filterSections && options.filterSections.length > 0) {
    const allowed = new Set(options.filterSections.map((s) => s.toLowerCase()));
    sections = sections.filter((s) => allowed.has(s.name.toLowerCase()));
  }

  // Load full text content
  const fullText = await fs.readFile(path.join(outputDir, 'content.txt'), 'utf8');

  // Load the full desktop screenshot once
  const desktopPath = path.join(outputDir, 'screenshots', 'desktop.png');
  const desktopBuffer = await fs.readFile(desktopPath);
  const prepared = await prepareImageForApi(desktopBuffer);

  // Build image list from the asset manifest
  const imageList = await loadImageList(outputDir);

  // Prepare output directory
  const componentsDir = path.join(outputDir, 'src', 'components');
  await fs.mkdir(componentsDir, { recursive: true });

  const client = new Anthropic();
  const components: GeneratedComponent[] = [];
  const errors: ComponentGeneratorResult['errors'] = [];

  // Load all sections (unfiltered) to give accurate total count
  const allSections: Section[] = JSON.parse(await fs.readFile(sectionsPath, 'utf8'));

  for (const section of sections) {
    const componentName = toComponentName(section.name);
    const sectionIndex = allSections.findIndex(
      (s) => s.name.toLowerCase() === section.name.toLowerCase(),
    );

    try {
      const prompt = buildPrompt(
        section,
        sectionIndex >= 0 ? sectionIndex : 0,
        allSections.length,
        fullText,
        imageList,
      );

      const response = await client.messages.create({
        model,
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: prepared.mediaType,
                  data: prepared.base64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      });

      const textBlock = response.content.find((b) => b.type === 'text');
      if (!textBlock || textBlock.type !== 'text') {
        errors.push({ section: section.name, error: 'No text in Claude response' });
        continue;
      }

      const code = extractCode(textBlock.text);
      const filename = `${componentName}.tsx`;
      const filePath = path.join(componentsDir, filename);
      await fs.writeFile(filePath, code);

      components.push({
        sectionName: section.name,
        componentName,
        filePath: path.posix.join('src', 'components', filename),
      });
    } catch (err) {
      errors.push({ section: section.name, error: (err as Error).message });
    }
  }

  return { components, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadImageList(outputDir: string): Promise<string[]> {
  const manifestPath = path.join(outputDir, 'assets', 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest: AssetManifest = JSON.parse(raw);
    return Object.values(manifest)
      .filter((r) => r.type === 'image')
      .map((r) => path.basename(r.localPath));
  } catch {
    // Manifest missing — fall back to reading the directory
  }

  const imagesDir = path.join(outputDir, 'assets', 'images');
  try {
    const files = await fs.readdir(imagesDir);
    return files.filter((f) => /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(f));
  } catch {
    return [];
  }
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

function toComponentName(sectionName: string): string {
  return sectionName
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('') || 'Section';
}
