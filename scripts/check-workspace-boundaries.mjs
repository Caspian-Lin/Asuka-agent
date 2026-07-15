import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const repositoryRoot = process.cwd();
const workspaceParents = ["apps", "packages"];
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts"]);
const ignoredDirectories = new Set(["node_modules", "dist", ".next", ".vinext"]);

async function workspaceDirectories() {
  const directories = [];
  for (const parent of workspaceParents) {
    const parentPath = resolve(repositoryRoot, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(resolve(parentPath, entry.name));
    }
  }
  return directories;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (sourceExtensions.has(extension)) files.push(path);
  }
  return files;
}

function dependencyNames(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

function publicSubpath(manifest, specifier) {
  const prefix = `${manifest.name}/`;
  if (!specifier.startsWith(prefix)) return ".";
  return `./${specifier.slice(prefix.length)}`;
}

function exportedSubpaths(manifest) {
  if (typeof manifest.exports === "string") return new Set(["."]);
  return new Set(Object.keys(manifest.exports ?? {}));
}

const workspaceRoots = await workspaceDirectories();
const workspaces = [];
for (const root of workspaceRoots) {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  workspaces.push({
    root,
    manifest,
    dependencies: dependencyNames(manifest),
    exports: exportedSubpaths(manifest),
  });
}

const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]));
const violations = [];
const importPattern = /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

for (const workspace of workspaces) {
  for (const file of await sourceFiles(workspace.root)) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        const outside = relative(workspace.root, target);
        if (outside === ".." || outside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
          violations.push(`${relative(repositoryRoot, file)} crosses its workspace boundary: ${specifier}`);
        }
        continue;
      }
      if (!specifier.startsWith("@asuka-agent/")) continue;
      const packageName = specifier.split("/").slice(0, 2).join("/");
      if (packageName === workspace.manifest.name) continue;
      const targetWorkspace = byName.get(packageName);
      if (!targetWorkspace) {
        violations.push(`${relative(repositoryRoot, file)} imports unknown workspace ${packageName}`);
        continue;
      }
      if (!workspace.dependencies.has(packageName)) {
        violations.push(`${workspace.manifest.name} must declare ${packageName} before importing it`);
      }
      const subpath = publicSubpath(targetWorkspace.manifest, specifier);
      if (!targetWorkspace.exports.has(subpath)) {
        violations.push(`${relative(repositoryRoot, file)} imports non-exported ${specifier}`);
      }
    }
  }
}

const graph = new Map(
  workspaces.map((workspace) => [
    workspace.manifest.name,
    [...workspace.dependencies].filter((name) => byName.has(name)),
  ]),
);
const visiting = new Set();
const visited = new Set();
function visit(name, path = []) {
  if (visiting.has(name)) {
    violations.push(`workspace dependency cycle: ${[...path, name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  visiting.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...path, name]);
  visiting.delete(name);
  visited.add(name);
}
for (const name of graph.keys()) visit(name);

for (const workspace of workspaces) {
  try {
    await readFile(resolve(workspace.root, "package-lock.json"));
    violations.push(`${relative(repositoryRoot, workspace.root)} contains a nested package-lock.json`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (violations.length > 0) {
  console.error(violations.map((violation) => `- ${violation}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Workspace boundaries passed for ${workspaces.length} workspaces.`);
}
