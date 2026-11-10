import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function fakeCloudflared(directory: string, mode: "address" | "exit" | "silent" = "address", name = "fake-quick-tunnel"): Promise<string> {
  const path = join(directory, "cloudflared");
  const script = `#!${process.execPath}
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ args, env: process.env, cwd: process.cwd() }) + "\\n");
const origin = new URL(args[args.indexOf("--url") + 1]);
const log = line => process.stderr.write(new Date().toISOString() + " " + line + "\\n");
log("INF Requesting new quick Tunnel on trycloudflare.com...");
if (${JSON.stringify(mode)} === "exit") {
  log('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: lookup api.trycloudflare.com: no such host');
  process.exit(1);
}
log('WRN retrying: Post "https://api.trycloudflare.com/tunnel" took a while');
if (${JSON.stringify(mode)} === "silent") setInterval(() => {}, 1000);
else {
  const edge = http.createServer((request, response) => {
    const forward = http.request({ host: origin.hostname, port: origin.port, method: request.method, path: request.url, headers: request.headers }, answer => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    forward.on("error", () => { response.writeHead(502); response.end("bad gateway"); });
    request.pipe(forward);
  });
  edge.listen(0, "127.0.0.1", () => {
    log("INF +--------------------------------------------------------------------------------------------+");
    log("INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");
    log("INF |  https://${name}.trycloudflare.com                                                          |");
    log("INF +--------------------------------------------------------------------------------------------+");
    process.stdout.write("FAKE_EDGE=" + edge.address().port + "\\n");
    setTimeout(() => log("INF Registered tunnel connection connIndex=0 connection=fake event=0 ip=198.41.192.7 location=test protocol=quic"), 50);
  });
}
process.on("SIGTERM", () => { log("INF Initiating graceful shutdown due to signal terminated ..."); process.exit(0); });
`;
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}
