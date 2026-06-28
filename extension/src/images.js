// Shared image helper: downscale a source blob to a JPEG no larger than
// `longEdge`. Used by the Cloudflare uploader (cloud.js) to size gallery images
// before upload.

export async function encodeJpeg(srcBlob, longEdge, quality) {
  const bmp = await createImageBitmap(srcBlob);
  const scale = Math.min(1, longEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  return { blob, w, h };
}
