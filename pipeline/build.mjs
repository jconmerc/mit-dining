// Builds the site's menu data: fetch every hall for the coming days, organise
// each meal, write one JSON file per day under site/data/.
//
//   node pipeline/build.mjs            the next 8 days
//   DAYS=2 node pipeline/build.mjs     fewer days
//   NO_CLAUDE=1 node pipeline/build.mjs   rules only, no API calls
//
// Organised meals are cached by content, so a breakfast that is the same
// every weekday is sent to Claude once, and a re-run costs nothing unless a
// menu changed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HALLS, SOURCE, campusDate, hallUrl } from "./halls.mjs";
import { fetchHallDay } from "./fetch.mjs";
import { MODEL, cleanNames, costSoFar, mealKey, organizeMeal, tidy, unavailable, usage } from "./organize.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "site", "data");
const CACHE = path.join(here, "cache");
const DAYS = Number(process.env.DAYS || 8);
const useClaude = !process.env.NO_CLAUDE && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

// Runs `work` over `list`, a few at a time.
async function pool(list, size, work) {
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        results[i] = await work(list[i], i);
      }
    }),
  );
  return results;
}

const mealSlug = (label) => label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");

async function main() {
  const dates = Array.from({ length: DAYS }, (_, i) => campusDate(i));
  console.log(`Menus for ${dates[0]} to ${dates.at(-1)}, organised by ${useClaude ? MODEL : "rules (no API key)"}`);

  // 1. Fetch.
  const jobs = dates.flatMap((date) => HALLS.map((hall) => ({ date, hall })));
  const fetched = await pool(jobs, 4, async ({ date, hall }) => {
    try {
      return await fetchHallDay(hall, date);
    } catch (err) {
      console.warn(`  ! ${err.message}`);
      return { hall: hall.id, date, url: hallUrl(hall, date), failed: err.message };
    }
  });
  const good = fetched.filter((d) => !d.failed);
  const featuredCount = good.reduce(
    (n, d) => n + d.meals.reduce((m, meal) => m + meal.stations.reduce((s, st) => s + st.items.filter((i) => i.featured).length, 0), 0),
    0,
  );
  console.log(`Fetched ${good.length}/${fetched.length} hall-days, ${featuredCount} menu items`);
  // If the vendor's pages changed shape, everything comes back empty. Keep
  // the data already published instead of replacing it with nothing.
  if (featuredCount < 50) {
    console.error("Almost nothing was read. Leaving the published data as it is.");
    process.exit(1);
  }

  // 2. Organise each distinct meal once.
  const index = readJson(path.join(CACHE, "index.json"), {});
  const today = dates[0];
  const wanted = new Map();
  for (const day of good) {
    const hall = HALLS.find((h) => h.id === day.hall);
    for (const meal of day.meals) {
      const key = mealKey(hall.id, meal);
      meal.key = key;
      if (!wanted.has(key)) wanted.set(key, { hall, meal });
    }
  }
  const organized = new Map();
  const todo = [];
  for (const [key, job] of wanted) {
    const hit = readJson(path.join(CACHE, "meals", key + ".json"), null);
    // A meal that fell back to rules is tried again once Claude is available.
    const settled = hit && hit.by !== "rules" && hit.by !== "preview";
    if (settled || (hit && hit.by === "preview" && !useClaude)) organized.set(key, hit);
    else todo.push({ key, hit, ...job });
  }
  console.log(`${wanted.size} distinct meals, ${todo.length} to organise`);
  let done = 0;
  await pool(todo, 4, async ({ key, hit, hall, meal }) => {
    const result = await organizeMeal(hall.name, meal, { useClaude });
    // Don't let a failed retry replace a better copy from an earlier run.
    if (result.by === "rules" && hit && hit.by !== "rules") {
      organized.set(key, hit);
    } else {
      organized.set(key, result);
      writeJson(path.join(CACHE, "meals", key + ".json"), result);
    }
    done++;
    if (done % 10 === 0 || done === todo.length) console.log(`  ${done}/${todo.length}  ($${costSoFar().toFixed(2)} so far)`);
  });
  for (const key of wanted.keys()) index[key] = today;

  // 3. Names for the standing-bar items.
  const names = readJson(path.join(CACHE, "names.json"), {});
  const labels = new Set();
  for (const day of good) for (const meal of day.meals) for (const st of meal.stations) for (const i of st.items) if (!i.featured && i.label) labels.add(i.label);
  const unnamed = [...labels].filter((l) => !(l in names)).sort();
  if (unnamed.length && useClaude) {
    console.log(`Cleaning ${unnamed.length} standing-bar names`);
    Object.assign(names, await cleanNames(unnamed));
    writeJson(path.join(CACHE, "names.json"), names);
  }

  // 4. Write a file per day.
  const stats = { meals: 0, byClaude: 0, byRules: 0, dishes: 0, repairs: 0 };
  for (const date of dates) {
    const previous = readJson(path.join(DATA, "days", date + ".json"), { halls: {} });
    const halls = {};
    for (const hall of HALLS) {
      const day = fetched.find((d) => d.date === date && d.hall === hall.id);
      if (day.failed) {
        // Keep yesterday's copy of this hall-day if there is one.
        halls[hall.id] = previous.halls[hall.id] ? { ...previous.halls[hall.id], stale: true } : { url: day.url, error: true, meals: [], items: {} };
        continue;
      }
      const items = {};
      const meals = day.meals.map((meal) => {
        const org = organized.get(meal.key);
        for (const st of meal.stations) {
          for (const i of st.items) {
            items[i.id] ??= { n: i.featured ? tidy(i.label) : names[i.label] || tidy(i.label), t: i.tags };
            if (i.description) items[i.id].d = i.description;
          }
        }
        stats.meals++;
        stats[org.by === "rules" ? "byRules" : "byClaude"]++;
        stats.dishes += org.stations.reduce((n, s) => n + s.dishes.length, 0);
        stats.repairs += org.repairs || 0;
        return {
          key: mealSlug(meal.label),
          label: meal.label,
          start: meal.start,
          end: meal.end,
          by: org.by === "rules" ? "rules" : "claude",
          summary: org.summary,
          stations: org.stations,
          staples: org.staples,
        };
      });
      // Only keep the items some meal actually points at.
      const used = new Set();
      for (const m of meals) {
        for (const s of m.stations) for (const d of s.dishes) for (const p of d.parts) used.add(p.id);
        for (const s of m.staples) for (const id of s.ids) used.add(id);
      }
      for (const id of Object.keys(items)) if (!used.has(id)) delete items[id];
      halls[hall.id] = { url: day.url, meals, items };
      if (day.closed) halls[hall.id].closed = day.closed;
    }
    writeJson(path.join(DATA, "days", date + ".json"), { date, halls });
  }

  // 5. Index, and tidy up old files.
  for (const file of fs.readdirSync(path.join(DATA, "days"))) {
    if (!dates.includes(file.replace(".json", ""))) fs.rmSync(path.join(DATA, "days", file));
  }
  const cutoff = campusDate(-30);
  for (const [key, last] of Object.entries(index)) {
    if (last < cutoff) {
      delete index[key];
      fs.rmSync(path.join(CACHE, "meals", key + ".json"), { force: true });
    }
  }
  writeJson(path.join(CACHE, "index.json"), index);
  writeJson(path.join(DATA, "index.json"), {
    generated: new Date().toISOString(),
    source: SOURCE,
    dates,
    halls: HALLS.map((h) => ({ id: h.id, name: h.name })),
    organizer: useClaude && !unavailable ? MODEL : "rules",
    stats: { ...stats, failedPages: fetched.length - good.length },
  });

  console.log(
    `Wrote ${dates.length} days: ${stats.meals} meals (${stats.byClaude} by Claude, ${stats.byRules} by rules), ${stats.dishes} dishes, ${stats.repairs} names repaired`,
  );
  if (usage.calls) {
    console.log(
      `Claude: ${usage.calls} calls, ${usage.input} in / ${usage.output} out tokens, about $${costSoFar().toFixed(2)}; ${usage.retries} re-asked, ${usage.fallbacks} fell back to rules`,
    );
  }

  // On GitHub, say so on the run's page when the menus went out without
  // Claude's cleanup, so a dead key doesn't go unnoticed.
  if (process.env.GITHUB_ACTIONS) {
    const unread = fetched.length - good.length;
    if (!useClaude) console.log("::warning title=No Claude key::Add the ANTHROPIC_API_KEY secret to get the cleaned-up menus. These were tidied by rules only.");
    else if (unavailable) console.log(`::warning title=Claude key refused::${unavailable} Menus were tidied by rules only.`);
    else if (stats.byRules) console.log(`::warning title=Some meals fell back to rules::${stats.byRules} of ${stats.meals} meals failed the checks and were tidied by rules.`);
    if (unread) console.log(`::warning title=Pages not read::${unread} hall pages could not be read; the last saved copy was kept.`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const spent = usage.calls ? `Claude calls this run: ${usage.calls}, about $${costSoFar().toFixed(2)}.` : "No Claude calls were needed this run.";
      const summary = `**${stats.meals} meals** for ${dates[0]} to ${dates.at(-1)}: ${stats.byClaude} tidied by Claude, ${stats.byRules} by rules.\n\n${spent}\n`;
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
