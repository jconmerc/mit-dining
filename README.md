# MIT Dining

One page with every MIT dining hall's menu for the next eight days, cleaned up so it reads like a menu, plus a box for asking questions about it.

`site/` is the website and the only folder that gets published. There's no build step for the page: edit a file, save, refresh.

## How the menus get here

1. **Fetch.** `pipeline/fetch.mjs` reads each hall's page on mit.cafebonappetit.com for each day. Those addresses never change (`/cafe/baker/2026-11-16/`), and each page carries the full menu as data. The old print-menu links, which got a new number every Monday, aren't used at all.
2. **Organise.** `pipeline/organize.mjs` sends each meal to Claude, which folds the omelet fillings into one "Build-your-own omelet", puts the burger's bun and pickles under the burger, drops certification notes and theme-night titles, fixes the names, and marks the dishes worth going for.
3. **Check.** Claude's answer is only used if every item on the vendor's list is accounted for exactly once and nothing was added. A name that no longer matches its item is replaced with the vendor's. If the answer fails, Claude is asked once more with the problems listed; if it fails again, or there's no key, that meal is tidied by plain rules instead.
4. **Write.** `pipeline/build.mjs` writes `site/data/days/<date>.json` and `site/data/index.json`.

Organised meals are cached in `pipeline/cache/` by their content. A breakfast that's the same every weekday is sent to Claude once, and running the build twice costs nothing the second time.

## Run it

```bash
npm install
```

```bash
npm run menus
```

```bash
npm run serve
```

Then open http://localhost:5210. `npm run menus` uses `ANTHROPIC_API_KEY` from your shell if it's set, and falls back to rules if it isn't. `node pipeline/check-key.mjs` says whether the key works. `DAYS=2 npm run menus` fetches fewer days.

## Publishing

`.github/workflows/menus.yml` runs the build twice a day, saves the new data to the repo, and publishes `site/` with GitHub Pages. It needs:

- Pages set to deploy from GitHub Actions (repo Settings, Pages).
- A repository secret named `ANTHROPIC_API_KEY`. Use a key made just for this, with a monthly spending limit.

If the key is missing or refused, the run still publishes (tidied by rules) and puts a warning on the run's page. If the vendor's pages change so that nothing can be read, the run fails and the site keeps its last menus.

## The question box

Questions are answered by Claude (`claude-haiku-5-5`) with the week's menus as context. There are two ways a question can get there:

- **The ask server** in `worker/`, a small Cloudflare Worker that holds a Claude key so visitors don't need one. Set its address as `ASK_URL` in `site/js/config.js`.
- **A visitor's own key**, pasted into the page and kept in that browser only. This is what the page falls back to when `ASK_URL` is empty or the day's shared budget has run out.

No key is ever in this repo or in the page.

### What keeps the ask server from running up a bill

- **A daily budget shared by everyone** (`DAILY_BUDGET_USD`, default $1). Each answer's real cost, from the token counts Claude reports, is added to the day's total. Once the total reaches the budget, every request is refused until midnight in Cambridge.
- **A daily cap per visitor** (`QUESTIONS_PER_VISITOR`, default 25) and a short wait between one visitor's questions.
- **The server writes the prompt.** A caller can only send short plain-text questions. It can't pick the model, the instructions or the answer length, so the key can't be used as a free general-purpose Claude.
- **Only this site's address** may call it from a browser.
- **A spending limit on the key itself**, set in the Claude Console. Use a key made only for this, so that limit is the backstop if anything above fails.

The limits are in `worker/wrangler.jsonc`. `https://<the worker's address>/today` shows the day's spend and question count.

### Setting it up

```bash
cd worker && npm install
```

```bash
npx wrangler deploy
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Then put the address `wrangler deploy` printed into `site/js/config.js` and push.

## Where to edit

| To change | Edit |
|---|---|
| Which halls are listed | `pipeline/halls.mjs` |
| How Claude is told to tidy a meal | `SYSTEM` in `pipeline/organize.mjs` (bump `VERSION` so cached meals are redone) |
| The checks on Claude's answer | `problemsWith` and `settle` in `pipeline/organize.mjs` |
| Which Claude model tidies | `ORGANIZER_MODEL` (default `claude-opus-5-5`) |
| The most the cleanup may spend per day | `ORGANIZER_DAILY_USD` (default 1.5); today's total is in `pipeline/cache/spend.json` |
| How many days ahead | `DAYS` (default 8) |
| Colors and layout | the `<style>` block in `site/index.html` |
| Views, filters, day and meal picking | `site/js/app.js` |
| How the question box answers | `RULES` in `site/js/context.js` |
| The shared budget and per-visitor limits | `vars` in `worker/wrangler.jsonc` |
| The Claude SDK the page loads | `npm run vendor` rebuilds `site/js/anthropic.js` |

Unofficial. Menus, diet labels and allergen labels are MIT Dining's own.
