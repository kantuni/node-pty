const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const originalPackageJson = require("../package.json");

const REPO_ROOT = path.join(__dirname, "..");
const LIB = path.join(REPO_ROOT, "lib");
const DIST = path.join(REPO_ROOT, "dist");

const variants = [
  {
    name: "macOS",
    platform: "darwin",
    arch: "x64",
  },
  {
    name: "macOS ARM",
    platform: "darwin",
    arch: "arm64",
  },
  {
    name: "Linux x86_64",
    platform: "linux",
    arch: "x64",
  },
  {
    name: "Windows",
    platform: "win32",
    arch: "x64",
  }
]

const packageJson = {
  "name": "@lydell/node-pty",
  "description": "node-pty with prebuilt binaries",
  "author": "Simon Lydell",
  "version": originalPackageJson.forkVersion,
  "license": originalPackageJson.license,
  "main": "./index.js",
  "types": "./node-pty.d.ts",
  "repository": {
    "type": "git",
    "url": "git://github.com/lydell/node-pty.git"
  },
  "keywords": [
    ...originalPackageJson.keywords,
    "prebuild",
    "prebuilt"
  ],
  "dependencies": originalPackageJson.dependencies,
  "optionalDependencies": Object.fromEntries(variants.map(({ platform, arch }) => [
    `@lydell/node-pty-${platform}-${arch}`,
    originalPackageJson.forkVersion
  ]))
}

fs.rmSync(LIB, { recursive: true, force: true });
fs.rmSync(DIST, { recursive: true, force: true });

const result = childProcess.spawnSync("npx", ["tsc", "-b", path.join(REPO_ROOT, "src", "tsconfig.json")], {
  shell: true,
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status);
}

fs.cpSync(LIB, DIST, { recursive: true, filter: src => !src.endsWith(".test.js") });

fs.cpSync(path.join(REPO_ROOT, "LICENSE"), path.join(DIST, "LICENSE"));
fs.cpSync(path.join(REPO_ROOT, "typings", "node-pty.d.ts"), path.join(DIST, "node-pty.d.ts"));

fs.writeFileSync(path.join(DIST, "package.json"), JSON.stringify(packageJson, null, 2));

const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
const newReadme = `
${readme.trim()}

## Version

@lydell/node-pty@${originalPackageJson.forkVersion} is based on node-pty@${originalPackageJson.version} (plus maybe a few more unreleased commits).

## Prebuilt binaries

This package includes prebuilt binaries for the following platforms and architectures:

${variants.map(({ name, platform, arch }) => `- ${name} (${platform}-${arch})`).join("\n")}
`.trim();
fs.writeFileSync(path.join(DIST, "README.md"), newReadme);
