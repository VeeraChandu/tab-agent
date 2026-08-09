#!/usr/bin/env node
// scripts/build.js
//
// Packages the loadable extension into dist/tab-agent-<version>.zip.
//
// Usage:
//   node scripts/build.js                 — zip using the version already in manifest.json
//   node scripts/build.js 1.4.0            — sync manifest.json + package.json to 1.4.0, then zip
//   node scripts/build.js 1.4.0 --store    — same, but also strip manifest.json's "key" field
//                                            and write to dist/store/tab-agent-1.4.0.zip instead
//
// The version arg form is how semantic-release drives this (see .releaserc.json's
// @semantic-release/exec prepareCmd: `node scripts/build.js ${nextRelease.version}`).
// semantic-release computes versions like "1.4.0" or occasionally a prerelease such
// as "1.4.0-beta.1" on a prerelease branch; Chrome's manifest "version" field only
// accepts 1-4 dot-separated integers, so we strip any -prerelease/+build suffix
// before writing it there (package.json keeps the full semver as usual).
//
// --store exists because manifest.json's "key" field pins a fixed extension id for
// local "Load unpacked" installs (see README's "Updating" section), but the Chrome
// Web Store rejects any uploaded manifest that contains a "key" field at all - it
// assigns and owns the id itself once an item is created. The regular (non --store)
// zip is what ships in GitHub Releases for "Load unpacked" users and must keep the
// key; the --store zip is what scripts/publishToChromeStore.js uploads and must not.

const fs = require("fs");
const path = require("path");
// archiver v8's CJS interop exposes named exports (ZipArchive class), not
// the old v5/v6/v7 `archiver(format, opts)` factory function — see
// https://www.archiverjs.com/ "Quick Start" for the current API.
const { ZipArchive } = require("archiver");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");
const DIST_DIR = path.join(ROOT, "dist");

// Exactly what a `chrome://extensions` "Load unpacked" needs, read from
// src/ - nothing from the dev toolchain (tests, configs, node_modules, the
// root docs/ GitHub Pages site) ships in the zip. src/docs/privacy-policy.html
// is a deliberate hand-kept duplicate of the root docs/privacy-policy.html
// (see CLAUDE.md "Repo layout") - the Options page's Privacy tab links to it
// relatively, so it needs to live inside src/ to be reachable both from a
// local "Load unpacked" pointed at src/ and from this zip, even offline or
// before GitHub Pages is set up.
const INCLUDE = ["manifest.json", "background.js", "content.js", "consoleCapture.js", "options.html", "options.css", "options.js", "sidepanel.html", "sidepanel.css", "sidepanel.js", "icons", "lib", "docs"];

function toManifestVersion(semver) {
  // Chrome requires 1-4 dot-separated non-negative integers, no -/+ suffix.
  return semver.split(/[-+]/)[0];
}

function syncVersion(semver) {
  const manifestVersion = toManifestVersion(semver);

  const manifestPath = path.join(SRC_DIR, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = manifestVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = semver;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  console.log(`Synced version -> manifest.json: ${manifestVersion}, package.json: ${semver}`);
}

function currentManifestVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8"));
  return manifest.version;
}

async function zipExtension(zipVersion, { forStore = false } = {}) {
  const outDir = forStore ? path.join(DIST_DIR, "store") : DIST_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `tab-agent-${zipVersion}.zip`);
  const output = fs.createWriteStream(outPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    archive.on("error", reject);
  });

  archive.pipe(output);
  for (const entry of INCLUDE) {
    const fullPath = path.join(SRC_DIR, entry);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`build.js: expected file/dir missing: ${entry}`);
    }
    if (entry === "manifest.json" && forStore) {
      // Chrome Web Store upload validation fails with "key field is not
      // allowed in manifest" if this is left in - strip it from the copy
      // that goes in the archive without touching the real manifest.json
      // on disk (local "Load unpacked" installs still need it).
      const manifest = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      delete manifest.key;
      archive.append(JSON.stringify(manifest, null, 2) + "\n", { name: entry });
      continue;
    }
    if (fs.statSync(fullPath).isDirectory()) {
      archive.directory(fullPath, entry);
    } else {
      archive.file(fullPath, { name: entry });
    }
  }
  await archive.finalize();
  await done;

  console.log(`Built ${path.relative(ROOT, outPath)} (${(archive.pointer() / 1024).toFixed(1)} KB)`);
  return outPath;
}

async function main() {
  const args = process.argv.slice(2);
  const forStore = args.includes("--store");
  const versionArg = args.find((arg) => !arg.startsWith("--"));
  if (versionArg) syncVersion(versionArg);
  const zipVersion = versionArg || currentManifestVersion();
  await zipExtension(zipVersion, { forStore });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
