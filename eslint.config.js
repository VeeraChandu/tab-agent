// eslint.config.js — flat config (ESLint 9+).
//
// Source layout is deliberately mixed module systems (see CLAUDE.md): some
// files are ES modules, some are classic scripts loaded via <script src=...>
// with no bundler. Each block below matches that reality instead of forcing
// one sourceType on everything.
const js = require("@eslint/js");
const globals = require("globals");

const CHROME_GLOBALS = { chrome: "readonly" };

module.exports = [
  js.configs.recommended,

  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "lib/pdf.min.js", "lib/pdf.worker.min.js"],
  },

  // ES module source files (service worker + lib modules that use import/export).
  {
    files: ["background.js", "options.js", "lib/agentLoop.js", "lib/providers.js", "lib/tools.js", "lib/vision.js", "lib/siteCategories.js", "lib/mediaSniffer.js", "lib/pageCache.js", "lib/attachmentCache.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.serviceworker, ...CHROME_GLOBALS },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Classic (non-module) scripts loaded directly by sidepanel.html/options.html.
  {
    files: ["content.js", "sidepanel.js", "lib/markdown.js", "lib/pricing.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser, ...CHROME_GLOBALS },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Node-side tooling: build script, this config file, jest/babel config.
  {
    files: ["scripts/**/*.js", "*.config.js", "babel.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },

  // Tests.
  {
    files: ["**/*.test.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.jest, ...globals.browser },
    },
  },
];
