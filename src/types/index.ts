export interface ExtractedSite {
  url: string;
  html: string;
  css: string;
}

export type AssetType = 'image' | 'svg' | 'font' | 'video' | 'css' | 'js' | 'other';

export interface AssetRecord {
  localPath: string;
  type: AssetType;
  contentType?: string;
  size: number;
}

export type AssetManifest = Record<string, AssetRecord>;

export interface InterceptResult {
  manifest: AssetManifest;
  manifestPath: string;
  assetsDir: string;
  errors: Array<{ url: string; error: string }>;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FramerMeta {
  attrs: Record<string, string>;
  name?: string;
  componentType?: string;
  componentIdentifier?: string;
  appearId?: string;
  isComponentRoot: boolean;
  isBackgroundImage: boolean;
}

export interface PseudoElementStyles {
  before?: Record<string, string>;
  after?: Record<string, string>;
}

export interface ViewportSnapshot {
  width: number;
  rect: Rect;
  computedStyle: Record<string, string>;
  pseudoElements?: PseudoElementStyles;
}

export type ViewportLabel = 'xl' | 'lg' | 'md' | 'sm';

export interface DOMNode {
  id: string;
  tag: string;
  attributes: Record<string, string>;
  framer?: FramerMeta;
  text?: string;
  rect: Rect;
  computedStyle: Record<string, string>;
  cssVariables?: Record<string, string>;
  pseudoElements?: PseudoElementStyles;
  pseudoClassStyles?: Record<string, Record<string, string>>;
  authoredStyles?: Record<string, string>;
  responsive: Partial<Record<ViewportLabel, ViewportSnapshot>>;
  children: DOMNode[];
}

export interface DomExtractResult {
  url: string;
  viewports: Record<ViewportLabel, number>;
  baseViewport: ViewportLabel;
  tree: DOMNode;
  treePath: string;
  cssCustomProperties: Record<string, string>;
}

export interface CssTransitionRule {
  property: string;
  duration: string;
  timingFunction: string;
  delay: string;
}

export interface CssAnimationRule {
  name: string;
  duration: string;
  timingFunction: string;
  delay: string;
  iterationCount: string;
  fillMode: string;
  direction: string;
}

export interface KeyframesRule {
  name: string;
  frames: Array<{ offset: string; style: Record<string, string> }>;
}

export interface WebAnimationCall {
  selector: string | null;
  keyframes: unknown;
  timing: unknown;
  timestamp: number;
}

export interface StyleMutationRecord {
  selector: string | null;
  timestamp: number;
  style: string;
}

export interface HoverDiff {
  selector: string;
  changes: Record<string, { from: string; to: string }>;
}

export interface FontFaceSource {
  originalUrl?: string;
  localPath?: string;
  format?: string;
}

export interface FontFaceRecord {
  family: string;
  weight?: string;
  style?: string;
  stretch?: string;
  display?: string;
  unicodeRange?: string;
  variable: boolean;
  sources: FontFaceSource[];
}

export interface TypographyToken {
  id: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;
  count: number;
  sampleText?: string;
}

export interface FontExtractResult {
  faces: FontFaceRecord[];
  tokens: TypographyToken[];
  fontsCssPath: string;
  tokensJsonPath: string;
}

export interface AnimationsOutput {
  url: string;
  keyframes: Record<string, KeyframesRule>;
  cssTransitions: Record<string, CssTransitionRule[]>;
  cssAnimations: Record<string, CssAnimationRule[]>;
  webAnimations: WebAnimationCall[];
  styleMutations: StyleMutationRecord[];
  hoverStates: HoverDiff[];
  whileInViewCandidates: string[];
}
