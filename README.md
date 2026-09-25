<p align="center"><img src="docs/banner.png" alt="kite: grow on social, one good call at a time" width="100%"></p>

<p align="center"><a href="https://open-kite.vercel.app">Website</a> · <a href="#quick-start">Quick start</a> · <a href="#providers">Providers</a> · <a href="CONTRIBUTING.md">Contributing</a></p>

# kite

**A local copilot for growing on social media.** An LLM does the thinking and writing. [Jev](https://openrouter.ai/docs/guides/community/jev), TypeSafe's decision model, makes the calls: which kinds of posts to make, which ideas are worth it, which draft wins, which action comes first.

It runs on your machine and keeps a brain of what you've done, skipped and learned. Every day it gives you a short focus list and posts that are ready to publish.

```
Today
  Good morning, @you.          ■ ■ □ ■ ■ ■ ▣  5-day streak
  Building an audience in AI coding tools by replying into live threads.

  FOCUS · 1/3 DONE
  ○ Reply to 15 posts from mid-size agent accounts        Work on it →
  ● Rewrite the bio and pin your best post
  ○ Start a 3×/week "what my agent got wrong" series

  READY TO POST                                       1/3 →
  ┌─────────────────────────────────────────────┐
  │ The first thing you lose to agents isn't     │
  │ your typing. It's your taste.                │
  │ 74 JEV · head-to-head 52% · bait 4%          │
  └─────────────────────────────────────────────┘
```

## How it works

1. **It learns your voice.** Paste your profile page (Cmd+A, Cmd+C), add screenshots, upload an export such as X's `data/tweets.js`, or use the **kite clipper** bookmarklet (Settings › You): open your profile on any site, click it, and it collects your posts with their likes and replies from what's on your screen. You don't need an API. Kite writes an editable profile covering your niche, audience, voice, pillars, what performs and what flops.
2. **It makes a plan.** The writer works as an agent, with Jev as its decision engine:

   | Step | Writer proposes | Jev decides |
   |---|---|---|
   | Mix | 4–10 kinds of posts tailored to you | a fit score for each kind, turned into shares of the drafts |
   | Ideas | ideas from your expertise, your audience, debates in your niche, and current events | interest, timing, authority, debate, freshness, and which idea goes first |
   | Posts | drafts in your voice | hook, shareability, discussion, novelty, clarity, fit, voice, bait, **rehash** of your past posts, and head-to-head odds |
   | Actions | growth moves beyond posting | impact, effort, fit, odds, risk, and the first move |

   Research is optional and free. The writer can use Reddit, Hacker News, Bluesky, Mastodon, Google News and Google Trends, plus Brave web search if you add a key.
3. **It helps you do the work.** Every action has **Work on it**, which opens a thread. The writer turns the action into a checklist and drafts replies, posts or bios, and Jev picks the best ones. You post them yourself.
   With the **browser extension** (below), a thread can do the legwork itself: search X, Bluesky, LinkedIn, Threads or Reddit in your own browser, collect posts worth replying to, and open each one with Jev's chosen reply typed into the reply box. It never posts. You read it and press Reply.
4. **It remembers.** The brain is a folder of Markdown notes linked like an Obsidian vault. Kite records every plan, decision, checklist tick and post in it, and the writer maintains it through Anthropic's memory tool. **Reflect** updates your *Direction*: where you're really heading, what you've done versus planned, and what to focus on next. The Brain tab shows it as a graph.

## Quick start

```bash
git clone https://github.com/brieflyalongsidemore/kite && cd kite
cp .env.example .env        # add at least one writer key, plus a Jev key
pip install -e .
kite                        # → http://localhost:8788
```

Or with Docker:

```bash
cp .env.example .env
docker compose up -d        # → http://localhost:8788, data in ./data
```

You can also set everything in the app under **Settings**. Settings saved there are stored in `data/settings.json` (readable only by you) and override `.env`.

## Browser extension (optional)

Let a thread do the legwork: ask it to find posts worth replying to, and Kite searches X, Bluesky, LinkedIn, Threads or Reddit **in your own browser**, where you're already logged in. It collects the posts, drafts replies, lets Jev pick the best, and opens each post with the reply typed into the reply box. **It never posts: you read it and press Reply.** No API and no extra login.

Install it in about a minute (Chrome, Edge, Brave or Arc):

1. Download **[kite-extension.zip](https://open-kite.vercel.app/kite-extension.zip)**, or get it from your own Kite at `http://localhost:8788/kite-extension.zip` (Settings › Browser extension › Install). Double-click it to unzip.
2. Open `chrome://extensions` and turn on **Developer mode**, top right.
3. Click **Load unpacked** and pick the `kite-extension` folder. (From a clone of this repo you can pick `extension/` instead.)
4. Kite's Settings shows a live dot once it's connected. If Kite isn't on `http://localhost:8788`, set its address in the extension's popup.

Browsers only allow extensions from outside their store to be added this way, so keep the folder where it is.

Without the extension, the **kite clipper** bookmarklet (Settings › You, or **Clip posts** in a thread) collects posts from any page when you click it.

## Providers

**Writer**, the LLM that researches, plans and writes:

| Provider | Setup | Notes |
|---|---|---|
| Anthropic API | `ANTHROPIC_API_KEY` | Default model `claude-opus-5`; supports thinking, the memory tool and refusal fallback |
| Amazon Bedrock | your AWS credentials (env vars, `~/.aws`, SSO) | Default model `anthropic.claude-opus-5`. In Docker, mount `~/.aws` (see `docker-compose.yml`) |
| OpenRouter | `OPENROUTER_API_KEY` | Any model OpenRouter hosts: Claude, GPT, Gemini, Llama… |
| OpenAI | `OPENAI_API_KEY` | Default model `gpt-5` |
| OpenAI-compatible | `KITE_WRITER_BASE_URL` | Ollama, LM Studio, vLLM. From Docker, use `http://host.docker.internal:11434/v1` |

Each provider has a **backup model** that takes over if the main one stays overloaded. Kite waits 15 s, 30 s and 60 s between attempts and switches to the backup after the first long wait. It resumes the conversation where it stopped, so no work is re-run.

**Judge**, Jev:

| Provider | Setup |
|---|---|
| OpenRouter | `OPENROUTER_API_KEY` (model `~typesafe/jev-latest`) |
| TypeSafe API | `TYPESAFE_API_KEY` (model `jev-latest`, `https://api.typesafe.ai/v1/systemone`) |

Without a Jev key, Kite still runs, but a rough heuristic stands in for the scores.

**Cost:** Jev is about $0.042 per million input tokens, so a few hundredths of a cent per plan. A plan costs one writer session, typically $0.50–$2 on Claude Opus 5. The app shows a running estimate.

## Your data

Everything stays in `data/`, which is gitignored and mounted as a volume in Docker.

| Path | What's there |
|---|---|
| `settings.json` | Provider settings and keys (mode 600) |
| `workspace.json` | Your profile, platform, goal and latest plan |
| `runs/` | Every plan, saved as it runs. Deleted plans go to `runs/trash/` |
| `threads/` | Action threads, each linked to its plan |
| `brain/memories/` | The brain vault. Open it in Obsidian if you like. Deleted notes go to `brain/trash/` and can be restored |

What leaves your machine: prompts sent to the providers you choose, and research queries to the public sites listed above. Kite has no telemetry.

**Security:** Kite has no login. It listens on `127.0.0.1` by default, and the Docker setup publishes it on `127.0.0.1` only. Don't expose it to a network. The page reader refuses private and local addresses. Pages and pasted posts are treated as information, never as instructions.

## Project layout

```
kite/
  config.py    settings from .env and the Settings screen (per-provider keys, masking)
  llm.py       writer providers behind one interface, plus the tool loop with overload handling
  jev.py       the judge: every rubric Kite asks Jev
  agent.py     reading a profile, the planning run, Reflect
  threads.py   action threads
  brain.py     the vault, memory tool, graph, trash
  research.py  free research sources and the safe page reader
  sources.py   profile import (paste, screenshots, X archive, Bluesky, X API)
  store.py     jobs, runs and workspace on disk
  server.py    JSON API and static files
web/           index.html, app.css, app.js (no build step)
docs/          banner and GitHub social preview
tests/         offline tests (no keys, no network)
```

## Develop

```bash
pip install -e ".[dev]"
ruff check .
pytest -q
```

Tests never read `.env` and never touch the network. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
