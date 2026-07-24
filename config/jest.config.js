const path = require("path");

module.exports = {
  // Jest defaults rootDir to this config file's own directory - point it back
  // at the repo root so testMatch/collectCoverageFrom below (and test files'
  // own "../src/..." imports) resolve the same as when jest.config.js lived
  // at the repo root.
  rootDir: path.resolve(__dirname, ".."),
  testEnvironment: "jsdom",
  testMatch: ["**/test/**/*.test.js"],
  collectCoverageFrom: ["src/lib/**/*.js", "!src/lib/pdf.min.js", "!src/lib/pdf.worker.min.js"],
};
