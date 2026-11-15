// The page: pick a day, a hall and a meal, and read the menu. With no hall
// picked it shows every hall side by side for one meal, which is the usual
// question ("where's dinner good tonight?").
import { AskError, ask, forgetKey, hasKey, resetChat, saveKey } from "./ask.js";

const TIMEZONE = "America/New_York";
const $ = (id) => document.getElementById(id);
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const DIETS = [["", "Everything"], ["vegetarian", "Vegetarian"], ["vegan", "Vegan"], ["halal", "Halal"], ["kosher", "Kosher"]];
const AVOID = [["gluten", "Gluten"], ["milk", "Milk"], ["egg", "Egg"], ["soy", "Soy"], ["nuts", "Nuts"], ["fish", "Fish"], ["sesame", "Sesame"]];
const AVOID_TAGS = { nuts: ["peanut", "tree-nut"], fish: ["fish", "shellfish"] };
const ALLERGEN_NAMES = { gluten: "wheat/gluten", milk: "milk", egg: "egg", soy: "soy", peanut: "peanut", "tree-nut": "tree nuts", fish: "fish", shellfish: "shellfish", sesame: "sesame" };
const TRIES = ["Where's the best dinner tonight?", "What's vegan for lunch tomorrow?", "Which hall has the best breakfast this week?"];

let index = null;
const days = {};
const state = { date: "", hall: "", meal: "", view: "day", diet: "", avoid: new Set() };

// ------------------------------------------------------------------- time

