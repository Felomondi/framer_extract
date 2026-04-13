export type AssetType = 'image' | 'svg' | 'font' | 'video' | 'css' | 'js' | 'other';

export interface AssetRecord {
  localPath: string;
  type: AssetType;
  contentType?: string;
  size: number;
  originalUrl?: string;
  srcset?: SrcsetEntry[];
}

export interface SrcsetEntry {
  url: string;
  localPath: string;
  width: number;
}

export type AssetManifest = Record<string, AssetRecord>;

export interface InterceptResult {
  manifest: AssetManifest;
  manifestPath: string;
  assetsDir: string;
  errors: Array<{ url: string; error: string }>;
}
