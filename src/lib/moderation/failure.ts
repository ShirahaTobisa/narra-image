/** Only fixed, application-owned codes belong here; never pass an upstream message. */
export class ModerationFailure extends Error {
  readonly imageIndex?: number;
  readonly httpStatus?: number;
  readonly actualFormat?: string;

  constructor(readonly code: string, details: { message?: string; imageIndex?: number; httpStatus?: number; actualFormat?: string } = {}) {
    super(details.message ?? "内容审核暂时无法完成");
    this.imageIndex = details.imageIndex;
    this.httpStatus = details.httpStatus;
    this.actualFormat = details.actualFormat === undefined ? undefined
      : ["png", "jpeg", "webp", "gif", "avif", "heif", "svg", "bmp", "tiff", "jp2", "jxl"].includes(details.actualFormat)
        ? details.actualFormat : "other";
  }
}
