export type AvatarCropRect = {
  sourceX: number;
  sourceY: number;
  size: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function avatarCropRect(
  imageWidth: number,
  imageHeight: number,
  zoom: number,
  horizontal: number,
  vertical: number,
): AvatarCropRect {
  const safeZoom = clamp(Number.isFinite(zoom) ? zoom : 1, 1, 3);
  const size = Math.min(imageWidth, imageHeight) / safeZoom;
  const horizontalRatio = (clamp(horizontal, -100, 100) + 100) / 200;
  const verticalRatio = (clamp(vertical, -100, 100) + 100) / 200;
  return {
    sourceX: (imageWidth - size) * horizontalRatio,
    sourceY: (imageHeight - size) * verticalRatio,
    size,
  };
}

export function drawAvatarCrop(
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  zoom: number,
  horizontal: number,
  vertical: number,
) {
  const context = canvas.getContext('2d');
  if (!context || !image.naturalWidth || !image.naturalHeight) return false;
  const crop = avatarCropRect(image.naturalWidth, image.naturalHeight, zoom, horizontal, vertical);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, crop.sourceX, crop.sourceY, crop.size, crop.size, 0, 0, canvas.width, canvas.height);
  return true;
}
