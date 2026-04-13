import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Section } from './section-identifier.js';
import type { GeneratedComponent } from './component-generator.js';
import type { AssetManifest } from '../../types/index.js';
import { prepareImageForApi } from '../image-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssemblerResult {
  files: string[];
  brandColors: Record<string, string>;
  fontFamilies: string[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function assembleProject(
  outputDir: string,
  components: GeneratedComponent[],
  model = 'claude-sonnet-4-20250514',
): Promise<AssemblerResult> {
  const sections: Section[] = JSON.parse(
    await fs.readFile(path.join(outputDir, 'sections.json'), 'utf8'),
  );

  // Gather font info from downloaded assets
  const fonts = await discoverFonts(outputDir);

  // Ask Claude to identify brand colors from the desktop screenshot
  const brandColors = await extractBrandColors(outputDir, model);

  const files: string[] = [];

  // Order components by section order
  const ordered = orderComponents(components, sections);

  // 1. App.tsx
  await writeFile(outputDir, 'src/App.tsx', buildAppTsx(ordered));
  files.push('src/App.tsx');

  // 2. index.tsx (React root)
  await writeFile(outputDir, 'src/index.tsx', INDEX_TSX);
  files.push('src/index.tsx');

  // 3. tailwind.config.js
  await writeFile(
    outputDir,
    'tailwind.config.js',
    buildTailwindConfig(brandColors, fonts.families),
  );
  files.push('tailwind.config.js');

  // 4. globals.css
  await writeFile(outputDir, 'src/styles/globals.css', buildGlobalsCss(fonts.faces));
  files.push('src/styles/globals.css');

  // 5. package.json
  await writeFile(outputDir, 'package.json', PACKAGE_JSON);
  files.push('package.json');

  // 6. vite.config.ts
  await writeFile(outputDir, 'vite.config.ts', VITE_CONFIG);
  files.push('vite.config.ts');

  // 7. index.html
  await writeFile(outputDir, 'index.html', INDEX_HTML);
  files.push('index.html');

  // 8. tsconfig.json (needed to actually run)
  await writeFile(outputDir, 'tsconfig.json', TSCONFIG);
  files.push('tsconfig.json');

  // 9. postcss.config.js (Tailwind requires it)
  await writeFile(outputDir, 'postcss.config.js', POSTCSS_CONFIG);
  files.push('postcss.config.js');

  return {
    files,
    brandColors,
    fontFamilies: fonts.families,
  };
}

// ---------------------------------------------------------------------------
// Brand color extraction via Claude
// ---------------------------------------------------------------------------

const COLOR_PROMPT = `Analyze this website screenshot. Identify the brand/theme colors used.

Return a JSON object with these keys (use hex values):
- primary: the main brand/accent color
- secondary: secondary accent color (if any, otherwise omit)
- background: the dominant page background color
- foreground: the main text color
- muted: a subtle/muted background color used for cards or alternate sections

Output only the JSON object, no explanation.`;

async function extractBrandColors(
  outputDir: string,
  model: string,
): Promise<Record<string, string>> {
  const desktopPath = path.join(outputDir, 'screenshots', 'desktop.png');
  let imageBuffer: Buffer;
  try {
    imageBuffer = await fs.readFile(desktopPath);
  } catch {
    return { primary: '#3b82f6', background: '#ffffff', foreground: '#111827' };
  }

  const client = new Anthropic();

  try {
    const prepared = await prepareImageForApi(imageBuffer);
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
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
            { type: 'text', text: COLOR_PROMPT },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { primary: '#3b82f6', background: '#ffffff', foreground: '#111827' };
    }

    return parseJsonObject(textBlock.text);
  } catch {
    return { primary: '#3b82f6', background: '#ffffff', foreground: '#111827' };
  }
}

function parseJsonObject(text: string): Record<string, string> {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenceMatch ? fenceMatch[1] : text;

  const objStart = jsonStr.indexOf('{');
  const objEnd = jsonStr.lastIndexOf('}');
  if (objStart === -1 || objEnd === -1) {
    return { primary: '#3b82f6', background: '#ffffff', foreground: '#111827' };
  }

  const parsed = JSON.parse(jsonStr.slice(objStart, objEnd + 1));
  // Validate that values look like hex colors
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0
    ? result
    : { primary: '#3b82f6', background: '#ffffff', foreground: '#111827' };
}

// ---------------------------------------------------------------------------
// Font discovery
// ---------------------------------------------------------------------------

interface FontInfo {
  filename: string;
  family: string;
  weight: string;
  style: string;
  format: string;
}

interface FontDiscoveryResult {
  faces: FontInfo[];
  families: string[];
}

const EXT_TO_FORMAT: Record<string, string> = {
  '.woff2': 'woff2',
  '.woff': 'woff',
  '.ttf': 'truetype',
  '.otf': 'opentype',
  '.eot': 'embedded-opentype',
};

async function discoverFonts(outputDir: string): Promise<FontDiscoveryResult> {
  const faces: FontInfo[] = [];
  const familySet = new Set<string>();

  // Check the asset manifest for font records
  const manifestPath = path.join(outputDir, 'assets', 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest: AssetManifest = JSON.parse(raw);

    for (const record of Object.values(manifest)) {
      if (record.type !== 'font') continue;

      const filename = path.basename(record.localPath);
      const ext = path.extname(filename).toLowerCase();
      const format = EXT_TO_FORMAT[ext] ?? 'woff2';

      // Derive family name from filename (best-effort)
      const family = deriveFontFamily(filename);
      const weight = deriveFontWeight(filename);
      const style = /italic/i.test(filename) ? 'italic' : 'normal';

      faces.push({ filename, family, weight, style, format });
      familySet.add(family);
    }
  } catch {
    // No manifest — try reading the fonts directory directly
    const fontsDir = path.join(outputDir, 'assets', 'fonts');
    try {
      const files = await fs.readdir(fontsDir);
      for (const filename of files) {
        const ext = path.extname(filename).toLowerCase();
        if (!EXT_TO_FORMAT[ext]) continue;

        const family = deriveFontFamily(filename);
        const weight = deriveFontWeight(filename);
        const style = /italic/i.test(filename) ? 'italic' : 'normal';
        const format = EXT_TO_FORMAT[ext];

        faces.push({ filename, family, weight, style, format });
        familySet.add(family);
      }
    } catch {
      // No fonts directory
    }
  }

  return { faces, families: [...familySet] };
}

