// Writes the week's menus as compact text for the question box. Claude reads
// this once per conversation, so it is laid out to be short: one line per
// station, one-letter tags, and the standing bars listed once per hall
// instead of under every meal.

export const RULES = `You answer questions about what MIT's dining halls are serving, for a student deciding where to eat. Below are this week's menus for every hall, already cleaned up.

Each question starts with the current date and time in Cambridge. Use it to work out what "now", "tonight", "tomorrow" and "open" mean, and whether a meal has already ended.

Answer like a friend who has read every menu: lead with the answer (which hall, which dish, when), and keep it to a few lines. When someone asks what's good or where to go, pick one or two halls and say why instead of listing everything. If the menus don't say, tell them so plainly; don't guess at dishes, ingredients or hours that aren't listed.

Write plain text. Short "- " lists and **bold** hall names are fine. No headings or tables.

Diet and allergen marks are the halls' own labels. For an allergy question, say what the labels show and add that the kitchen is the place to confirm.

How to read the menus: a "!" before a dish marks it as one of that meal's main draws. Marks in braces after a dish: V vegetarian, VG vegan, H halal, K kosher; then the allergens the hall flags: g gluten, m milk, e egg, s soy, p peanut, t tree nut, f fish, sf shellfish, se sesame. A dish followed by a colon and a list is build-your-own, with its choices. "Always available" lists each hall's standing bars, which are out at most meals without changing day to day.`;

const DIET = { vegan: "VG", vegetarian: "V", halal: "H", kosher: "K" };
const ALLERGEN = { gluten: "g", milk: "m", egg: "e", soy: "s", peanut: "p", "tree-nut": "t", fish: "f", shellfish: "sf", sesame: "se" };

function marks(tags, withAllergens) {
  const diet = Object.keys(DIET).filter((t) => tags.includes(t)).map((t) => DIET[t]);
  const has = withAllergens ? Object.keys(ALLERGEN).filter((t) => tags.includes(t)).map((t) => ALLERGEN[t]) : [];
  if (!diet.length && !has.length) return "";
  return ` {${[diet.join(" "), has.join(" ")].filter(Boolean).join("; ")}}`;
}

function dishText(dish, hall) {
  const lead = dish.headline ? "!" : "";
  if (dish.parts.length === 1) {
    const item = hall.items[dish.parts[0].id] || { t: [] };
    return `${lead}${dish.name}${marks(item.t, true)}${dish.note ? ` (${dish.note})` : ""}`;
  }
  const choices = dish.parts.map((p) => {
    const item = hall.items[p.id] || { n: "", t: [] };
    return (p.name || item.n) + marks(item.t, false);
  });
  return `${lead}${dish.name}: ${choices.join(", ")}`;
}

export function dayTitle(date) {
  return new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

export function buildContext(index, days) {
  const out = [];
  const standing = new Map();

  for (const date of index.dates) {
    const day = days[date];
    if (!day) continue;
    out.push(`\n=== ${dayTitle(date)} (${date}) ===`);
    for (const { id, name } of index.halls) {
      const hall = day.halls[id];
      if (!hall || !hall.meals.length) {
        out.push(`${name}: closed${hall && hall.closed && hall.closed !== "Closed" ? ` (${hall.closed})` : ""}`);
        continue;
      }
      out.push(name);
      for (const meal of hall.meals) {
        out.push(` ${meal.label} ${meal.start}-${meal.end}`);
        for (const station of meal.stations) {
          out.push(`  ${station.name}: ${station.dishes.map((d) => dishText(d, hall)).join("; ")}`);
        }
        for (const group of meal.staples) {
          const key = `${name}|${group.station}|${group.group}`;
          if (!standing.has(key)) standing.set(key, { name, station: group.station, group: group.group, items: new Set() });
          for (const itemId of group.ids) if (hall.items[itemId]) standing.get(key).items.add(hall.items[itemId].n);
        }
      }
    }
  }

  const always = ["\n=== Always available ==="];
  let current = "";
  for (const { name, station, group, items } of standing.values()) {
    if (name !== current) always.push(name);
    current = name;
    const label = station.toLowerCase() === group.toLowerCase() ? station : `${station}, ${group.toLowerCase()}`;
    always.push(`  ${label}: ${[...items].join(", ")}`);
  }
  return out.join("\n").trim() + "\n" + always.join("\n");
}
