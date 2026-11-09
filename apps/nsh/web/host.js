// The page's host (nsh.json `web.host`), on the web only: the address the client is opened at and where it goes. Links
// into the app keep the routes the web app had, in the fragment (#/s/<id>, #/settings/hosts, #/shared/<token>,
// #/join/<token>), so a share or invite token never reaches the server; sign-in goes to the server's own pages.
// Native Shell copies this module as it is into the site (host.<digest>.js) and runs createHost before the app starts.

const page = typeof location !== "undefined" && typeof history !== "undefined";

/** The fragment, or "" where there is no page (nsh test runs this module headless too). */
const route = () => (page ? location.hash : "");

/** The address the app last showed: where it is now. */
let shown = null;
/** How many of Native Shell's pages were open over the first, as the history entry the page is on says. */
const depthOf = state => (typeof state?.nsh === "number" ? state.nsh : 0);
let depth = 0;
/** When Back or Forward moved between Native Shell's pages, until its hashchange comes (0: none pending). */
let traversedAt = 0;

const functions = new Map([
  ["page.route", () => route()],
  // Shows the app's route in the address bar without a history entry of its own: Native Shell keeps the entries of
  // its pages and dialogs, whose state stays as it is.
  ["page.setRoute", args => {
    const hash = typeof args?.hash === "string" && /^#\/[^\s]*$/.test(args.hash) ? args.hash : "#/";
    shown = hash;
    // Marks the entry as one the app has been on (Native Shell's entries copy the state of the one they're pushed from),
    // so Back to it later isn't mistaken for a link just followed.
    if (page && (location.hash !== hash || !history.state?.pikibun)) history.replaceState({ ...(history.state ?? {}), pikibun: true }, "", hash);
    return null;
  }],
  // Only this server's own pages (/api/auth/github, say), never another site's.
  ["page.open", args => {
    const path = args?.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Only this server's own paths open.");
    if (page) location.assign(path);
    return null;
  }],
  // The query the server's GitHub sign-in comes back with when it refused (`?error=…`).
  ["page.query", () => (page ? location.search : "")],
  // GitHub's authorization page, which a sign-in from an invite link is sent to (the server answers with its address);
  // nowhere else.
  ["page.authorize", args => {
    const url = args?.url;
    if (typeof url !== "string" || !url.startsWith("https://github.com/login/oauth/authorize?")) throw new Error("Only GitHub's authorization page opens.");
    if (page) location.assign(url);
    return null;
  }],
  ["page.pickFiles", args => pickFiles(args)],
  ["page.encodeImage", args => encodeImage(args)],
]);

/** Bytes as base64, a block at a time so no call gets too many arguments. */
function base64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * The browser's own file chooser (NSH's picker takes photos only): the files picked, each with its bytes as base64, or
 * without them when it is larger than `maxBytes`; `[]` when the person cancels. `accept` narrows what it offers.
 */
function pickFiles(args) {
  if (!page || typeof document === "undefined") return [];
  const maxBytes = typeof args?.maxBytes === "number" ? args.maxBytes : Infinity;
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = args?.multiple !== false;
    if (typeof args?.accept === "string") input.accept = args.accept;
    input.style.display = "none";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      input.remove();
      Promise.all(Array.from(input.files ?? []).map(async file => ({
        name: file.name, type: file.type, size: file.size,
        ...(file.size <= maxBytes ? { data: base64(new Uint8Array(await file.arrayBuffer())) } : {}),
      }))).then(resolve, reject);
    };
    input.addEventListener("change", finish);
    input.addEventListener("cancel", finish);
    document.body.append(input);
    input.click();
  });
}

/**
 * An image drawn again, as the web app's chat box does (attachments.tsx): within `maxEdge` pixels and `budget`
 * characters of base64, a PNG (a screenshot, usually) staying lossless if it fits, JPEG otherwise, a little more
 * compressed and smaller each time.
 */
async function encodeImage(args) {
  if (!page || typeof document === "undefined") throw new Error("Images can't be drawn here.");
  const { data, maxEdge, budget } = args ?? {};
  if (typeof data !== "string" || typeof maxEdge !== "number" || typeof budget !== "number") throw new Error("Invalid image.");
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  let bitmap;
  try { bitmap = await createImageBitmap(new Blob([bytes])); }
  catch { throw new Error("An attached image can't be read. Attach a PNG or JPEG."); }
  try {
    let scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const attempts = [...(png ? [{ mimeType: "image/png" }] : []),
        { mimeType: "image/jpeg", quality: 0.85 }, { mimeType: "image/jpeg", quality: 0.7 }, { mimeType: "image/jpeg", quality: 0.55 }];
      for (const { mimeType, quality } of attempts) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) continue;
        // JPEG has no transparency: transparent pixels become white, as on a page, rather than black.
        if (mimeType === "image/jpeg") {
          context.fillStyle = "#fff";
          context.fillRect(0, 0, width, height);
        }
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise(done => canvas.toBlob(done, mimeType, quality));
        if (blob && Math.ceil(blob.size / 3) * 4 <= budget) return { mimeType, data: base64(new Uint8Array(await blob.arrayBuffer())) };
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("An attached image is too large to send, even scaled down.");
}

export async function createHost(player) {
  if (page && typeof addEventListener === "function") {
    // Native Shell pushes and pops its pages' history entries on its own time, after the app has shown the new page's
    // address, so an entry can hold another page's address. Back or Forward to an entry of another of its pages (from
    // the app's Back or the browser's) is Native Shell's to follow: the entry gets the app's address back rather than
    // being taken as a link, which reopened the page just left (Settings, Back, Settings again), and the app then shows
    // where it went. Anything else goes where the entry points, as it always did: a link followed or an address typed
    // (a new entry, without state), and Back or Forward between entries of the same page (two addresses typed one after
    // the other). The depth of the page an entry is of is followed through Native Shell's own calls.
    depth = depthOf(history.state);
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name].bind(history);
      history[name] = (state, unused, url) => {
        original(state, unused, url);
        depth = depthOf(state);
      };
    }
    addEventListener("popstate", event => {
      const left = depth;
      depth = depthOf(event.state);
      const known = Boolean(event.state?.pikibun || event.state?.nshSession);
      const between = known && depth !== left;
      // A move that leaves the address as it is has no hashchange to come: the mark lapses rather than swallow a link.
      traversedAt = between ? Date.now() : 0;
      if (between && shown && location.hash !== shown) history.replaceState(history.state, "", shown);
    });
    addEventListener("hashchange", () => {
      const traversed = traversedAt && Date.now() - traversedAt < 1000;
      traversedAt = 0;
      if (traversed) return;
      player.hostEvent("page.route", route());
    });
  }
  return {
    call(name, args) {
      const fn = functions.get(name);
      if (!fn) throw new Error(`No host function ${name}.`);
      return fn(args);
    },
  };
}
