// The question box. It talks to Claude straight from the browser with the
// visitor's own API key, which lives in this browser's storage and nowhere
// else. The menus are already tidy, so a small, fast model is enough.
import Anthropic from "./anthropic.js";
import { RULES, buildContext } from "./context.js";

export const MODEL = "claude-haiku-5-5";
const STORE = "dining-claude-key";
const TIMEZONE = "America/New_York";

let history = [];
let menus = null;

function read() {
  try {
    return localStorage.getItem(STORE) || "";
  } catch {
    return "";
  }
}

export const hasKey = () => Boolean(read());
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
  history = [];
}

// Swapped out in tests so the page can be exercised without a real key.
export const hooks = {
  client: (apiKey) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
};

export class AskError extends Error {
  constructor(message, { badKey = false } = {}) {
    super(message);
    this.badKey = badKey;
  }
}

function explain(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AskError("Anthropic didn't accept that key. Paste it again, or make a new one.", { badKey: true });
  }
  if (err instanceof Anthropic.RateLimitError) return new AskError("Claude is rate-limiting this key right now. Give it a minute.");
  if (err instanceof Anthropic.APIConnectionError) return new AskError("Couldn't reach Claude. Check your connection and try again.");
  if (err instanceof Anthropic.APIError) return new AskError(err.error?.error?.message || `Claude returned an error (${err.status}).`);
  return new AskError("Something went wrong asking Claude.");
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

// Sends one question and calls `onText` with the answer so far as it arrives.
export async function ask(question, data, onText) {
  // The menu text goes first and never changes within a visit, so Claude's
  // prompt cache makes follow-up questions cheaper and quicker.
  menus ??= `${RULES}\n\n${buildContext(data.index, data.days)}`;
  history.push({ role: "user", content: `${stamp()}\n${question}` });
  try {
    const stream = hooks.client(read()).messages.stream({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: [{ type: "text", text: menus, cache_control: { type: "ephemeral" } }],
      messages: history,
    });
    let text = "";
    stream.on("text", (delta) => {
      text += delta;
      onText(text);
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new AskError("Claude declined to answer that one.");
    history.push({ role: "assistant", content: message.content });
    // Keep the conversation short: the last few exchanges are plenty.
    if (history.length > 12) history = history.slice(-12);
    return text;
  } catch (err) {
    history.pop();
    throw err instanceof AskError ? err : explain(err);
  }
}
