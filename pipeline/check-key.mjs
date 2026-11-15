// Says whether the Claude key in this shell can make a request right now.
import Anthropic from "@anthropic-ai/sdk";
try {
  const r = await new Anthropic().messages.create({
    model: "claude-haiku-5-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with the word ready." }],
  });
  console.log("Key works:", r.content.find((b) => b.type === "text")?.text?.trim() ?? r.stop_reason);
} catch (err) {
  if (err instanceof Anthropic.APIError) console.log(`Key refused (${err.status}): ${err.error?.error?.message ?? err.message}`);
  else throw err;
  process.exitCode = 1;
}