function campusNow() {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date())) {
    parts[p.type] = p.value;
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function span(meal) {
  const start = minutes(meal.start);
  let end = minutes(meal.end);
  if (end <= start) end += 1440; // runs past midnight
  return [start, end];
}
function clock(hhmm, withSuffix = true) {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  return `${h % 12 || 12}${m === "00" ? "" : ":" + m}${withSuffix ? (h >= 12 ? " pm" : " am") : ""}`;
}
function hours(meal) {
  const sameHalf = Number(meal.start.slice(0, 2)) >= 12 === Number(meal.end.slice(0, 2)) >= 12;
  return `${clock(meal.start, !sameHalf)}–${clock(meal.end)}`;
}
function dayLabel(date, style) {
  const today = campusNow().date;
  const d = new Date(date + "T12:00:00Z");
  const fmt = (options) => d.toLocaleDateString("en-US", { timeZone: "UTC", ...options });
  const gap = Math.round((d - new Date(today + "T12:00:00Z")) / 864e5);
  const near = gap === 0 ? "Today" : gap === 1 ? "Tomorrow" : null;
  if (style === "short") return near || fmt({ weekday: "short" });
  if (style === "date") return fmt({ month: "short", day: "numeric" });
  return (near ? near + ", " : "") + fmt({ weekday: near ? "short" : "long", month: "short", day: "numeric" });
}

// What a hall is doing right now: open (and until when), or when it next opens.
function status(hall) {
  if (!hall || !hall.meals.length) return { text: "closed" };
  const now = campusNow().minutes;
  for (const meal of hall.meals) {
    const [start, end] = span(meal);
    if (now >= start && now < end) return { open: true, meal: meal.key, text: `open till ${clock(meal.end)}` };
  }
  const next = hall.meals.find((meal) => span(meal)[0] > now);
  return { text: next ? `opens ${clock(next.start)}` : "closed" };
}

// ---------------------------------------------------------------- filters

const filtering = () => Boolean(state.diet) || state.avoid.size > 0;

function partFits(hall, id) {
  const tags = (hall.items[id] || {}).t || [];
  if (state.diet === "vegetarian" && !tags.includes("vegetarian") && !tags.includes("vegan")) return false;
  if (state.diet && state.diet !== "vegetarian" && !tags.includes(state.diet)) return false;
  for (const avoid of state.avoid) {
    if ((AVOID_TAGS[avoid] || [avoid]).some((t) => tags.includes(t))) return false;
  }
  return true;
}
const dishFits = (hall, dish) => !filtering() || dish.parts.some((p) => partFits(hall, p.id));

function dietTag(hall, dish) {
  if (dish.parts.length !== 1) return "";
  const tags = (hall.items[dish.parts[0].id] || {}).t || [];
  const words = [];
  if (tags.includes("vegan")) words.push("vegan");
  else if (tags.includes("vegetarian")) words.push("veg");
  if (tags.includes("halal")) words.push("halal");
  if (tags.includes("kosher")) words.push("kosher");
  return words.length ? `<span class="tg">${words.join(" · ")}</span>` : "";
}

// ------------------------------------------------------------------ views

const hallsToday = () => (days[state.date] || { halls: {} }).halls;

// The meals served anywhere on the chosen day, earliest first.
function mealsOn(date) {
  const seen = new Map();
  for (const hall of Object.values((days[date] || { halls: {} }).halls)) {
    for (const meal of hall.meals) {
      const start = minutes(meal.start);
      if (!seen.has(meal.key) || start < seen.get(meal.key).start) seen.set(meal.key, { key: meal.key, label: meal.label, start });
    }
  }
  return [...seen.values()].sort((a, b) => a.start - b.start);
}

// Keeps the chosen meal when the day changes, or picks the one that matters
// now: the meal being served, else the next one, else dinner.
function settleMeal() {
  const meals = state.hall ? (hallsToday()[state.hall] || { meals: [] }).meals : mealsOn(state.date);
  if (!meals.length) return (state.meal = "");
  if (meals.some((m) => m.key === state.meal)) return;
  const swap = { lunch: "brunch", brunch: "lunch" }[state.meal];
  if (swap && meals.some((m) => m.key === swap)) return (state.meal = swap);
  if (state.date === campusNow().date) {
    const now = campusNow().minutes;
    const all = Object.values(hallsToday()).flatMap((h) => h.meals);
    const live = meals.find((m) => all.some((x) => x.key === m.key && span(x)[1] > now));
    if (live) return (state.meal = live.key);
  }
  state.meal = (meals.find((m) => m.key === "dinner") || meals[meals.length - 1]).key;
}

function headsFor(hall, meal) {
  const all = meal.stations.flatMap((s) => s.dishes.map((d) => ({ dish: d, station: s.name }))).filter((x) => dishFits(hall, x.dish));
  const heads = all.filter((x) => x.dish.headline);
  if (heads.length) return { list: heads, rest: all.length - heads.length };
  // Nothing marked as a main (or none survive the filter): show what does fit.
  const fill = all.filter((x) => !["condiment", "beverage"].includes(x.dish.kind)).slice(0, 8);
  return { list: fill, rest: all.length - fill.length };
}

function sideBySide() {
  const halls = hallsToday();
  const rows = [];
  const without = [];
  for (const { id, name } of index.halls) {
    const hall = halls[id];
    const meal = hall && hall.meals.find((m) => m.key === state.meal);
    if (!meal) {
      without.push(hall && hall.closed && hall.closed !== "Closed" ? `${name} (${hall.closed.toLowerCase()})` : name);
      continue;
    }
    const live = state.date === campusNow().date && status(hall).meal === meal.key;
    const { list, rest } = headsFor(hall, meal);
    const items = list.map((x) => `<li><span class="dn">${esc(x.dish.name)}</span>${dietTag(hall, x.dish)} <span class="st">${esc(x.station)}</span></li>`).join("");
    rows.push(
      `<section class="hall"><header><b>${esc(name)}</b><span class="hrs">${hours(meal)}</span>${live ? '<span class="live">open now</span>' : ""}` +
        `<button class="plain" data-hall="${id}">Full menu</button></header>` +
        (items ? `<ul class="heads">${items}</ul>` : `<p class="also">Nothing here fits that filter.</p>`) +
        (items && rest > 0 ? `<p class="also">and ${rest} more on the full menu${hall.stale ? " (not refreshed today)" : ""}</p>` : "") +
        `</section>`,
    );
  }
  if (without.length) {
    const label = (mealsOn(state.date).find((m) => m.key === state.meal) || { label: "meal" }).label.toLowerCase();
    rows.push(`<section class="hall shut">No ${esc(label)} at ${esc(without.join(", "))}.</section>`);
  }
  return rows.join("") || `<div class="none">No menus posted for this day yet.</div>`;
}

function dishRow(hall, dish) {
  const cls = dish.headline ? "lead" : ["condiment", "beverage"].includes(dish.kind) ? "minor" : "";
  let extra = "";
  let clickable = false;
  if (dish.parts.length > 1) {
    const parts = dish.parts.map((p) => {
      const name = esc(p.name || (hall.items[p.id] || {}).n || "");
      return filtering() && !partFits(hall, p.id) ? `<s>${name}</s>` : name;
    });
    // A long list (the salad bar) starts folded to two lines; a tap opens it.
    extra = parts.length > 14 ? `<button class="parts fold" aria-expanded="false">${parts.join(", ")}</button>` : `<div class="parts">${parts.join(", ")}</div>`;
  } else {
    const item = hall.items[dish.parts[0].id] || { t: [] };
    const has = item.t.filter((t) => ALLERGEN_NAMES[t]).map((t) => ALLERGEN_NAMES[t]);
    const lines = [];
    if (item.d) lines.push(esc(item.d));
    lines.push(has.length ? "Contains " + has.join(", ") : "No allergens flagged");
    extra = `<div class="more" hidden>${lines.join("<br>")}</div>`;
    clickable = true;
  }
  const name = `<span class="dn">${esc(dish.name)}</span>`;
  const note = dish.note ? ` <span class="st">${esc(dish.note)}</span>` : "";
  return `<li class="${cls}">${clickable ? `<button class="dish" aria-expanded="false">${name}</button>` : name}${dietTag(hall, dish)}${note}${extra}</li>`;
}

function oneHall() {
  const hall = hallsToday()[state.hall];
  if (!hall || hall.error) return `<div class="none">Couldn't read this hall's menu. <a href="${esc((hall || {}).url || index.source)}" target="_blank" rel="noopener">See it on MIT Dining</a>.</div>`;
  if (!hall.meals.length) return `<div class="none">${esc(hall.closed && hall.closed !== "Closed" ? hall.closed : "Closed this day")}.</div>`;
  const meal = hall.meals.find((m) => m.key === state.meal);
  if (!meal) return `<div class="none">Not served here this day.</div>`;

  const stations = meal.stations
    .map((s) => ({ name: s.name, dishes: s.dishes.filter((d) => dishFits(hall, d)) }))
    .filter((s) => s.dishes.length)
    .map((s) => `<div class="station"><span>${esc(s.name)}</span><ul class="dishes">${s.dishes.map((d) => dishRow(hall, d)).join("")}</ul></div>`)
    .join("");

  // Standing bars, merged by station, with the filter applied to each item.
  const bars = new Map();
  for (const group of meal.staples) {
    const names = group.ids.filter((id) => !filtering() || partFits(hall, id)).map((id) => esc((hall.items[id] || {}).n || ""));
    if (!names.length) continue;
    const key = group.station.toLowerCase() === group.group.toLowerCase() ? group.station : `${group.station}: ${group.group.toLowerCase()}`;
    bars.set(key, (bars.get(key) || []).concat(names));
  }
  const always = bars.size
    ? `<details class="always"><summary>Always available (${[...bars.values()].reduce((n, list) => n + list.length, 0)})</summary><dl>` +
      [...bars].map(([key, names]) => `<dt>${esc(key)}</dt><dd>${names.join(", ")}</dd>`).join("") +
      `</dl></details>`
    : "";
  const sum = meal.summary && !filtering() ? `<p class="sum">${esc(meal.summary)}</p>` : "";
  return sum + (stations || `<div class="none">Nothing on today's menu fits that filter.</div>`) + always;
}

function wholeWeek() {
  const rows = [];
  for (const date of index.dates) {
    const hall = ((days[date] || { halls: {} }).halls || {})[state.hall];
    if (!hall) continue;
    const meals = hall.meals.map((meal) => {
      const heads = meal.stations.flatMap((s) => s.dishes).filter((d) => d.headline && dishFits(hall, d));
      const text = !filtering() && meal.summary ? meal.summary : heads.slice(0, 5).map((d) => d.name).join(", ");
      return `<p><span>${esc(meal.label)}</span> ${esc(text || (filtering() ? "nothing marked for that filter" : "the usual bars"))}</p>`;
    });
    rows.push(`<div class="wday"><button class="plain" data-date="${date}">${dayLabel(date, "short")} <span class="st">${dayLabel(date, "date")}</span></button><div>${meals.join("") || `<p><span>${esc(hall.closed || "Closed")}</span></p>`}</div></div>`);
  }
  return rows.join("") || `<div class="none">No menus yet.</div>`;
}

// ----------------------------------------------------------------- render

function button(cls, attrs, pressed, html) {
  return `<button class="${cls}" ${attrs} aria-pressed="${pressed}">${html}</button>`;
}

function render() {
  if (!index) return;
  settleMeal();
  const today = campusNow().date;
  const hall = index.halls.find((h) => h.id === state.hall);

  $("days").innerHTML = index.dates.map((d) => button("pick", `data-date="${d}"`, d === state.date, `${dayLabel(d, "short")}<small>${dayLabel(d, "date")}</small>`)).join("");

  const halls = hallsToday();
  $("halls").innerHTML =
    `<li>${button("", 'data-hall=""', !state.hall, "All halls")}</li>` +
    index.halls
      .map(({ id, name }) => {
        const h = halls[id];
        const st = state.date === today ? status(h) : { text: h && h.meals.length ? "" : "closed" };
        return `<li>${button("", `data-hall="${id}"`, id === state.hall, `${esc(name)}<i class="${st.open ? "open" : ""}">${st.text}</i>`)}</li>`;
      })
      .join("");

  $("diet").innerHTML = DIETS.map(([key, label]) => button("chip", `data-diet="${key}"`, key === state.diet, label)).join("");
  $("avoid").innerHTML = AVOID.map(([key, label]) => button("chip", `data-avoid="${key}"`, state.avoid.has(key), label)).join("");

  const week = hall && state.view === "week";
  const meals = hall ? (halls[state.hall] || { meals: [] }).meals : mealsOn(state.date);
  const toggle = hall ? `<span class="side">${button("pick", 'data-view="day"', !week, "Day")}${button("pick", 'data-view="week"', week, "Week")}</span>` : "";
  $("meals").innerHTML = (week ? "" : meals.map((m) => button("pick", `data-meal="${m.key}"`, m.key === state.meal, esc(m.label))).join("")) + toggle;
  $("meals").hidden = !meals.length && !hall;

  const meal = hall && !week ? (halls[state.hall] || { meals: [] }).meals.find((m) => m.key === state.meal) : null;
  $("title").innerHTML = `${esc(hall ? hall.name : "All halls")}<span class="hrs">${week ? "This week" : dayLabel(state.date)}${meal ? " · " + hours(meal) : ""}</span>`;
  $("view").innerHTML = !hall ? sideBySide() : week ? wholeWeek() : oneHall();

  // On a phone the day and hall lists scroll sideways; keep the chosen one in view.
  for (const strip of [$("days"), $("halls")]) {
    const chosen = strip.querySelector('[aria-pressed="true"]');
    if (!chosen || strip.scrollWidth <= strip.clientWidth) continue;
    const box = chosen.getBoundingClientRect();
    const frame = strip.getBoundingClientRect();
    if (box.left < frame.left || box.right > frame.right) strip.scrollLeft += box.left - frame.left - 12;
  }

  const params = new URLSearchParams();
  if (state.date !== today) params.set("d", state.date);
  if (state.hall) params.set("h", state.hall);
  if (state.meal) params.set("m", state.meal);
  if (week) params.set("v", "week");
  if (state.diet) params.set("only", state.diet);
  if (state.avoid.size) params.set("no", [...state.avoid].join(","));
  const hash = params.toString();
  history.replaceState(null, "", hash ? "#" + hash : location.pathname + location.search);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.date = index.dates.includes(params.get("d")) ? params.get("d") : "";
  state.hall = index.halls.some((h) => h.id === params.get("h")) ? params.get("h") : "";
  state.meal = params.get("m") || "";
  state.view = params.get("v") === "week" ? "week" : "day";
  state.diet = DIETS.some(([key]) => key === params.get("only")) ? params.get("only") : "";
  state.avoid = new Set((params.get("no") || "").split(",").filter((key) => AVOID.some(([k]) => k === key)));
  if (!state.date) {
    const today = campusNow().date;
    state.date = index.dates.includes(today) ? today : index.dates.find((d) => d > today) || index.dates[index.dates.length - 1];
  }
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  const d = el.dataset;
  if (el.classList.contains("parts")) {
    el.setAttribute("aria-expanded", String(el.classList.toggle("fold") === false));
    return;
  }
  if (el.classList.contains("dish")) {
    const more = el.parentElement.querySelector(".more");
    more.hidden = !more.hidden;
    el.setAttribute("aria-expanded", String(!more.hidden));
    return;
  }
  if ("date" in d) {
    state.date = d.date;
    state.view = "day";
  } else if ("hall" in d) {
    state.hall = d.hall;
    state.view = "day";
  } else if ("meal" in d) state.meal = d.meal;
  else if ("view" in d) state.view = d.view;
  else if ("diet" in d) state.diet = d.diet;
  else if ("avoid" in d) state.avoid.has(d.avoid) ? state.avoid.delete(d.avoid) : state.avoid.add(d.avoid);
  else return;
  render();
});

