// The question box. Questions go to the site's own ask server, which holds
// the Claude key and enforces a shared daily budget. A visitor who pastes
// their own key talks to Claude directly instead and doesn't touch that
// budget; their key stays in this browser.
import { ASK_URL } from "./config.js";
import { RULES, buildContext } from "./context.js";

export const MODEL = "claude-haiku-5-5";
const STORE = "dining-claude-key";
const TIMEZONE = "America/New_York";

let turns = [];
let menus = null;
// Set when the shared budget (or this visitor's share of it) has run out.
let sharedSpent = false;

function read() {
  try {
    return localStorage.getItem(STORE) || "";
  } catch {
    return "";
  }
}

export const hasKey = () => Boolean(read());
export const canAsk = () => hasKey() || (Boolean(ASK_URL) && !sharedSpent);
export function saveKey(key) {
  try {
    localStorage.setItem(STORE, key.trim());
  } catch {}
}
export function forgetKey() {
  try {
    localStorage.removeItem(STORE);
  } catch {}
}
export function resetChat() {
  turns = [];
}

// Swapped out in tests so the page can be exercised without a real key.
export const hooks = {
  client: async (apiKey) => {
    const { default: Anthropic } = await import("./anthropic.js");
    return { Anthropic, client: new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) };
  },
};

export class AskError extends Error {
  constructor(message, { badKey = false, needKey = false } = {}) {
    super(message);
    this.badKey = badKey; // the saved key was refused
    this.needKey = needKey; // the shared budget is out; a key of your own still works
  }
}

function stamp() {
  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `[It is ${now} in Cambridge.]`;
}

// Through the ask server. The answer arrives as lines of JSON.
async function viaServer(onText) {
  let res;
  try {
    res = await fetch(ASK_URL + "/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: turns.map(({ role, text }) => ({ role, text })) }),
    });
  } catch {
    throw new AskError("Couldn't reach the question service. Check your connection and try again.");
  }
  if (!res.ok) {
    const problem = await res.json().catch(() => ({}));
    if (problem.error === "budget" || problem.error === "visitor") {
      sharedSpent = true;
      throw new AskError(`${problem.message} To keep asking now, you can use a Claude key of your own.`, { needKey: true });
    }
    throw new AskError(problem.message || "The question service had a problem. Try again in a minute.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.error) throw new AskError(event.error);
      if (event.text) onText((text += event.text));
    }
    if (done) break;
  }
  if (!text) throw new AskError("No answer came back. Try again.");
  return text;
}

// Straight to Claude with the visitor's own key.
async function viaOwnKey(data, onText) {
  // The menu text goes first and never changes within a visit, so Claude's
  // prompt cache makes follow-up questions cheaper and quicker.
  menus ??= `${RULES}\n\n${buildContext(data.index, data.days)}`;
  const { Anthropic, client } = await hooks.client(read());
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: menus, cache_control: { type: "ephemeral" } }],
      messages: turns.map((turn) => ({ role: turn.role, content: turn.role === "user" ? `${turn.at}\n${turn.text}` : turn.text })),
    });
    let text = "";
    stream.on("text", (delta) => onText((text += delta)));
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new AskError("Claude declined to answer that one.");
    return text;
  } catch (err) {
    if (err instanceof AskError) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new AskError("Anthropic didn't accept that key. Paste it again, or make a new one.", { badKey: true });
    }
    if (err instanceof Anthropic.RateLimitError) throw new AskError("Claude is rate-limiting this key right now. Give it a minute.");
    if (err instanceof Anthropic.APIConnectionError) throw new AskError("Couldn't reach Claude. Check your connection and try again.");
    if (err instanceof Anthropic.APIError) throw new AskError(err.error?.error?.message || `Claude returned an error (${err.status}).`);
    throw new AskError("Something went wrong asking Claude.");
  }
}

// Sends one question and calls `onText` with the answer so far as it arrives.
export async function ask(question, data, onText) {
  turns.push({ role: "user", text: question, at: stamp() });
  try {
    const text = hasKey() ? await viaOwnKey(data, onText) : await viaServer(onText);
    turns.push({ role: "assistant", text });
    // Keep the conversation short: the last few exchanges are plenty.
    if (turns.length > 8) turns = turns.slice(-8);
    return text;
  } catch (err) {
    turns.pop();
    throw err instanceof AskError ? err : new AskError("Something went wrong.");
  }
}
