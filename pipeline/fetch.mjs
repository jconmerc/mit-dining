// Reads one hall's menu for one day straight from the hall's own page.
//
// Each page carries the whole day's menu as JSON inside a script tag
// (`Bamco.menu_items` and one `Bamco.dayparts[n]` per meal). Reading that is
// far steadier than scraping the printed menu: the fields are named, every
// dish has an id, and the vendor already marks which dishes are today's
// specials (tier 1) and which are the always-there bar items (tier 3).
import { hallUrl } from "./halls.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#039": "'", "#39": "'" };

export function clean(text) {
  return String(text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
      const key = name.toLowerCase();
      if (key in ENTITIES) return ENTITIES[key];
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
      return whole;
    })
    .replace(/[\s ]+/g, " ")
    .trim();
}

// Parses the JSON value that starts at `start`, by walking to its matching
// close bracket. The value sits in the middle of a script, so JSON.parse on
// the rest of the text would fail.
function jsonAt(text, start) {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) throw new Error("no JSON value at " + start);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSON value never closes");
}

const TAGS = {
  vegetarian: "vegetarian",
  vegan: "vegan",
  halal: "halal",
  kosher: "kosher",
  peanut: "peanut",
  "tree nut": "tree-nut",
  sesame: "sesame",
  fish: "fish",
  shellfish: "shellfish",
  "wheat/gluten": "gluten",
  milk: "milk",
  egg: "egg",
  soy: "soy",
};

function tagsOf(item) {
  const icons = item.cor_icon && typeof item.cor_icon === "object" ? Object.values(item.cor_icon) : [];
  return icons.map((label) => TAGS[String(label).toLowerCase()]).filter(Boolean);
}

function optionsOf(item) {
  const values = item.options && Array.isArray(item.options.values) ? item.options.values : [];
  return values.map((v) => clean(v.label)).filter(Boolean);
}

// Turns the page's data into our own plain shape. Returns { meals: [] } for a
// day the hall is closed.
export function parseHallPage(html) {
  const found = /Bamco\.menu_items\s*=\s*(?=[{[])/.exec(html);
  if (!found) {
    // A hall that's shut (weekends at some halls, renovations) still has a
    // page, with a "closed" notice where the menu would be.
    if (!/closed/i.test(html)) throw new Error("page has no menu data");
    const why = /Closed for [a-z ,'-]{3,60}/.exec(clean(html));
    return { meals: [], closed: why ? why[0].trim() : "Closed" };
  }
  const items = jsonAt(html, found.index + found[0].length);

  const meals = [];
  for (const match of html.matchAll(/Bamco\.dayparts\['(\d+)'\]\s*=\s*/g)) {
    const part = jsonAt(html, match.index + match[0].length);
    const stations = [];
    for (const station of part.stations ?? []) {
      const rows = [];
      for (const id of station.items ?? []) {
        const item = items[id];
        if (!item) continue;
        rows.push({
          id: String(item.id),
          label: clean(item.label),
          description: clean(item.description),
          options: optionsOf(item),
          tags: tagsOf(item),
          // Tier 1 and 2 are the day's dishes. Tier 3 is the standing bar:
          // salad greens, condiments, cereal, the omelet fillings.
          featured: Number(item.tier) < 3 || Number(item.special) === 1,
          group: clean(item.sub_station),
        });
      }
      if (rows.length) stations.push({ name: clean(station.label), items: rows });
    }
    meals.push({
      id: String(part.id),
      label: clean(part.label),
      start: part.starttime,
      end: part.endtime,
      stations,
    });
  }
  meals.sort((a, b) => a.start.localeCompare(b.start));
  return { meals };
}

export async function fetchHallDay(hall, date, { retries = 2 } = {}) {
  const url = hallUrl(hall, date);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // A page that redirected somewhere else isn't this hall on this day.
      if (!res.url.includes(`/cafe/${hall.slug}/`)) throw new Error("redirected to " + res.url);
      const html = await res.text();
      return { hall: hall.id, date, url, ...parseHallPage(html) };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${hall.id} ${date}: ${lastError.message}`);
}
