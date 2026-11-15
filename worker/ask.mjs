// The shared question box's server. It holds the Claude key so the page
// doesn't have to, and it is the only thing that can spend it.
//
// What stops someone running up the bill:
//   - A daily budget in dollars, shared by everyone. Each answer's real cost
//     (from the token counts Claude reports) is added to the day's total, and
//     once the total reaches the budget every request is refused until
//     midnight in Cambridge.
//   - A daily cap per visitor and a short wait between a visitor's questions.
//   - The server writes the prompt. A caller can only send short questions;
//     it can't choose the model, the instructions, or the answer length, so
//     the key can't be used as a general-purpose Claude.
//   - Only the site's own address may call it from a browser.
// Set a monthly spending limit on the key itself as well. That is the
// backstop if everything here is wrong.
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { RULES, buildContext } from "../site/js/context.js";

const MODEL = "claude-haiku-5-5";
const TIMEZONE = "America/New_York";
// Dollars per million tokens for the model above. Prompts over 100K tokens
// are billed at five times these rates; the menus are well under that.
const PRICE = { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 };
// Held against the budget while an answer is being written, so a burst of
// simultaneous questions can't all slip under the line together.
const HOLD = 0.01;
const MAX_TURNS = 8;
const MAX_ANSWER_CHARS = 4000;

const number = (value, fallback) => (Number.isFinite(Number(value)) && value !== "" && value != null ? Number(value) : fallback);

function limitsFrom(env) {
  return {
    budget: number(env.DAILY_BUDGET_USD, 1),
    perVisitor: number(env.QUESTIONS_PER_VISITOR, 25),
    waitSeconds: number(env.SECONDS_BETWEEN_QUESTIONS, 3),
    questionChars: number(env.MAX_QUESTION_CHARS, 400),
  };
}

const campusDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());

function costOf(usage) {
  const read = usage.cache_read_input_tokens || 0;
  const written = usage.cache_creation_input_tokens || 0;
  const plain = usage.input_tokens || 0;
  const long = plain + read + written > 100_000 ? 5 : 1;
  return (long * (plain * PRICE.input + written * PRICE.cacheWrite + read * PRICE.cacheRead + (usage.output_tokens || 0) * PRICE.output)) / 1e6;
}

// Keeps the day's running total and each visitor's count. A Durable Object
// handles one call at a time, so two requests can't both read the same
// "there's budget left" and both spend it.
export class Meter extends DurableObject {
  async #today() {
    const day = campusDay();
    const saved = await this.ctx.storage.get("day");
    return saved && saved.day === day ? saved : { day, spent: 0, answered: 0, visitors: {} };
  }

  async admit(visitor, limits) {
    const record = await this.#today();
    const seen = record.visitors[visitor] || { count: 0, last: 0 };
    const now = Date.now();
    if (record.spent + HOLD > limits.budget) return { ok: false, why: "budget" };
    if (seen.count >= limits.perVisitor) return { ok: false, why: "visitor" };
    if (now - seen.last < limits.waitSeconds * 1000) return { ok: false, why: "wait" };
    record.visitors[visitor] = { count: seen.count + 1, last: now };
    record.spent += HOLD;
    await this.ctx.storage.put("day", record);
    return { ok: true, day: record.day };
  }

  // Swaps the hold for what the answer really cost.
  async settle(day, cost) {
    const record = await this.#today();
    if (record.day !== day) return;
    record.spent = Math.max(0, record.spent - HOLD + cost);
    record.answered += 1;
    await this.ctx.storage.put("day", record);
  }

  async summary() {
    const record = await this.#today();
    return { day: record.day, spent: Number(record.spent.toFixed(4)), answered: record.answered, visitors: Object.keys(record.visitors).length };
  }
}

// The week's menus as prompt text, read from the published site and kept for
// a few minutes. Everyone gets the same text, so Claude's prompt cache is
// shared between visitors and most questions cost a fraction of a cent.
let menus = { text: "", at: 0 };
async function menuText(env) {
  if (menus.text && Date.now() - menus.at < 15 * 60e3) return menus.text;
  try {
    const get = async (path) => {
      const res = await fetch(`${env.SITE}/data/${path}`, { cf: { cacheTtl: 300 } });
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      return res.json();
    };
    const index = await get("index.json");
    const days = {};
    await Promise.all(index.dates.map(async (date) => (days[date] = await get(`days/${date}.json`).catch(() => null))));
    menus = { text: `${RULES}\n\n${buildContext(index, days)}`, at: Date.now() };
  } catch (err) {
    if (!menus.text) throw err;
  }
  return menus.text;
}

