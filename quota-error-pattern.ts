// The keyword pattern provider routing reads as a quota failure. Both
// gemini-search.ts's classifier and brightdata.ts's sanitizer use it, so the text
// Bright Data neutralises is exactly the text the classifier would call quota.
// API error codes use underscores (rate_limit_exceeded, usage_limit_exceeded,
// insufficient_quota), so those match alongside the prose phrases. Hyphens never
// do, which is what Bright Data's "rate-limit notice" rewrite relies on.
export const QUOTA_ERROR_PATTERN = /rate[ _]limit|usage_limit|quota|too many requests/i;
