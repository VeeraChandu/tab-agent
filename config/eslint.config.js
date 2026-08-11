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
    ignores: ["dist/**", "node_modules/**", "coverage/**", "src/lib/pdf.min.js", "src/lib/pdf.worker.min.js"],
  },

  // ES module source files (service worker + lib modules that use import/export).
  {
    files: ["src/background.js", "src/options.js", "src/lib/agentLoop.js", "src/lib/providers.js", "src/lib/tools.js", "src/lib/vision.js", "src/lib/siteCategories.js", "src/lib/mediaSniffer.js", "src/lib/navErrors.js", "src/lib/trustedInput.js", "src/lib/pageCache.js", "src/lib/attachmentCache.js", "src/lib/statusBadge.js"],
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
    files: ["src/content.js", "src/consoleCapture.js", "src/sidepanel.js", "src/lib/markdown.js", "src/lib/pricing.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser, ...CHROME_GLOBALS },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // Node-side tooling: build script, config/ (this file, jest config,
  // semantic-release), and babel.config.js (the one config file that stays
  // at the repo root - see CLAUDE.md "Repo layout").
  {
    files: ["scripts/**/*.js", "config/**/*.js", "babel.config.js"],
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
