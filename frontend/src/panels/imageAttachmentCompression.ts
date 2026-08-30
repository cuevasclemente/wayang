export interface ImageAttachmentCompressionDecision {
  size: number;
  width: number;
  height: number;
  maxBytes: number;
  maxDimension: number;
}

/** Return whether a raster image must be recompressed before attachment. */
export function shouldCompressImageForAttachment({
  size,
  width,
  height,
  maxBytes,
  maxDimension,
}: ImageAttachmentCompressionDecision): boolean {
  return size > maxBytes || Math.max(width, height) > maxDimension;
}
