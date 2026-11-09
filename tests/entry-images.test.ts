import test from "node:test";
import assert from "node:assert/strict";
import { checkEntryImage, entryIdParts, entryImageLimits, entryImageRequest, withoutImageLines } from "../packages/shared/src/entry-images.js";
import { createEntryImageCache, entryImageHref, seesEntryImages, shownImages, textBesideImages } from "../packages/client/src/entry-images.js";
import type { EntryView } from "../packages/shared/src/types.js";

const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

test("a request for a transcript image names a kept entry, one of its images and a size", () => {
  assert.deepEqual(entryImageRequest({ entryId: "3:12", index: 1, size: "full" }), { entryId: "3:12", index: 1, size: "full" });
  assert.deepEqual(entryIdParts("3:12"), { conversationId: 3, entryId: 12 });
  for (const value of [null, [], "3:12", { entryId: "3:12", index: 0 }, { entryId: "3:12", index: 0, size: "huge" }, { entryId: "stopped:3", index: 0, size: "full" },
    { entryId: "3:12", index: -1, size: "full" }, { entryId: "3:12", index: 1.5, size: "full" }, { entryId: "3:12", index: entryImageLimits.images, size: "full" },
    { entryId: "3:12", index: 0, size: "full", path: "../x" }]) {
    assert.equal(entryImageRequest(value), undefined, JSON.stringify(value));
  }
});

test("a host's image is held to its size's limit and to the types every provider takes", () => {
  assert.deepEqual(checkEntryImage({ mimeType: "image/png", data: png, extra: 1 }, "thumbnail"), { mimeType: "image/png", data: png });
  const big = "A".repeat(entryImageLimits.thumbnailBytes + 4);
  assert.equal(checkEntryImage({ mimeType: "image/png", data: big }, "thumbnail"), undefined);
  assert.deepEqual(checkEntryImage({ mimeType: "image/png", data: big }, "full"), { mimeType: "image/png", data: big });
  for (const value of [{ mimeType: "image/svg+xml", data: png }, { mimeType: "image/png", data: "" }, { mimeType: "image/png", data: "not base64" },
    { mimeType: "image/png", data: "abc" }, { mimeType: "image/png" }, null]) {
    assert.equal(checkEntryImage(value, "full"), undefined, JSON.stringify(value));
  }
});

test("collaborators see a transcript's images in place of the lines that stand for them", () => {
  const entry: EntryView = { id: "0:4", kind: "message", role: "user", text: "Look\n[image image/png]\n[image image/jpeg]", images: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }] };
  assert.equal(seesEntryImages({ permissions: ["read", "ask", "write"], status: "ready" }), true);
  assert.equal(seesEntryImages({ permissions: ["read", "ask"], status: "ready" }), false);
  assert.equal(seesEntryImages({ permissions: ["read", "ask", "write"], status: "archived" }), false);
  assert.deepEqual(shownImages(entry, true), entry.images);
  assert.deepEqual(shownImages(entry, false), []);
  assert.deepEqual(shownImages({ ...entry, images: undefined }, true), [], "an older host lists none: its lines stay");
  assert.equal(textBesideImages(entry.text), "Look");
  assert.equal(textBesideImages("[image image/png]"), "");
  assert.equal(withoutImageLines("[image] is text\n[image image/png]"), "[image] is text");
  assert.equal(entryImageHref("s 1", "0:4", 1, "thumbnail"), "/api/sessions/s%201/images?entry=0%3A4&index=1&size=thumbnail");
});

test("a client reads each image once, keeps the latest, and asks again for one that failed", async () => {
  const asked: string[] = [];
  let fail = true;
  const cache = createEntryImageCache(async href => {
    asked.push(href);
    if (href === "b" && fail) throw new Error("offline");
    return { image: { mimeType: "image/png", data: png } };
  }, 2);
  const source = `data:image/png;base64,${png}`;
  assert.equal(cache.loaded("a"), undefined);
  assert.deepEqual(await Promise.all([cache.get("a"), cache.get("a")]), [source, source]);
  assert.equal(cache.loaded("a"), source);
  await assert.rejects(cache.get("b"), /offline/);
  fail = false;
  assert.equal(await cache.get("b"), source);
  await cache.get("c");
  // Two are kept: "a" was the least recently asked for.
  assert.equal(cache.loaded("a"), undefined);
  assert.deepEqual(asked, ["a", "b", "b", "c"]);
});
