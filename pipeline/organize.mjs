// Turns one meal's raw listing into a menu a student would recognise.
//
// The vendor's data is laid out for the kitchen. An omelet bar arrives as
// fifteen separate "dishes" (liquid egg, mushroom, pit ham...), a burger's
// bun and pickles sit beside the burger as their own entries, and theme-night
// titles and certification notes are mixed in with the food. Claude regroups
// and renames; the checks below make sure it only rearranged what was there.
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const MODEL = process.env.ORGANIZER_MODEL || "claude-opus-5-5";
const EFFORT = process.env.ORGANIZER_EFFORT || "medium";
// Bump when the prompt or the output shape changes, so cached meals are redone.
const VERSION = 3;

// Dollars per million tokens, for the run's cost estimate.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-2": [8, 40],
};

export const KINDS = [
  "entree",
  "side",
  "soup",
  "salad",
  "build_your_own",
  "dessert",
  "bakery",
  "condiment",
  "beverage",
  "other",
];

export const Organized = z.object({
  summary: z.string(),
  stations: z.array(
    z.object({
      name: z.string(),
      dishes: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(KINDS),
          headline: z.boolean(),
          note: z.string().nullable(),
          parts: z.array(z.object({ ref: z.string(), name: z.string() })),
        }),
      ),
    }),
  ),
  dropped: z.array(z.object({ ref: z.string(), reason: z.string() })),
});

const Names = z.object({
  names: z.array(z.object({ n: z.number(), name: z.string() })),
});

export const SYSTEM = `You tidy dining hall menus for a website MIT students use to decide where to eat.

You'll get one meal at one hall, exactly as the food-service vendor's system lists it. That listing is organised for kitchen staff, so a student reading it raw sees nonsense: an omelet bar shows up as fifteen separate "dishes" (liquid egg, mushroom, pit ham), a burger's bun, cheese and pickles are listed as dishes next to the burger, a theme-night title or a "certified by" note sits in the list as if it were food, and names are lowercase and sometimes back to front ("cookie chocolate chunk"). Your job is to turn the listing into the menu a student would expect to read, without adding or losing any real food.

The listing has two kinds of lines, each with a ref:
- "a" refs are items the kitchen put on today's menu for this meal.
- "g" refs are standing bars that are there every day (salad greens, condiments, cereal). Each "g" line is a whole group of items.

How to organise it:

Every "a" ref must end up in exactly one place: as a part of one dish, or in "dropped". Nothing may be left out and nothing used twice. Never invent a dish or a part that has no ref.

Most items are simply one dish with one part. Put several refs into a single dish only when together they are one thing a student orders or assembles: a build-your-own bar and its fillings, a burger or sandwich station's buns, cheeses and toppings, a bowl and the components it's built from, a nacho or taco bar, the salad bar, a yogurt and fruit bar. Call those "build_your_own" and name the dish for what it is ("Build-your-own omelet", "Burrito bowl bar", "Burger toppings", "Salad bar"). A loose run of garnishes and sauces at a station, with no dish of their own, becomes one "Toppings and sauces" dish there. A plated main and the sides served beside it stay separate dishes, and so do a pasta and its sauce.

Titles: when a station lists a title or theme line ("Nacho night", "Hibachi style", "salmon bowl" followed by the bowl's components), drop the title's ref. If it introduces one bar or bowl, use it as that dish's name. If it sits over several ordinary dishes ("Saturday night market" above tacos and a gyro), leave their names alone and mention the theme in each one's note.

A "g" ref is optional. Use one only when that standing bar clearly belongs to a dish you are building (the standing omelet fillings belong in the omelet dish; the grill's standing cheeses and vegetables belong with the burger toppings; the salad station's standing bars belong in the salad bar dish). Leave every other "g" ref unused, and the site will list it under "always available"; a station with nothing but unused "g" refs is left out of your answer. One exception: a meal with few or no "a" items is still a meal, so build its dishes from the standing bars a student would come for (the omelet bar, waffles and pancakes, hot cereal) instead of returning nothing. The "name" you give a "g" part is ignored.

Drop only what isn't food: blank items, certification or sourcing notes, titles, event announcements, section labels like "DINNER", and the second copy of an item listed twice at one station. Give a few words of reason. If a line mixes an announcement with real food, keep the food and put the rest in its note.

Names: write each dish and part name the way a good menu would, in sentence case, with proper nouns and cuisines capitalised ("jamaican jerk hot sauce" is "Jamaican jerk hot sauce"). Fix typos and inverted or clipped names. Drop kitchen detail a diner doesn't need ("cage free liquid eggs" is "Eggs"; "chocolate brownie (gold medal)" is "Chocolate brownie"; "ground beef patty, hamburger" is "Hamburger"), but keep words a diner chooses by: vegan, vegetarian, gluten-free, halal, turkey, decaf. Keep the dish itself exactly what it is: don't add words the listing doesn't have, upgrade it, guess ingredients, or merge two different dishes into one name.

"kind" says what the dish is. "headline" is true for the dishes that would make someone pick this hall for this meal: the mains, the specials, the hot entrees, a themed or made-to-order bar (stir-fry, ramen night, a rice bowl bar). Sides, soups, the everyday omelet bar, standard grill items and plain pizzas that are there every day, salad bar, bread, desserts, condiments and drinks are not headlines, unless one is clearly the day's special. Use "other" for things the kinds don't cover, like oatmeal or yogurt.

"note" is for one short useful fact the name doesn't carry, taken from the item's description or options (what a dish comes with, "made to order"). Use null when there's nothing worth saying, which is most of the time.

Station names: keep the hall's stations and their order, cleaned up for a diner ("@global" becomes "Global", "stockpot" becomes "Soups"). You may move an item to the station where it obviously belongs, such as syrup next to the French toast.

"summary" is at most twelve words naming the two to four dishes most worth knowing about for this meal, as a plain list ("Chicken tikka masala, pork rogan josh, veggie stir-fry"). If the meal is only standing items, say so plainly ("Omelets, oatmeal and the usual breakfast bar").`;

