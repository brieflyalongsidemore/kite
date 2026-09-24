"""Settings: environment variables (and .env) provide defaults; the Settings screen saves overrides
to data/settings.json. Secrets are never sent back to the browser in full."""

import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv():
    if os.environ.get("KITE_NO_DOTENV"):  # tests and CI never read a real .env
        return
    for env_file in (Path.cwd() / ".env", ROOT / ".env"):
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    value = value.strip().strip('"').strip("'")
                    if value:
                        os.environ.setdefault(key.strip(), value)


_load_dotenv()
DATA = Path(os.environ.get("KITE_DATA") or ROOT / "data").resolve()
SETTINGS_FILE = DATA / "settings.json"
_lock = threading.Lock()

# Writer = the LLM that researches, plans and writes. Judge = Jev.
WRITERS = {
    "anthropic": {"label": "Anthropic API", "model": "claude-opus-5", "backup": "claude-opus-4-8"},
    "bedrock": {"label": "Amazon Bedrock", "model": "anthropic.claude-opus-5", "backup": "anthropic.claude-opus-4-8"},
    "openrouter": {"label": "OpenRouter", "model": "anthropic/claude-opus-5", "backup": "anthropic/claude-sonnet-5",
                   "base_url": "https://openrouter.ai/api/v1"},
    "openai": {"label": "OpenAI", "model": "gpt-5", "backup": "", "base_url": "https://api.openai.com/v1"},
    "compatible": {"label": "OpenAI-compatible (Ollama, LM Studio…)", "model": "llama3.1", "backup": "",
                   "base_url": "http://localhost:11434/v1"},
}
JUDGES = {
    "openrouter": {"label": "OpenRouter", "model": "~typesafe/jev-latest", "url": "https://openrouter.ai/api/alpha/decisions"},
    "typesafe": {"label": "TypeSafe API", "model": "jev-latest", "url": "https://api.typesafe.ai/v1/systemone"},
}
# Each provider keeps its own key, so switching providers never sends one provider's key to another.
WRITER_KEYS = {"anthropic": "anthropic_api_key", "openai": "openai_api_key", "openrouter": "openrouter_api_key", "compatible": "compatible_api_key"}
JUDGE_KEYS = {"openrouter": "openrouter_api_key", "typesafe": "typesafe_api_key"}
SECRETS = {f"writer.{k}" for k in WRITER_KEYS.values()} | {f"judge.{k}" for k in JUDGE_KEYS.values()} | {"research.brave_api_key", "sources.x_bearer_token"}


def _env(*names):
    for n in names:
        if os.environ.get(n):
            return os.environ[n]
    return ""


def _aws_available():
    try:
        import boto3
        return boto3.Session().get_credentials() is not None
    except Exception:
        return False


def _env_settings():
    provider = _env("KITE_WRITER_PROVIDER")
    if not provider:  # pick the first writer that has credentials
        provider = ("anthropic" if _env("ANTHROPIC_API_KEY") else "bedrock" if _aws_available()
                    else "openrouter" if _env("OPENROUTER_API_KEY") else "openai" if _env("OPENAI_API_KEY") else "anthropic")
    judge = _env("KITE_JUDGE_PROVIDER") or ("typesafe" if _env("TYPESAFE_API_KEY") and not _env("OPENROUTER_API_KEY") else "openrouter")
    return {
        "writer": {"provider": provider, "model": _env("KITE_WRITER_MODEL"), "backup_model": _env("KITE_WRITER_BACKUP_MODEL"),
                   "anthropic_api_key": _env("ANTHROPIC_API_KEY"), "openai_api_key": _env("OPENAI_API_KEY"),
                   "openrouter_api_key": _env("OPENROUTER_API_KEY"), "compatible_api_key": _env("KITE_WRITER_API_KEY"),
                   "base_url": _env("KITE_WRITER_BASE_URL"), "region": _env("AWS_REGION", "AWS_DEFAULT_REGION"), "aws_profile": _env("AWS_PROFILE")},
        "judge": {"provider": judge, "model": _env("JEV_MODEL"), "openrouter_api_key": _env("OPENROUTER_API_KEY"),
                  "typesafe_api_key": _env("TYPESAFE_API_KEY"), "base_url": _env("TYPESAFE_API_BASE")},
        "research": {"brave_api_key": _env("BRAVE_API_KEY")},
        "sources": {"x_bearer_token": _env("X_BEARER_TOKEN")},
    }


def _file_settings():
    try:
        return json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        return {}


def settings():
    """Effective settings: the Settings screen wins over the environment; blanks fall back to presets."""
    env, saved = _env_settings(), _file_settings()
    out = {}
    for section, values in env.items():
        merged = dict(values)
        for k, v in (saved.get(section) or {}).items():
            if v not in (None, ""):
                merged[k] = v
        out[section] = merged
    w, j = out["writer"], out["judge"]
    w["api_key"] = w.get(WRITER_KEYS.get(w["provider"], ""), "")  # the key for the provider in use
    j["api_key"] = j.get(JUDGE_KEYS.get(j["provider"], ""), "")
    preset = WRITERS.get(w["provider"], WRITERS["anthropic"])
    w["model"] = w["model"] or preset["model"]
    w["backup_model"] = w["backup_model"] or preset.get("backup", "")
    w["base_url"] = w["base_url"] or preset.get("base_url", "")
    jp = JUDGES.get(j["provider"], JUDGES["openrouter"])
    j["model"] = j["model"] or jp["model"]
    j["url"] = (j.get("base_url") or "").rstrip("/") + "/v1/systemone" if j["provider"] == "typesafe" and j.get("base_url") else jp["url"]
    return out


def _mask(v):
    return f"••••{v[-4:]}" if v and len(v) > 8 else ("••••" if v else "")


def public_settings():
    """What the Settings screen shows: secrets masked, plus where each value came from."""
    eff, saved = settings(), _file_settings()
    view = {}
    for section, values in eff.items():
        view[section] = {}
        for k, v in values.items():
            if k == "api_key" or k == "url":
                continue  # derived from the per-provider keys / base URL
            secret = f"{section}.{k}" in SECRETS
            view[section][k] = {"value": _mask(v) if secret else v, "set": bool(v), "secret": secret,
                                "from": "app" if (saved.get(section) or {}).get(k) else ("env" if v else "")}
    return {"settings": view, "writers": {k: {"label": p["label"], "model": p["model"], "backup": p.get("backup", ""),
                                              "base_url": p.get("base_url", "")} for k, p in WRITERS.items()},
            "judges": {k: {"label": p["label"], "model": p["model"]} for k, p in JUDGES.items()}}


def save_settings(update):
    """Merge an update from the Settings screen. Blank secrets keep the current value; "-" clears one."""
    with _lock:
        saved = _file_settings()
        for section, values in (update or {}).items():
            if section not in ("writer", "judge", "research", "sources") or not isinstance(values, dict):
                continue
            cur = saved.setdefault(section, {})
            for k, v in values.items():
                if not isinstance(v, (str, int, float)) or k in ("url",):
                    continue
                v = str(v).strip()
                if f"{section}.{k}" in SECRETS:
                    if v == "-":
                        cur.pop(k, None)
                    elif v and not v.startswith("••••"):
                        cur[k] = v
                else:
                    cur[k] = v
        DATA.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(saved, indent=2))
        os.chmod(tmp, 0o600)  # keys live here; keep it private to this user
        tmp.replace(SETTINGS_FILE)
    return public_settings()
