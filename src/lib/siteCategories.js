// lib/siteCategories.js
// Best-effort site-category detection for the adult-content / financial
// "confirm before proceeding" gate. Deliberately NOT a blocklist — the goal
// is to ask once (age confirmation / explicit permission), remember the
// answer per domain, and otherwise stay out of the way. Two independent
// signals feed this:
//  1. A curated hostname list (this file) — fast, works before any page
//     content loads, catches well-known sites.
//  2. The page's own RTA/ICRA self-rating meta tag (checked in content.js,
//     folded into read_page's result as `meta_category`) — the actual
//     industry-standard label real content filters use, catching sites this
//     hostname list doesn't know about.
// Neither is exhaustive. This is intentionally conservative and imperfect —
// false negatives are expected for less common sites in either category.

const FINANCIAL_DOMAIN_HINTS = [
  /(^|\.)chase\.com$/i,
  /(^|\.)bankofamerica\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)citibank\.com$/i,
  /(^|\.)citi\.com$/i,
  /(^|\.)capitalone\.com$/i,
  /(^|\.)usbank\.com$/i,
  /(^|\.)ally\.com$/i,
  /(^|\.)pnc\.com$/i,
  /(^|\.)tdbank\.com$/i,
  /(^|\.)hsbc\.(com|co\.uk)$/i,
  /(^|\.)barclays\.(com|co\.uk)$/i,
  /(^|\.)nationwide\.co\.uk$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)venmo\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)square\.(com|site)$/i,
  /(^|\.)coinbase\.com$/i,
  /(^|\.)binance\.(com|us)$/i,
  /(^|\.)kraken\.com$/i,
  /(^|\.)gemini\.com$/i,
  /(^|\.)fidelity\.com$/i,
  /(^|\.)schwab\.com$/i,
  /(^|\.)vanguard\.com$/i,
  /(^|\.)etrade\.com$/i,
  /(^|\.)robinhood\.com$/i,
  /(^|\.)americanexpress\.com$/i,
  /(^|\.)discover\.com$/i,
  /(^|\.)chime\.com$/i,
  /(^|\.)sofi\.com$/i,
  /(^|\.)revolut\.com$/i,
  /(^|\.)wise\.com$/i,
  /\bbanking\b/i,
  /\bcreditunion\b/i,
  /\bbrokerage\b/i,
];

// Deliberately specific, unambiguous terms only — avoids generic words
// (e.g. plain "adult") that would false-positive on unrelated sites.
const ADULT_DOMAIN_HINTS = [
  /\bporn\w*\b/i,
  /\bxxx\b/i,
  /\bxvideos\b/i,
  /\bxnxx\b/i,
  /\bxhamster\b/i,
  /\bredtube\b/i,
  /\bbrazzers\b/i,
  /\bchaturbate\b/i,
  /\bcamsoda\b/i,
  /\bmyfreecams\b/i,
  /\bonlyfans\b/i,
  /\bfansly\b/i,
  /\bescort\w*\b/i,
  /\bstripchat\b/i,
  /\blivejasmin\b/i,
];

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {"adult" | "financial" | null}
 */
export function detectSiteCategory(url) {
  const hostname = hostnameOf(url);
  if (!hostname) return null;
  if (ADULT_DOMAIN_HINTS.some((re) => re.test(hostname))) return "adult";
  if (FINANCIAL_DOMAIN_HINTS.some((re) => re.test(hostname))) return "financial";
  return null;
}