const NAMES_SYSTEM = `You clean up item names from a dining hall's standing bars (salad bar, condiments, cereal, desserts, drinks) for a menu website. The names come from a kitchen inventory system, so they are lowercase and sometimes back to front or padded with stock detail.

For each numbered name, give the name a menu would print: sentence case, proper nouns capitalised, word order fixed ("cookie chocolate chunk" becomes "Chocolate chunk cookie", "milk 2%" becomes "2% milk", "yogurt blueberry low-fat" becomes "Low-fat blueberry yogurt"), brand and stock detail removed where it adds nothing. Keep it the same item: never swap in a different food, and keep distinctions that matter to a diner (fat-free, vegan, gluten-free, decaf). Return every number exactly once.`;

// ---------------------------------------------------------------- helpers

const STOP = new Set(
  "and with of the a an in on for to style fresh free cage made house each your own build bar served or de la".split(" "),
);

function words(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // "jalapeño" and "jalapeno" are the same word
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(es|s)$/, ""));
}

// True when a cleaned-up name still talks about the same food as the raw
// label. Catches a name attached to the wrong item.
export function sameFood(name, ...raw) {
  const have = new Set(raw.flatMap(words));
  if (have.size === 0) return true;
  return words(name).some((w) => have.has(w));
}

// The plain cleanup used when Claude isn't available or its answer fails the
// checks: sentence case, nothing clever.
export function tidy(label) {
  const text = String(label).trim().replace(/\s+/g, " ");
  if (!text) return "";
  const lower = text === text.toUpperCase() ? text.toLowerCase() : text;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const DIET = new Set(["vegetarian", "vegan", "halal", "kosher"]);

// Gives every featured item and every standing group in the meal a short ref
// and writes the listing Claude reads.
export function layOut(meal) {
  const refs = new Map();
  const lines = [];
  let a = 0;
  let g = 0;
  for (const station of meal.stations) {
    lines.push(`STATION ${station.name || "(unnamed)"}`);
    const groups = new Map();
    for (const item of station.items) {
      if (item.featured) {
        const ref = `a${++a}`;
        refs.set(ref, { type: "item", station: station.name, item });
        let line = `  ${ref}  ${item.label || "(blank)"}`;
        if (item.description) line += `  — ${item.description}`;
        if (item.options.length) line += `  (options: ${item.options.join("; ")})`;
        const diet = item.tags.filter((t) => DIET.has(t));
        if (diet.length) line += `  [${diet.join(", ")}]`;
        lines.push(line);
      } else {
        const key = item.group || "other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
    }
    for (const [group, items] of groups) {
      const ref = `g${++g}`;
      refs.set(ref, { type: "group", station: station.name, group, items });
      const shown = items.slice(0, 14).map((i) => i.label).join(", ");
      const more = items.length > 14 ? `, +${items.length - 14} more` : "";
      lines.push(`  ${ref}  standing bar "${group}": ${shown}${more}`);
    }
  }
  return { refs, text: lines.join("\n") };
}

export function mealKey(hallId, meal) {
  const body = meal.stations.map((s) => [
    s.name,
    s.items.map((i) => [i.id, i.label, i.description, i.options, i.tags, i.featured, i.group]),
  ]);
  return crypto
    .createHash("sha1")
    .update(JSON.stringify([VERSION, MODEL, hallId, meal.label, body]))
    .digest("hex")
    .slice(0, 20);
}

// ----------------------------------------------------------------- checks

// Returns the problems that make an answer unusable. An empty list means
// every featured item is accounted for exactly once and nothing was made up.
export function problemsWith(answer, refs) {
  const problems = [];
  const seen = new Map();
  const note = (ref) => seen.set(ref, (seen.get(ref) || 0) + 1);
  for (const station of answer.stations) {
    for (const dish of station.dishes) {
      if (!dish.name.trim()) problems.push("a dish has no name");
      if (dish.parts.length === 0) problems.push(`dish "${dish.name}" has no parts, so it isn't on the menu`);
      for (const part of dish.parts) note(part.ref);
    }
  }
  for (const drop of answer.dropped) note(drop.ref);

  for (const [ref, count] of seen) {
    if (!refs.has(ref)) problems.push(`${ref} is not a ref in the listing`);
    else if (count > 1) problems.push(`${ref} is used ${count} times; use it once`);
  }
  const featured = [...refs].filter(([, r]) => r.type === "item");
  const missing = featured.filter(([ref]) => !seen.has(ref)).map(([ref]) => ref);
  if (missing.length) problems.push(`these refs are missing from your answer: ${missing.join(", ")}`);
  for (const drop of answer.dropped) {
    if (refs.get(drop.ref)?.type === "group") problems.push(`${drop.ref} is a standing bar; leave it unused instead of dropping it`);
  }

  // Dropping real food is the failure that matters most, so a meal that
  // sheds a large share of its named items is rejected.
  const named = featured.filter(([, r]) => r.item.label);
  const droppedNamed = answer.dropped.filter((d) => refs.get(d.ref)?.item?.label).length;
  if (named.length >= 8 && droppedNamed > named.length * 0.3) {
    problems.push(`${droppedNamed} of ${named.length} items were dropped; only non-food lines should be dropped`);
  }
  return problems;
}

// Converts a checked answer into what the site stores, repairing any name
// that drifted away from the item it labels.
function settle(answer, refs) {
  let repairs = 0;
  const used = new Set();
  const stations = [];
  for (const station of answer.stations) {
    const dishes = [];
    for (const dish of station.dishes) {
      const parts = [];
      // A standing bar folded into a dish often repeats what the day's list
      // already has (lettuce, cheddar), so each food is kept once.
      const have = new Set();
      const fresh = (label) => {
        const key = words(label).sort().join(" ") || label;
        if (have.has(key)) return false;
        have.add(key);
        return true;
      };
      const ordered = [...dish.parts].sort((x, y) => (refs.get(x.ref).type === "group") - (refs.get(y.ref).type === "group"));
      for (const part of ordered) {
        const target = refs.get(part.ref);
        used.add(part.ref);
        if (target.type === "group") {
          for (const item of target.items) if (fresh(item.label)) parts.push({ id: item.id, name: null });
          continue;
        }
        fresh(target.item.label);
        const { item } = target;
        let name = part.name.trim();
        if (!name || !sameFood(name, item.label, item.description)) {
          name = tidy(item.label);
          repairs++;
        }
        parts.push({ id: item.id, name });
      }
      let name = dish.name.trim();
      if (dish.parts.length === 1 && refs.get(dish.parts[0].ref).type === "item") {
        const { item } = refs.get(dish.parts[0].ref);
        if (!sameFood(name, item.label, item.description)) {
          name = tidy(item.label);
          repairs++;
        }
      }
      if (name && parts.length) {
        dishes.push({ name, kind: dish.kind, headline: dish.headline, note: dish.note?.trim() || null, parts });
      }
    }
    if (dishes.length) stations.push({ name: tidy(station.name), dishes });
  }
  return { summary: answer.summary.trim(), stations, staples: staplesFrom(refs, used), repairs };
}

function staplesFrom(refs, used) {
  const staples = [];
  for (const [ref, target] of refs) {
    if (target.type !== "group" || used.has(ref)) continue;
    staples.push({ station: tidy(target.station), group: tidy(target.group), ids: target.items.map((i) => i.id) });
  }
  return staples;
}

// ------------------------------------------------------------- rule-based

const BAR = /omelet|salad bar|topping|deli|grill topping|cold bar/i;
const MAINS = /comfort|global|action|special|plant|asian|kosher|stir|oasis|classic|pizza|grill|entr/i;

// The no-Claude version. It can't rename or regroup with any judgment, but it
// hides blanks and folds the obvious ingredient bars into one line.
export function organizeByRules(meal) {
  const { refs } = layOut(meal);
  const stations = [];
  for (const station of meal.stations) {
    const items = station.items.filter((i) => i.featured && i.label && !/^certified by/i.test(i.options[0] || ""));
    if (!items.length) continue;
    const dishes = [];
    // A long list at one station is nearly always a bar and its fixings.
    if ((BAR.test(station.name) && items.length > 5) || items.length > 8) {
      dishes.push({
        name: tidy(station.name),
        kind: "build_your_own",
        headline: false,
        note: null,
        parts: items.map((i) => ({ id: i.id, name: tidy(i.label) })),
      });
    } else {
      for (const item of items) {
        dishes.push({
          name: tidy(item.label),
          kind: "other",
          headline: MAINS.test(station.name) && !BAR.test(station.name),
          note: null,
          parts: [{ id: item.id, name: tidy(item.label) }],
        });
      }
    }
    stations.push({ name: tidy(station.name.replace(/^@/, "")), dishes });
  }
  return { summary: "", stations, staples: staplesFrom(refs, new Set()), repairs: 0, by: "rules" };
}

// ------------------------------------------------------------------ Claude

let client;
function api() {
  client ??= new Anthropic({ maxRetries: 4 });
  return client;
}

export const usage = { calls: 0, input: 0, output: 0, retries: 0, fallbacks: 0 };

export function costSoFar() {
  const [inPrice, outPrice] = PRICES[MODEL] || [0, 0];
  return (usage.input * inPrice + usage.output * outPrice) / 1e6;
}

// Fallbacks let another Claude model finish the request if this one's safety
// filter declines it. Not every account has them, so a rejected request is
// sent once more without.
let fallbacksOn = process.env.ORGANIZER_FALLBACKS !== "off";

// Set when the API turns the key away (bad key, no credit, spending limit).
// Every later meal would fail the same way, so the rest of the run goes
// straight to rules instead of making a hundred doomed requests.
export let unavailable = null;

async function ask(system, messages, schema) {
  const base = {
    model: MODEL,
    max_tokens: 16000,
    system,
    messages,
    output_config: { effort: EFFORT, format: betaZodOutputFormat(schema) },
  };
  let response;
  if (fallbacksOn) {
    try {
      response = await api().beta.messages.parse({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } catch (err) {
      if (!(err instanceof Anthropic.BadRequestError)) throw err;
      fallbacksOn = false;
    }
  }
  try {
    response ??= await api().beta.messages.parse(base);
  } catch (err) {
    const rejected =
      err instanceof Anthropic.BadRequestError ||
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError;
    if (rejected && !unavailable) {
      unavailable = err.error?.error?.message || err.message;
      console.warn(`  ! Claude turned the request away: ${unavailable}`);
    }
    throw err;
  }
  usage.calls++;
  usage.input += response.usage.input_tokens;
  usage.output += response.usage.output_tokens;
  if (response.stop_reason === "refusal") throw new Error("declined by the model");
  if (response.stop_reason === "max_tokens") throw new Error("answer was cut off");
  if (!response.parsed_output) throw new Error("answer didn't match the expected shape");
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return { parsed: response.parsed_output, text };
}

export const request = (hallName, meal, listing) => `${hallName} — ${meal.label}\n\n${listing}`;

// Checks an answer and, if it holds up, turns it into what the site stores.
export function accept(answer, meal, by) {
  const { refs } = layOut(meal);
  const problems = problemsWith(answer, refs);
  return problems.length ? { problems } : { result: { ...settle(answer, refs), by } };
}

export async function organizeWithClaude(hallName, meal) {
  const { refs, text } = layOut(meal);
  const messages = [{ role: "user", content: request(hallName, meal, text) }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const { parsed, text: raw } = await ask(SYSTEM, messages, Organized);
    const problems = problemsWith(parsed, refs);
    if (problems.length === 0) return { ...settle(parsed, refs), by: MODEL };
    if (attempt === 0) {
      usage.retries++;
      messages.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content: `That answer can't be used yet:\n- ${problems.join("\n- ")}\n\nPlease send the whole answer again with those fixed.`,
        },
      );
    } else {
      throw new Error("failed checks twice: " + problems.join("; "));
    }
  }
}

// One meal, Claude first, rules if Claude is unavailable or fails its checks.
export async function organizeMeal(hallName, meal, { useClaude }) {
  if (useClaude && !unavailable) {
    try {
      return await organizeWithClaude(hallName, meal);
    } catch (err) {
      usage.fallbacks++;
      if (!unavailable) console.warn(`  ! ${hallName} ${meal.label}: ${err.message}; using rules`);
    }
  }
  return organizeByRules(meal);
}

// Cleans the names of standing-bar items. Returns label -> name for the ones
// that passed the same-food check; the caller tidies the rest by rule.
export async function cleanNames(labels) {
  const out = {};
  for (let start = 0; start < labels.length && !unavailable; start += 250) {
    const chunk = labels.slice(start, start + 250);
    const listing = chunk.map((label, i) => `${i + 1}. ${label}`).join("\n");
    try {
      const { parsed } = await ask(NAMES_SYSTEM, [{ role: "user", content: listing }], Names);
      for (const { n, name } of parsed.names) {
        const label = chunk[n - 1];
        if (label && name.trim() && sameFood(name, label)) out[label] = name.trim();
      }
    } catch (err) {
      usage.fallbacks++;
      if (!unavailable) console.warn(`  ! standing-bar names: ${err.message}; using rules for ${chunk.length}`);
    }
  }
  return out;
}
