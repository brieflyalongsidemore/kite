"""Tests run offline against a throwaway data folder, with no keys set."""

import os
import tempfile

os.environ["KITE_NO_DOTENV"] = "1"  # never load a real .env (keys) in tests
os.environ["KITE_DATA"] = tempfile.mkdtemp(prefix="kite-test-")
for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "KITE_WRITER_PROVIDER",
            "KITE_JUDGE_PROVIDER", "BRAVE_API_KEY", "X_BEARER_TOKEN"):
    os.environ.pop(key, None)
os.environ["KITE_WRITER_PROVIDER"] = "compatible"  # never touch real credentials in tests
