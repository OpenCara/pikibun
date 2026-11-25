import assert from "node:assert/strict";
import test from "node:test";
import { checkMediaRange, mediaLimits, mediaRangeRequest, mediaType, parseByteRange, worktreeMediaPath } from "../packages/shared/src/media.js";
import { attachedFilePaths, attachedFilesNote } from "../packages/shared/src/file-uploads.js";

test("media types come from the file's extension, in any case", () => {
  assert.deepEqual(mediaType("out/demo.MP4"), { kind: "video", mimeType: "video/mp4" });
  assert.deepEqual(mediaType("a/b/song.mp3"), { kind: "audio", mimeType: "audio/mpeg" });
  assert.deepEqual(mediaType("chart.jpeg"), { kind: "image", mimeType: "image/jpeg" });
  assert.deepEqual(mediaType("clip.mov"), { kind: "video", mimeType: "video/quicktime" });
  for (const path of ["notes.txt", "Makefile", ".mp4", "dir.mp4/readme", "drawing.svg", "page.html"]) assert.equal(mediaType(path), undefined, path);
});

test("a Markdown image's source names a worktree file only as a plain relative path to a media file", () => {
  assert.equal(worktreeMediaPath("out/demo.mp4"), "out/demo.mp4");
  assert.equal(worktreeMediaPath("./out/demo.mp4"), "out/demo.mp4");
  assert.equal(worktreeMediaPath("out/my%20clip.webm"), "out/my clip.webm");
  for (const source of ["https://example.com/a.png", "data:image/png;base64,AAAA", "file:///etc/a.png", "//host/a.png", "/etc/a.png", "../a.png",
    "a/../b.png", "a//b.png", "a\\b.png", "notes.txt", "a.png?x=1", "#a.png", "%zz.png", "", "a%2F..%2F..%2Fb.png"]) {
    assert.equal(worktreeMediaPath(source), undefined, source);
  }
});

test("a Range header reads one part, at most a chunk, of the file", () => {
  const size = 5 * mediaLimits.chunkBytes;
  assert.equal(parseByteRange(undefined, size), undefined);
  assert.deepEqual(parseByteRange("bytes=0-99", size), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange("bytes=10-", size), { start: 10, end: 10 + mediaLimits.chunkBytes - 1 });
  assert.deepEqual(parseByteRange("bytes=-100", size), { start: size - 100, end: size - 1 });
  assert.deepEqual(parseByteRange("bytes=-100", 40), { start: 0, end: 39 });
  assert.deepEqual(parseByteRange("bytes=30-1000", 40), { start: 30, end: 39 });
  assert.equal(parseByteRange("bytes=40-", 40), "unsatisfiable");
  assert.equal(parseByteRange("bytes=50-60", 40), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-0", 40), "unsatisfiable");
  assert.equal(parseByteRange("bytes=0-0", 0), "unsatisfiable");
  for (const header of ["bytes=5-1", "bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=a-b"]) assert.equal(parseByteRange(header, 40), undefined, header);
});

test("a host's range request and answer are checked exactly", () => {
  assert.deepEqual(mediaRangeRequest({ path: "a.mp4", offset: 0, length: 10 }), { path: "a.mp4", offset: 0, length: 10 });
  for (const input of [null, [], { path: "a.mp4", offset: 0 }, { path: "a.mp4", offset: -1, length: 1 }, { path: "a.mp4", offset: 0, length: 0 },
    { path: "a.mp4", offset: 0, length: mediaLimits.chunkBytes + 1 }, { path: "", offset: 0, length: 1 }, { path: "a.mp4", offset: 0, length: 1, extra: 1 }]) {
    assert.equal(mediaRangeRequest(input), undefined, JSON.stringify(input));
  }
  const data = Buffer.from("abcd").toString("base64");
  assert.deepEqual(checkMediaRange({ size: 10, data }, { offset: 2, length: 4 }), { size: 10, data });
  assert.deepEqual(checkMediaRange({ size: 6, data }, { offset: 2, length: 100 }), { size: 6, data });
  assert.deepEqual(checkMediaRange({ size: 6, data: "" }, { offset: 8, length: 4 }), { size: 6, data: "" });
  assert.equal(checkMediaRange({ size: 10, data }, { offset: 2, length: 3 }), undefined, "more bytes than asked");
  assert.equal(checkMediaRange({ size: 100, data }, { offset: 0, length: 10 }), undefined, "fewer bytes than the file holds there");
  assert.equal(checkMediaRange({ size: 10, data: "a*cd" }, { offset: 0, length: 3 }), undefined);
  assert.equal(checkMediaRange({ size: 10, data, more: 1 }, { offset: 2, length: 4 }), undefined);
});

test("the files a message attached are read back from its note", () => {
  const note = attachedFilesNote([{ path: "attachments/clip (2).mp4", size: 2 * 1024 * 1024 }, { path: "attachments/notes.txt", size: 12 }]);
  assert.deepEqual(attachedFilePaths(`Please look\n\n${note}`), ["attachments/clip (2).mp4", "attachments/notes.txt"]);
  assert.deepEqual(attachedFilePaths(attachedFilesNote([{ path: "attachments/song.mp3", size: 1536 }])), ["attachments/song.mp3"]);
  assert.deepEqual(attachedFilePaths("- attachments/song.mp3 (2 KB)"), [], "a list without the note's first line");
  assert.deepEqual(attachedFilePaths("Attached file, uploaded into the session worktree:\n- ../etc/passwd.mp3 (2 KB)"), []);
});
