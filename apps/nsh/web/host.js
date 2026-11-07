// The page's host (nsh.json `web.host`), on the web only: the address the client is opened at and where it goes. Links
// into the app keep the routes the web app had, in the fragment (#/s/<id>, #/settings/hosts, #/shared/<token>,
// #/join/<token>), so a share or invite token never reaches the server; sign-in goes to the server's own pages.
// Native Shell copies this module as it is into the site (host.<digest>.js) and runs createHost before the app starts.

const page = typeof location !== "undefined" && typeof history !== "undefined";

/** The fragment, or "" where there is no page (nsh test runs this module headless too). */
const route = () => (page ? location.hash : "");

/** The address the app last showed: where it is now. */
let shown = null;
/** When a move between the app's own history entries happened, until its hashchange comes (0: none pending). */
let traversedAt = 0;

const functions = new Map([
  ["page.route", () => route()],
  // Shows the app's route in the address bar without a history entry of its own: Native Shell keeps the entries of
  // its pages and dialogs, whose state stays as it is.
  ["page.setRoute", args => {
    const hash = typeof args?.hash === "string" && /^#\/[^\s]*$/.test(args.hash) ? args.hash : "#/";
    shown = hash;
    // Marks the entry as the app's: Native Shell's entries copy the state of the one they're pushed from.
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
    // address, so an entry can hold another page's address. A move between the app's entries (Back, from the app or the
    // browser) is Native Shell's to follow: the entry it lands on gets the app's address back rather than being taken as
    // a link, which reopened the page just left (Settings, Back, Settings again); the app then shows where it went. A
    // link or an edited address is a new entry without the app's state, and goes where it points.
    addEventListener("popstate", event => {
      const traversing = Boolean(event.state?.nshSession || event.state?.pikibun);
      // A move that leaves the address as it is has no hashchange to come: the mark lapses rather than swallow a link.
      traversedAt = traversing ? Date.now() : 0;
      if (traversing && shown && location.hash !== shown) history.replaceState(history.state, "", shown);
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
