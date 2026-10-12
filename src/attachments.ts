import { open, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_IMAGE_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ImageAttachment {
  path: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sizeBytes: number;
}

export async function inspectImageAttachment(
  rawPath: string,
  workspace: string,
): Promise<ImageAttachment> {
  const path = resolveAttachmentPath(rawPath, workspace);
  const info = await stat(path);
  if (!info.isFile()) {
    throw new Error(`Image path is not a regular file: ${path}`);
  }
  if (info.size <= 0) {
    throw new Error(`Image file is empty: ${path}`);
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is larger than ${formatBytes(MAX_IMAGE_BYTES)}: ${formatBytes(info.size)}`,
    );
  }
  const mimeType = await detectImageMimeType(path);
  if (!mimeType) {
    throw new Error(
      "Unsupported image format. Allowed: PNG, JPEG, GIF, and WebP.",
    );
  }
  return {
    path,
    name: basename(path),
    mimeType,
    sizeBytes: info.size,
  };
}

/**
 * Send-time gate for a whole attachment set (B18). Count, single size, format
 * and the combined size are all checked against the files as they are *now*,
 * not against the values captured when the user attached them. Stat, magic
 * bytes and read all use the same file handle, so the file cannot be swapped in
 * between.
 */
export async function imageAttachmentDataUrls(
  attachments: readonly ImageAttachment[],
): Promise<string[]> {
  assertAttachmentCount(attachments);
  if (!attachments.length) {
    return [];
  }
  const opened: { attachment: ImageAttachment; handle: FileHandle; size: number }[] =
    [];
  try {
    let total = 0;
    for (const attachment of attachments) {
      const handle = await open(attachment.path, "r");
      const entry = { attachment, handle, size: 0 };
      opened.push(entry);
      entry.size = await verifyOpenAttachment(attachment, handle);
      total += entry.size;
      if (total > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error(
          `All images together may be at most ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} (currently ${formatBytes(total)}).`,
        );
      }
    }
    const urls: string[] = [];
    for (const entry of opened) {
      const data = await entry.handle.readFile();
      if (data.length !== entry.size) {
        throw new Error(
          `Image file was changed while sending: ${entry.attachment.path}`,
        );
      }
      urls.push(
        `data:${entry.attachment.mimeType};base64,${data.toString("base64")}`,
      );
    }
    return urls;
  } finally {
    for (const entry of opened) {
      await entry.handle.close().catch(() => {});
    }
  }
}

export async function imageAttachmentDataUrl(
  attachment: ImageAttachment,
): Promise<string> {
  const [url] = await imageAttachmentDataUrls([attachment]);
  return url;
}

/**
 * Re-reads the current file sizes so a stale set can be reported before a run
 * starts. Returns the refreshed attachments.
 */
export async function refreshImageAttachments(
  attachments: readonly ImageAttachment[],
): Promise<ImageAttachment[]> {
  assertAttachmentCount(attachments);
  const refreshed: ImageAttachment[] = [];
  let total = 0;
  for (const attachment of attachments) {
    const handle = await open(attachment.path, "r");
    try {
      const size = await verifyOpenAttachment(attachment, handle);
      total += size;
      refreshed.push({ ...attachment, sizeBytes: size });
    } finally {
      await handle.close().catch(() => {});
    }
  }
  assertTotalSize(total);
  return refreshed;
}

/**
 * Cheap synchronous pre-check for the UI. It can only see the sizes captured
 * when the images were attached; the binding check happens in
 * `imageAttachmentDataUrls`.
 */
export function validateImageAttachmentSet(
  attachments: readonly ImageAttachment[],
): void {
  assertAttachmentCount(attachments);
  assertTotalSize(
    attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0),
  );
}

export function attachmentPromptSummary(
  attachments: readonly ImageAttachment[],
): string {
  if (!attachments.length) {
    return "";
  }
  return `Attached images: ${attachments
    .map((attachment) => `${attachment.name} (${attachment.mimeType})`)
    .join(", ")}`;
}

export function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${Number((value / (1024 * 1024)).toFixed(1))} MB`;
  }
  if (value >= 1024) {
    return `${Number((value / 1024).toFixed(1))} KB`;
  }
  return `${value} B`;
}

function assertAttachmentCount(attachments: readonly ImageAttachment[]): void {
  if (attachments.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error(
      `At most ${MAX_IMAGE_ATTACHMENTS} images can be attached at the same time.`,
    );
  }
}

function assertTotalSize(total: number): void {
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(
      `All images together may be at most ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} (currently ${formatBytes(total)}).`,
    );
  }
}

/** Validates an already opened handle and returns its current size. */
async function verifyOpenAttachment(
  attachment: ImageAttachment,
  handle: FileHandle,
): Promise<number> {
  const info = await handle.stat();
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`Image file is no longer usable: ${attachment.path}`);
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image is larger than ${formatBytes(MAX_IMAGE_BYTES)}: ${formatBytes(info.size)} (${attachment.path})`,
    );
  }
  const mimeType = await readImageMimeType(handle);
  if (mimeType !== attachment.mimeType) {
    throw new Error(
      `Image file was changed since it was attached: ${attachment.path}`,
    );
  }
  return info.size;
}

function resolveAttachmentPath(rawPath: string, workspace: string): string {
  let value = rawPath.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  value = value.replace(/\\([\\ "'()&;[\]{}!#$`])/g, "$1");
  if (value.startsWith("file://")) {
    return fileURLToPath(value);
  }
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    value = join(homedir(), value.slice(2));
  }
  if (!value) {
    throw new Error("No image path given.");
  }
  return isAbsolute(value) ? resolve(value) : resolve(workspace, value);
}

async function detectImageMimeType(
  path: string,
): Promise<ImageAttachment["mimeType"] | null> {
  const handle = await open(path, "r");
  try {
    return await readImageMimeType(handle);
  } finally {
    await handle.close();
  }
}

async function readImageMimeType(
  handle: FileHandle,
): Promise<ImageAttachment["mimeType"] | null> {
  const bytes = Buffer.alloc(16);
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  const signature = bytes.subarray(0, bytesRead);
  if (
    signature.length >= 8 &&
    signature.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    signature.length >= 3 &&
    signature[0] === 0xff &&
    signature[1] === 0xd8 &&
    signature[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    signature.length >= 6 &&
    (signature.subarray(0, 6).toString("ascii") === "GIF87a" ||
      signature.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    signature.length >= 12 &&
    signature.subarray(0, 4).toString("ascii") === "RIFF" &&
    signature.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}
