import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { prepareImageForApi } from '../image-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Section {
  name: string;
  description: string;
  background: 'light' | 'dark';
  layout: string;
}

export interface SectionIdentifyResult {
  sections: Section[];
  sectionsJsonPath: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const IDENTIFICATION_PROMPT = `Analyze this full-page website screenshot. Identify each distinct visual section from top to bottom.

For each section, provide:
- name: semantic name (e.g., 'navbar', 'hero', 'features', 'pricing', 'footer')
- description: detailed description of what's visually in the section — mention specific UI elements, images, icons, colors, text content, and layout details you can see
- background: 'light' or 'dark'
- layout: describe the layout (e.g., 'centered content with two CTA buttons', 'three-column feature grid with icons above each heading')

Be thorough in descriptions — mention whether sections contain screenshots/mockups, icons, logos, photos, or illustrations so downstream code generation is accurate.

Output as JSON array.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function identifySections(
  outputDir: string,
  model = 'claude-sonnet-4-20250514',
): Promise<SectionIdentifyResult> {
  const desktopPath = path.join(outputDir, 'screenshots', 'desktop.png');

  const imageBuffer = await fs.readFile(desktopPath);
  const prepared = await prepareImageForApi(imageBuffer);

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
              media_type: prepared.mediaType,
              data: prepared.base64,
            },
          },
          {
            type: 'text',
            text: IDENTIFICATION_PROMPT,
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('No text response from Claude');
  }

  const sections = parseJsonFromResponse(textBlock.text);

  const sectionsJsonPath = path.join(outputDir, 'sections.json');
  await fs.writeFile(sectionsJsonPath, JSON.stringify(sections, null, 2));

  return {
    sections,
    sectionsJsonPath: 'sections.json',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonFromResponse(text: string): Section[] {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : text;

  const arrayStart = jsonStr.indexOf('[');
  const arrayEnd = jsonStr.lastIndexOf(']');
  if (arrayStart === -1 || arrayEnd === -1) {
    throw new Error(`Could not find JSON array in response:\n${text.slice(0, 500)}`);
  }

  const parsed = JSON.parse(jsonStr.slice(arrayStart, arrayEnd + 1));
  if (!Array.isArray(parsed)) {
    throw new Error('Parsed response is not an array');
  }

  return parsed.map((item: Record<string, unknown>) => ({
    name: String(item.name ?? 'unknown'),
    description: String(item.description ?? ''),
    background: item.background === 'dark' ? 'dark' as const : 'light' as const,
    layout: String(item.layout ?? ''),
  }));
}
