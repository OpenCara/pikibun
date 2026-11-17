import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedExtensionPin } from "../packages/shared/src/managed-extensions.js";
import { npmRegistry, releaseProblems, type Published } from "../scripts/release-prerequisites.ts";

const integrity = `sha512-${"A".repeat(86)}==`;
const pin = (overrides: Partial<ManagedExtensionPin> = {}): ManagedExtensionPin => ({
  source: "piki:pr-flow", package: "@pikibun/pi-pr-flow", version: "0.6.0", integrity, minimumConnector: "0.40.0", ...overrides,
});

function registry(published: Record<string, Published>) {
  const asked: string[] = [];
  return { asked, lookup: async (name: string, version: string) => { asked.push(`${name}@${version}`); return published[`${name}@${version}`]; } };
}

test("a server release waits for the connector it needs and for every pinned extension, as npm has them", async () => {
  const everything = registry({ "pikibun@0.40.0": {}, "@pikibun/pi-pr-flow@0.6.0": { integrity } });
  assert.deepEqual(await releaseProblems({ minimumConnector: "0.40.0", pins: [pin()], registry: everything.lookup }), []);
  assert.deepEqual(everything.asked, ["pikibun@0.40.0", "@pikibun/pi-pr-flow@0.6.0"], "the connector is looked up once");

  const nothing = registry({});
  const problems = await releaseProblems({ minimumConnector: "0.41.0", pins: [pin()], registry: nothing.lookup });
  assert.equal(problems.length, 3);
  assert.match(problems[0]!, /needs connector 0\.41\.0 .*release the connector first \(cli-v0\.41\.0\)/);
  assert.match(problems[1]!, /@pikibun\/pi-pr-flow@0\.6\.0 .*release it first \(ext-pr-flow-v0\.6\.0\)/);
  assert.match(problems[2]!, /pin needs connector 0\.40\.0/);

  const tampered = registry({ "pikibun@0.40.0": {}, "@pikibun/pi-pr-flow@0.6.0": { integrity: `sha512-${"B".repeat(86)}==` } });
  const [wrong, ...rest] = await releaseProblems({ minimumConnector: "0.40.0", pins: [pin()], registry: tampered.lookup });
  assert.match(wrong!, /names integrity sha512-A+==, but npm has sha512-B+==/);
  assert.deepEqual(rest, []);
});

test("npm's registry answers a version, no version, or an error, each as such", async () => {
  const urls: string[] = [];
  const answers: Record<string, Response> = {
    "https://registry.example/pikibun/0.40.0": Response.json({ name: "pikibun", version: "0.40.0", dist: { integrity } }),
    "https://registry.example/@pikibun%2fpi-pr-flow/0.6.0": new Response("{}", { status: 404 }),
  };
  const fetcher = (async (url: string | URL | Request) => { urls.push(String(url)); return answers[String(url)] ?? new Response("down", { status: 503 }); }) as typeof fetch;
  const lookup = npmRegistry(fetcher, "https://registry.example");
  assert.deepEqual(await lookup("pikibun", "0.40.0"), { integrity });
  assert.equal(await lookup("@pikibun/pi-pr-flow", "0.6.0"), undefined);
  await assert.rejects(lookup("pikibun", "9.9.9"), /npm answered HTTP 503 for pikibun@9\.9\.9/);
  assert.deepEqual(urls, ["https://registry.example/pikibun/0.40.0", "https://registry.example/@pikibun%2fpi-pr-flow/0.6.0", "https://registry.example/pikibun/9.9.9"]);
});
