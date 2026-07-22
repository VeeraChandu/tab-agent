#!/usr/bin/env node
// scripts/publishToChromeStore.js
//
// Uploads the built extension zip to the Chrome Web Store and publishes it.
// Run only by semantic-release's @semantic-release/exec `publishCmd` on
// main (see .releaserc.json) — never on dev, so alpha releases never touch
// the Store.
//
// Usage:
//   node scripts/publishToChromeStore.js <version>
//   (version must match the zip already built by scripts/build.js, e.g.
//   dist/tab-agent-1.4.0.zip)
//
// Required env vars (see CLAUDE.md for how to obtain these):
//   CHROME_CLIENT_ID, CHROME_CLIENT_SECRET, CHROME_REFRESH_TOKEN, CHROME_EXTENSION_ID,
//   CHROME_PUBLISHER_ID (the developer account identifier shown in the Chrome Web
//   Store Developer Dashboard URL when logged in - NOT the extension ID)
//
// Optional env var:
//   CHROME_STORE_UPLOAD_ONLY=true — upload the new package but don't call
//   publish(). Useful for validating credentials/packaging without pushing
//   the update live (the upload still goes through the Store's own review
//   process once published later from the dashboard).

const fs = require("fs");
const path = require("path");
// chrome-webstore-upload ships as an ESM-only package ("type": "module"), so
// require()'ing it returns the module namespace object (with __esModule/
// default/named exports), not the factory function itself directly - the
// actual factory is the .default property.
const { default: chromeWebstoreUpload } = require("chrome-webstore-upload");

const ROOT = path.resolve(__dirname, "..");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `publishToChromeStore.js: missing required env var ${name}. ` +
        "See CLAUDE.md's Chrome Web Store setup checklist."
    );
  }
  return value;
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    throw new Error("publishToChromeStore.js: usage: node scripts/publishToChromeStore.js <version>");
  }

  const zipPath = path.join(ROOT, "dist", `tab-agent-${version}.zip`);
  if (!fs.existsSync(zipPath)) {
    throw new Error(`publishToChromeStore.js: expected zip missing: ${path.relative(ROOT, zipPath)} (did the exec prepareCmd build step run first?)`);
  }

  const extensionId = requireEnv("CHROME_EXTENSION_ID");
  const publisherId = requireEnv("CHROME_PUBLISHER_ID");
  const clientId = requireEnv("CHROME_CLIENT_ID");
  const clientSecret = requireEnv("CHROME_CLIENT_SECRET");
  const refreshToken = requireEnv("CHROME_REFRESH_TOKEN");

  const store = chromeWebstoreUpload({
    extensionId,
    publisherId,
    clientId,
    clientSecret,
    refreshToken,
  });

  console.log(`Uploading ${path.relative(ROOT, zipPath)} to Chrome Web Store (extension ${extensionId})...`);
  const uploadResult = await store.uploadExisting(fs.createReadStream(zipPath));
  if (uploadResult.uploadState === "FAILED") {
    throw new Error(`publishToChromeStore.js: upload failed: ${JSON.stringify(uploadResult.itemError || uploadResult)}`);
  }
  console.log(`Upload state: ${uploadResult.uploadState}`);

  if (process.env.CHROME_STORE_UPLOAD_ONLY === "true") {
    console.log("CHROME_STORE_UPLOAD_ONLY=true — skipping publish() call. Package uploaded but not pushed live.");
    return;
  }

  console.log("Publishing...");
  const publishResult = await store.publish("default");
  console.log(`Publish response: ${JSON.stringify(publishResult)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
