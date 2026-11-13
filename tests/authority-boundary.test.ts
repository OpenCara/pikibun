import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = "apps/server/src";
const authority = `${server}/authority`;
const index = `${authority}/index.ts`;
const infrastructure = new Set([`${server}/types.ts`, `${server}/http.ts`, `${server}/schemas.ts`, `${server}/db.ts`, `${server}/db/types.ts`]);

function sources(directory: string, files: string[] = []): string[] {
  for (const name of readdirSync(join(repository, directory))) {
    if (name === "node_modules" || name === "dist") continue;
    const path = `${directory}/${name}`;
    if (statSync(join(repository, path)).isDirectory()) sources(path, files);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

interface Import { target: string; runtime: boolean }

function imports(file: string): Import[] {
  const source = ts.createSourceFile(file, readFileSync(join(repository, file), "utf8"), ts.ScriptTarget.Latest, true);
  const found: Import[] = [];
  const add = (specifier: string, runtime: boolean) => {
    if (!specifier.startsWith(".")) return;
    let target = relative(repository, resolve(repository, dirname(file), specifier)).replaceAll("\\", "/");
    if (target.endsWith(".js")) target = `${target.slice(0, -3)}.ts`;
    else if (!/\.(ts|tsx|json)$/.test(target)) target = existsSync(join(repository, `${target}.tsx`)) ? `${target}.tsx` : `${target}.ts`;
    found.push({ target, runtime });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const onlyTypes = !!clause && (clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)));
      add(node.moduleSpecifier.text, !onlyTypes);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const onlyTypes = node.isTypeOnly || (!!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly));
      add(node.moduleSpecifier.text, !onlyTypes);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      add(node.arguments[0].text, true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const inAuthority = (file: string) => file.startsWith(`${authority}/`);
const authorityFiles = sources(authority);

test("outside the authority, the apps reach it only through authority/index.ts", () => {
  const files = ["apps", "packages", "scripts"].flatMap(directory => sources(directory)).filter(file => !inAuthority(file));
  const reaching = files.flatMap(file => imports(file)
    .filter(({ target }) => inAuthority(target) && target !== index)
    .map(({ target }) => `${file} imports ${target}`));
  assert.deepEqual(reaching, []);
});

test("the authority uses nothing of the rest of the server but its request types, HTTP helpers and database", () => {
  assert.ok(authorityFiles.includes(index));
  const outside = authorityFiles.flatMap(file => imports(file)
    .filter(({ target }) => !inAuthority(target) && !target.startsWith("packages/shared/") && !infrastructure.has(target))
    .map(({ target }) => `${file} imports ${target}`));
  assert.deepEqual(outside, []);
});

test("loading the authority loads none of the relay, views or other features", () => {
  const loaded = new Set<string>();
  const pending = [...authorityFiles];
  while (pending.length) {
    const file = pending.pop()!;
    if (loaded.has(file)) continue;
    loaded.add(file);
    for (const { target, runtime } of imports(file)) if (runtime && target.startsWith(`${server}/`)) pending.push(target);
  }
  assert.deepEqual([...loaded].filter(file => !inAuthority(file) && !infrastructure.has(file)).sort(), []);
});

test("only the authority writes the audit log", () => {
  const writes = sources(server).filter(file => !inAuthority(file))
    .filter(file => /\b(insert\s+into|update|delete\s+from)\s+audit\b(?!_)/i.test(readFileSync(join(repository, file), "utf8")));
  assert.deepEqual(writes, [], "outside the authority, audit entries go through auditStatement or auditAfterChange");
});

const authorityTables = [
  "app_sign_in_codes", "auth_sessions", "automatic_github_effects", "connector_admins", "connector_host_grants", "connector_shares", "document_sources", "git_credentials",
  "github_tokens", "native_auth_codes", "oauth_states", "password_credentials", "push_credentials", "push_identities", "push_oauth_states",
  "repository_lfs_settings", "repository_push_policies", "run_admissions", "session_grants", "session_tool_grants", "source_accounts", "source_oauth_states",
  "source_read_settings", "users", "workspace_connections", "workspace_extensions", "workspace_members", "workspace_network_policies",
  "workspace_member_tool_groups", "workspace_repositories", "workspace_sources", "workspace_tool_groups",
];

test("only the authority writes the tables it decides from: the rest of the server goes through its statements", () => {
  const write = new RegExp(`\\b(?:(?:insert|replace)\\s+(?:or\\s+\\w+\\s+)?into|update(?:\\s+or\\s+\\w+)?|delete\\s+from)\\s+(${authorityTables.join("|")})\\b`, "gi");
  const writes = sources(server).filter(file => !inAuthority(file))
    .flatMap(file => [...readFileSync(join(repository, file), "utf8").matchAll(write)].map(match => `${file}: ${match[1]}`));
  assert.deepEqual(writes, []);
});
