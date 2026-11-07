// The page's host (nsh.json `web.host`), on the web only: the address the client is opened at and where it goes. Links
// into the app keep the routes the web app had, in the fragment (#/s/<id>, #/settings/hosts, #/shared/<token>,
// #/join/<token>), so a share or invite token never reaches the server; sign-in goes to the server's own pages.
// Native Shell copies this module as it is into the site (host.<digest>.js) and runs createHost before the app starts.

const page = typeof location !== "undefined" && typeof history !== "undefined";

/** The fragment, or "" where there is no page (nsh test runs this module headless too). */
const route = () => (page ? location.hash : "");

const functions = new Map([
  ["page.route", () => route()],
  // Shows the app's route in the address bar without a history entry of its own: Native Shell keeps the entries of
  // its pages and dialogs, whose state stays as it is.
  ["page.setRoute", args => {
    const hash = typeof args?.hash === "string" && /^#\/[^\s]*$/.test(args.hash) ? args.hash : "#/";
    if (page && location.hash !== hash) history.replaceState(history.state, "", hash);
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
  if (page && typeof addEventListener === "function") addEventListener("hashchange", () => player.hostEvent("page.route", route()));
  return {
    call(name, args) {
      const fn = functions.get(name);
      if (!fn) throw new Error(`No host function ${name}.`);
      return fn(args);
    },
  };
}