// -------------------------------------------------------------------- ask

let waiting = "";

// Answers are plain text with the odd **bold**; anything else is shown as typed.
const format = (text) => esc(text).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");

async function send(question) {
  if (!index) return;
  if (!hasKey()) {
    waiting = question;
    $("keybox").hidden = false;
    $("keyin").focus();
    return;
  }
  $("keybox").hidden = true;
  $("chat").hidden = false;
  $("tries").hidden = true;
  const turn = document.createElement("div");
  turn.className = "turn";
  turn.innerHTML = `<div class="q">${esc(question)}</div><div class="a wait">Reading the menus...</div>`;
  $("turns").append(turn);
  const answer = turn.querySelector(".a");
  $("askgo").disabled = true;
  $("askq").value = "";
  try {
    const text = await ask(question, { index, days }, (soFar) => {
      answer.className = "a";
      answer.innerHTML = format(soFar);
    });
    answer.className = "a";
    answer.innerHTML = format(text || "Claude didn't have anything to say to that.");
  } catch (err) {
    answer.className = "a bad";
    answer.textContent = err instanceof AskError ? err.message : "Something went wrong.";
    if (err.badKey) {
      forgetKey();
      waiting = question;
      $("keybox").hidden = false;
    }
  } finally {
    $("askgo").disabled = false;
  }
}

