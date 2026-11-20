import sharp from "sharp";

const INPUT_PIXEL_LIMIT = 64_000_000;
const INPUT_SIZE = 224;

export async function readModerationRgb(data) {
  const source = sharp(data, { limitInputPixels: INPUT_PIXEL_LIMIT });
  const { hasAlpha } = await source.metadata();
  let image = source.rotate();

  if (hasAlpha) {
    // Sharp resizes before removeAlpha, premultiplying hidden RGB to black.
    // Finish this bounded RGB decode before starting the resize pipeline.
    const { data: rgb, info } = await image
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    image = sharp(rgb, {
      raw: { width: info.width, height: info.height, channels: 3 },
    });
  }

  return image
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer();
}
