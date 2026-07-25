import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NewUserMessageItem } from "@openrouter/agent";
import { buildModelInput } from "../src/agent.js";
import {
  imageAttachmentDataUrl,
  imageAttachmentDataUrls,
  inspectImageAttachment,
  MAX_IMAGE_BYTES,
  refreshImageAttachments,
  validateImageAttachmentSet,
} from "../src/attachments.js";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngOfSize(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  PNG_SIGNATURE.copy(buffer, 0);
  return buffer;
}

test("image attachments are signature-checked and encoded for multimodal input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-image-"));
  try {
    const path = join(directory, "beispiel bild.png");
    await writeFile(
      path,
      Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00,
      ]),
    );
    const attachment = await inspectImageAttachment(
      "beispiel\\ bild.png",
      directory,
    );
    assert.equal(attachment.mimeType, "image/png");
    assert.equal(attachment.name, "beispiel bild.png");
    assert.match(
      await imageAttachmentDataUrl(attachment),
      /^data:image\/png;base64,/,
    );

    const input = await buildModelInput("Beschreibe das Bild.", [attachment], "");
    assert.ok(Array.isArray(input));
    const message = input[0] as NewUserMessageItem | undefined;
    assert.equal(message?.role, "user");
    assert.ok(Array.isArray(message?.content));
    assert.deepEqual(message?.content?.[0], {
      type: "input_text",
      text: "Beschreibe das Bild.",
    });
    const image = Array.isArray(message?.content)
      ? message.content[1]
      : undefined;
    assert.equal(image?.type, "input_image");
    assert.match(
      image?.type === "input_image" ? image.imageUrl ?? "" : "",
      /^data:image\/png;base64,/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-images and too many pending images are rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-not-image-"));
  try {
    await writeFile(join(directory, "not-image.png"), "nur text");
    await assert.rejects(
      inspectImageAttachment("not-image.png", directory),
      /Nicht unterstütztes Bildformat/,
    );
    const fake = {
      path: "/tmp/image.png",
      name: "image.png",
      mimeType: "image/png" as const,
      sizeBytes: 10,
    };
    assert.throws(
      () => validateImageAttachmentSet([fake, fake, fake, fake, fake]),
      /Maximal 4 Bilder/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plain prompts without a developer message become a single user item (K7d)", async () => {
  // buildModelInput always returns an Item[] now (K7d): a trailing developer
  // message with the run's volatile facts is appended after the user turn
  // instead of being baked into `instructions`.
  assert.deepEqual(await buildModelInput("Nur Text", [], ""), [
    { role: "user", content: "Nur Text" },
  ]);
});

test("the total size is checked when sending, not when attaching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-grow-"));
  try {
    const attachments = [];
    for (const name of ["a.png", "b.png", "c.png"]) {
      await writeFile(join(directory, name), pngOfSize(64));
      attachments.push(await inspectImageAttachment(name, directory));
    }
    // Snapshot taken while attaching: everything looks tiny.
    validateImageAttachmentSet(attachments);

    for (const name of ["a.png", "b.png", "c.png"]) {
      await writeFile(join(directory, name), pngOfSize(7 * 1024 * 1024));
    }
    // Stale values still pass the cheap check ...
    validateImageAttachmentSet(attachments);
    // ... but the send-time gate sees the real files.
    await assert.rejects(
      imageAttachmentDataUrls(attachments),
      /Alle Bilder zusammen dürfen höchstens/,
    );
    await assert.rejects(
      refreshImageAttachments(attachments),
      /Alle Bilder zusammen dürfen höchstens/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a single image that grew past the limit is rejected when sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-grow-one-"));
  try {
    const path = join(directory, "gross.png");
    await writeFile(path, pngOfSize(64));
    const attachment = await inspectImageAttachment("gross.png", directory);
    assert.equal(attachment.sizeBytes, 64);

    await writeFile(path, pngOfSize(MAX_IMAGE_BYTES + 1024));
    await assert.rejects(imageAttachmentDataUrl(attachment), /ist größer als/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshImageAttachments reports the current sizes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-refresh-"));
  try {
    const path = join(directory, "bild.png");
    await writeFile(path, pngOfSize(64));
    const attachment = await inspectImageAttachment("bild.png", directory);
    await writeFile(path, pngOfSize(4096));

    const [refreshed] = await refreshImageAttachments([attachment]);
    assert.equal(refreshed?.sizeBytes, 4096);
    assert.equal(refreshed?.mimeType, "image/png");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an image replaced by another format is refused when sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "routercode-swap-"));
  try {
    const path = join(directory, "bild.png");
    await writeFile(path, pngOfSize(64));
    const attachment = await inspectImageAttachment("bild.png", directory);

    await writeFile(path, Buffer.from("GIF89a und mehr text"));
    await assert.rejects(
      imageAttachmentDataUrls([attachment]),
      /wurde seit dem Anhängen verändert/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
