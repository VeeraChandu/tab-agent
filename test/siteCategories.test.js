import { hostnameOf, detectSiteCategory } from "../lib/siteCategories.js";

describe("hostnameOf", () => {
  test("extracts and strips a leading www.", () => {
    expect(hostnameOf("https://www.chase.com/login")).toBe("chase.com");
    expect(hostnameOf("https://example.com/path?q=1")).toBe("example.com");
  });

  test("returns null for an unparseable URL", () => {
    expect(hostnameOf("not a url")).toBeNull();
    expect(hostnameOf("")).toBeNull();
  });
});

describe("detectSiteCategory", () => {
  test("flags known financial domains", () => {
    expect(detectSiteCategory("https://www.chase.com/")).toBe("financial");
    expect(detectSiteCategory("https://coinbase.com/dashboard")).toBe("financial");
    expect(detectSiteCategory("https://paypal.com/checkout")).toBe("financial");
  });

  test("flags known adult domains", () => {
    expect(detectSiteCategory("https://onlyfans.com/somepage")).toBe("adult");
  });

  test("returns null for an ordinary site", () => {
    expect(detectSiteCategory("https://www.wikipedia.org/wiki/Foo")).toBeNull();
    expect(detectSiteCategory("https://github.com/anthropics")).toBeNull();
  });

  test("returns null when the URL itself can't be parsed", () => {
    expect(detectSiteCategory("not a url")).toBeNull();
  });
});