function deriveFontFamily(filename: string): string {
  // Strip extension, hash suffixes, weight/style keywords
  let stem = filename.replace(/\.[^.]+$/, '');
  // Remove common hash patterns like -a1b2c3d4
  stem = stem.replace(/-[a-f0-9]{6,}$/i, '');
  stem = stem.replace(/-original$/, '');
  // Remove weight/style keywords
  stem = stem.replace(/[-_]?(thin|extralight|light|regular|medium|semibold|bold|extrabold|black|italic|variable|v\d+)/gi, '');
  // Clean up separators
  stem = stem.replace(/[-_]+/g, ' ').trim();
  // Title-case
  return stem
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Custom Font';
}

const WEIGHT_KEYWORDS: Record<string, string> = {
  thin: '100',
  hairline: '100',
  extralight: '200',
  ultralight: '200',
  light: '300',
  regular: '400',
  normal: '400',
  medium: '500',
  semibold: '600',
  demibold: '600',
  bold: '700',
  extrabold: '800',
  ultrabold: '800',
  black: '900',
  heavy: '900',
};

function deriveFontWeight(filename: string): string {
  const lower = filename.toLowerCase();
  for (const [kw, weight] of Object.entries(WEIGHT_KEYWORDS)) {
    if (lower.includes(kw)) return weight;
  }
  return '400';
}

// ---------------------------------------------------------------------------
// Component ordering
// ---------------------------------------------------------------------------

function orderComponents(
  components: GeneratedComponent[],
  sections: Section[],
): GeneratedComponent[] {
  const sectionOrder = new Map(sections.map((s, i) => [s.name, i]));
  return [...components].sort((a, b) => {
    const aIdx = sectionOrder.get(a.sectionName) ?? 999;
    const bIdx = sectionOrder.get(b.sectionName) ?? 999;
    return aIdx - bIdx;
  });
}

// ---------------------------------------------------------------------------
// File generators
// ---------------------------------------------------------------------------

function buildAppTsx(components: GeneratedComponent[]): string {
  const imports = components
    .map((c) => `import ${c.componentName} from './components/${c.componentName}';`)
    .join('\n');

  const jsx = components
    .map((c) => `        <${c.componentName} />`)
    .join('\n');

  return `${imports}
import './styles/globals.css';

export default function App() {
  return (
    <div className="min-h-screen">
${jsx}
    </div>
  );
}
`;
}

const INDEX_TSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;

function buildTailwindConfig(
  brandColors: Record<string, string>,
  fontFamilies: string[],
): string {
  const colorEntries = Object.entries(brandColors)
    .map(([k, v]) => `        ${k}: '${v}',`)
    .join('\n');

  const fontEntries = fontFamilies.length > 0
    ? fontFamilies
        .map((f) => {
          const key = f.toLowerCase().replace(/\s+/g, '-');
          return `        '${key}': ['${f}', 'sans-serif'],`;
        })
        .join('\n')
    : `        sans: ['Inter', 'system-ui', 'sans-serif'],`;

  return `/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
${colorEntries}
        },
      },
      fontFamily: {
${fontEntries}
      },
    },
  },
  plugins: [],
};
`;
}

function buildGlobalsCss(fonts: FontInfo[]): string {
  const fontFaceRules = fonts
    .map(
      (f) => `@font-face {
  font-family: '${f.family}';
  src: url('/assets/fonts/${f.filename}') format('${f.format}');
  font-weight: ${f.weight};
  font-style: ${f.style};
  font-display: swap;
}`,
    )
    .join('\n\n');

  return `@tailwind base;
@tailwind components;
@tailwind utilities;

${fontFaceRules}

body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
`;
}

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'rebuilt-site',
    private: true,
    version: '0.0.1',
    type: 'module',
    scripts: {
      dev: 'vite',
      build: 'tsc && vite build',
      preview: 'vite preview',
    },
    dependencies: {
      react: '^18.3.0',
      'react-dom': '^18.3.0',
    },
    devDependencies: {
      '@types/react': '^18.3.0',
      '@types/react-dom': '^18.3.0',
      '@vitejs/plugin-react': '^4.3.0',
      autoprefixer: '^10.4.20',
      postcss: '^8.4.47',
      tailwindcss: '^3.4.0',
      typescript: '^5.6.0',
      vite: '^5.4.0',
    },
  },
  null,
  2,
) + '\n';

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
`;

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Rebuilt Site</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/index.tsx"></script>
  </body>
</html>
`;

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2020',
      useDefineForClassFields: true,
      lib: ['ES2020', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      skipLibCheck: true,
      moduleResolution: 'Bundler',
      allowImportingTsExtensions: true,
      isolatedModules: true,
      moduleDetection: 'force',
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedSideEffectImports: true,
    },
    include: ['src'],
  },
  null,
  2,
) + '\n';

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeFile(
  outputDir: string,
  relPath: string,
  content: string,
): Promise<void> {
  const absPath = path.join(outputDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content);
}
