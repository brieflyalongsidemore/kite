# Contributing

Thanks for helping. Kite is small on purpose: a Python standard-library server, one dependency (the Anthropic SDK), and a web app with no build step.

- **Setup:** `pip install -e ".[dev]"`, then `kite`.
- **Before a PR:** `ruff check .` and `pytest -q` must pass. Tests are offline; keep it that way, and use fakes like `FakeWriter` in `tests/test_llm.py`.
- **Adding a writer provider:** implement `user`, `results` and `step` in `kite/llm.py`, returning a `Step`. Raise `TransientError` for overloads and rate limits. Register the provider in `writer()`, and add a preset in `config.WRITERS`.
- **Changing a Jev rubric:** rubrics live in `kite/jev.py`. Keep the questions short and concrete, and keep scoring formulas in plain code so they're easy to reason about.
- **Prompts** are principles, not scripts. The planning agent chooses its own approach; please don't turn it back into a fixed recipe.
- **Never** log or return API keys, send data to services the user didn't choose, or make the server listen beyond `127.0.0.1` by default.
- **The clipper** lives in `web/clipper.js`, and `extension/clipper.js` is a copy for the extension. After editing it, run `cp web/clipper.js extension/clipper.js` (a test checks they match).
- **The extension download** on the landing page is `docs/kite-extension.zip`. After changing `extension/`, rebuild it with `python -m kite.extension docs/kite-extension.zip`.
