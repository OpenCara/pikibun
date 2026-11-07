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
]);

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
