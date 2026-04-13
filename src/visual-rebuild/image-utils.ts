import sharp from 'sharp';

/**
 * Claude API rejects base64 images whose decoded size exceeds 5 MB.
 * We target 3.8 MB to leave comfortable headroom.
 */

const MAX_BYTES = 3.8 * 1024 * 1024;
const MAX_DIMENSION = 7999; // Claude API rejects images with any dimension > 8000px

export interface PreparedImage {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  metadata: sharp.Metadata;
}

export async function prepareImageForApi(imageBuffer: Buffer): Promise<PreparedImage> {
  const metadata = await sharp(imageBuffer).metadata();
  const origWidth = metadata.width ?? 2880;
  const origHeight = metadata.height ?? 2880;

  // Downscale if either dimension exceeds Claude's 8000px limit
  if (origWidth > MAX_DIMENSION || origHeight > MAX_DIMENSION) {
    const scale = Math.min(MAX_DIMENSION / origWidth, MAX_DIMENSION / origHeight);
    imageBuffer = await sharp(imageBuffer)
      .resize({ width: Math.round(origWidth * scale) })
      .png()
      .toBuffer();
  }

  // If the raw PNG already fits, send it as-is
  if (imageBuffer.length <= MAX_BYTES) {
    return {
      base64: imageBuffer.toString('base64'),
      mediaType: 'image/png',
      metadata,
    };
  }

  // Progressively shrink as JPEG until it fits
  const currentMeta = await sharp(imageBuffer).metadata();
  const width = currentMeta.width ?? 2880;
  const attempts: Array<{ scale: number; quality: number }> = [
    { scale: 0.5, quality: 80 },
    { scale: 0.4, quality: 75 },
    { scale: 0.33, quality: 70 },
    { scale: 0.25, quality: 70 },
    { scale: 0.2, quality: 60 },
  ];

  for (const { scale, quality } of attempts) {
    const resized = await sharp(imageBuffer)
      .resize({ width: Math.round(width * scale) })
      .jpeg({ quality })
      .toBuffer();

    if (resized.length <= MAX_BYTES) {
      return {
        base64: resized.toString('base64'),
        mediaType: 'image/jpeg',
        metadata,
      };
    }
  }

  // Last resort
  const tiny = await sharp(imageBuffer)
    .resize({ width: Math.round(width * 0.15) })
    .jpeg({ quality: 50 })
    .toBuffer();

  return {
    base64: tiny.toString('base64'),
    mediaType: 'image/jpeg',
    metadata,
  };
}