function stamp() {
  const now = new Date().toLocaleString("en-US", { timeZone: TIMEZONE, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `[It is ${now} in Cambridge.]`;
}

// Accepts only a short back-and-forth of plain text ending in a question.
function conversation(body, limits) {
  const turns = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : [];
  const messages = [];
  for (const turn of turns) {
    if (!turn || typeof turn.text !== "string" || !turn.text.trim()) return null;
    if (turn.role === "user") {
      if (turn.text.length > limits.questionChars) return null;
      messages.push({ role: "user", content: turn.text.trim() });
    } else if (turn.role === "assistant") {
      messages.push({ role: "assistant", content: turn.text.slice(0, MAX_ANSWER_CHARS) });
    } else return null;
  }
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages.at(-1).role !== "user") return null;
  messages.at(-1).content = `${stamp()}\n${messages.at(-1).content}`;
  return messages;
}

async function visitorId(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${campusDay()}|${ip}`));
  return [...new Uint8Array(bytes).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const REFUSALS = {
  budget: "Today's shared questions are used up. They come back at midnight.",
  visitor: "You've reached today's limit for questions on this device's connection. It resets at midnight.",
  wait: "One at a time. Give it a few seconds and ask again.",
};

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = allowed.includes(origin)
      ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400", Vary: "Origin" }
      : {};
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });
    const url = new URL(request.url);
    const meter = env.METER.get(env.METER.idFromName("meter"));

    if (request.method === "OPTIONS") return new Response(null, { status: allowed.includes(origin) ? 204 : 403, headers: cors });
    // How today is going: dollars spent, questions answered. No questions or
    // addresses are kept, so there's nothing private here.
    if (request.method === "GET" && url.pathname === "/today") {
      const limits = limitsFrom(env);
      return json(200, { ...(await meter.summary()), budget: limits.budget });
    }
    if (request.method !== "POST" || url.pathname !== "/ask") return json(404, { error: "not-found" });
    if (!allowed.includes(origin)) return json(403, { error: "origin", message: "This service only answers the MIT Dining page." });
    if (!env.ANTHROPIC_API_KEY) return json(503, { error: "setup", message: "The question box isn't set up yet." });

    const limits = limitsFrom(env);
    const body = await request.json().catch(() => null);
    const messages = conversation(body, limits);
    if (!messages) return json(400, { error: "question", message: `Questions need to be plain text, ${limits.questionChars} characters at most.` });

    const pass = await meter.admit(await visitorId(request), limits);
    if (!pass.ok) return json(429, { error: pass.why, message: REFUSALS[pass.why] });

    let system;
    try {
      system = await menuText(env);
    } catch {
      ctx.waitUntil(meter.settle(pass.day, 0));
      return json(502, { error: "menus", message: "Couldn't load the menus just now. Try again in a minute." });
    }

    // The answer goes back as lines of JSON: {"text": "..."} as it is written,
    // then nothing more, or {"error": "..."} if it had to stop.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (line) => writer.write(encoder.encode(JSON.stringify(line) + "\n"));

    const answer = async () => {
      let cost = HOLD; // if Claude's count never arrives, the hold stands
      try {
        const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1 });
        const stream = client.messages.stream({
          model: MODEL,
          max_tokens: 1500,
          output_config: { effort: "low" },
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages,
        });
        stream.on("text", (delta) => send({ text: delta }));
        const message = await stream.finalMessage();
        cost = costOf(message.usage);
        if (message.stop_reason === "refusal") await send({ error: "Claude declined to answer that one." });
      } catch (err) {
        if (err instanceof Anthropic.APIError && err.status >= 400 && err.status < 500) cost = 0; // turned away before any work was done
        const busy = err instanceof Anthropic.RateLimitError || (err instanceof Anthropic.APIError && err.status >= 500);
        await send({ error: busy ? "Claude is busy right now. Try again in a minute." : "Something went wrong getting an answer." }).catch(() => {});
        console.error("ask failed:", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
      } finally {
        await meter.settle(pass.day, cost);
        await writer.close().catch(() => {});
      }
    };
    ctx.waitUntil(answer());
    return new Response(readable, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", ...cors } });
  },
};