$("askform").addEventListener("submit", (event) => {
  event.preventDefault();
  const question = $("askq").value.trim();
  if (question && !$("askgo").disabled) send(question);
});
$("keyform").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = $("keyin").value.trim();
  if (!key) return;
  saveKey(key);
  $("keyin").value = "";
  $("keybox").hidden = true;
  if (waiting) send(waiting);
  waiting = "";
});
$("tries").innerHTML = TRIES.map((q) => `<button class="chip" type="button">${esc(q)}</button>`).join("");
$("tries").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (chip) send(chip.textContent);
});
$("clear").addEventListener("click", () => {
  resetChat();
  $("turns").innerHTML = "";
  $("chat").hidden = true;
  $("tries").hidden = false;
});
$("forget").addEventListener("click", () => {
  forgetKey();
  $("forget").textContent = "Key forgotten";
  setTimeout(() => ($("forget").textContent = "Forget my key"), 2000);
});

// ------------------------------------------------------------------- load

async function getJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(path + " " + res.status);
  return res.json();
}

async function load() {
  try {
    index = await getJson("data/index.json");
  } catch {
    $("view").innerHTML = `<div class="none">Couldn't load the menus. <a href="https://mit.cafebonappetit.com/" target="_blank" rel="noopener">MIT Dining's own site</a> has them.</div>`;
    return;
  }
  readHash();
  // The chosen day first, so the page fills in quickly; the rest follow.
  days[state.date] = await getJson(`data/days/${state.date}.json`).catch(() => null);
  render();
  await Promise.all(
    index.dates.filter((d) => d !== state.date).map(async (d) => {
      days[d] = await getJson(`data/days/${d}.json`).catch(() => null);
    }),
  );
  render();

  const made = new Date(index.generated);
  const when = made.toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "short", hour: "numeric", minute: "2-digit" }).replace(/ ?([AP])M/, (_, half) => " " + half.toLowerCase() + "m");
  const old = Date.now() - made > 36 * 3600e3;
  $("fresh").textContent = `Updated ${when}`;
  if (old) $("foot").textContent = `These menus were last refreshed ${when} and may be out of date.`;
}

window.addEventListener("hashchange", () => {
  if (index) {
    readHash();
    render();
  }
});
// Keeps "open now" honest on a page left open.
setInterval(() => {
  const reading = document.querySelector(".more:not([hidden]), details[open]");
  if (index && !reading) render();
}, 5 * 60e3);
load();
