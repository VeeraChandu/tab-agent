// Only used by Jest to transform ES module `lib/` files for the test
// runner. Source files themselves are never bundled/transpiled — Chrome
// loads them as raw ESM or classic scripts (see CLAUDE.md "Module system").
module.exports = {
  presets: [["@babel/preset-env", { targets: { node: "current" } }]],
};
