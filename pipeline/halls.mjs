// The six residential dining halls. `slug` is the hall's page on
// mit.cafebonappetit.com. Those addresses don't change from week to week,
// unlike the print-menu links, which get a new menu number every Monday.
export const HALLS = [
  { id: "maseeh", name: "Maseeh", slug: "the-howard-dining-hall-at-maseeh" },
  { id: "new-vassar", name: "New Vassar", slug: "new-vassar" },
  { id: "baker", name: "Baker", slug: "baker" },
  { id: "simmons", name: "Simmons", slug: "simmons" },
  { id: "next", name: "Next House", slug: "next" },
  { id: "mccormick", name: "McCormick", slug: "mccormick" },
];

export const SOURCE = "https://mit.cafebonappetit.com";
export const TIMEZONE = "America/New_York";

export function hallUrl(hall, date) {
  return `${SOURCE}/cafe/${hall.slug}/${date}/`;
}

// "2026-11-14" for today in Cambridge, plus `offset` days.
export function campusDate(offset = 0, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(now);
  const d = new Date(today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
