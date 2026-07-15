module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["**/test/**/*.test.js"],
  collectCoverageFrom: ["lib/**/*.js", "!lib/pdf.min.js", "!lib/pdf.worker.min.js"],
};
