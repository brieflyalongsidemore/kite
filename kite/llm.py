"""The writer: one small interface over several LLM providers.

- Anthropic API and Amazon Bedrock go through the official Anthropic SDK (thinking, the memory tool,
  refusal fallbacks).
- OpenAI, OpenRouter and any OpenAI-compatible server (Ollama, LM Studio...) go through the
  chat-completions API with function calling.

Every agent in Kite uses `run_loop`, which calls the model, runs the tools it asks for, and keeps going.
It rides out overloads (waits, then switches to the backup model) without losing the conversation.
"""

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from . import config

try:
    import anthropic
    from anthropic import BetaFallbackState, BetaRefusalFallbackMiddleware
except ImportError:  # the OpenAI-compatible writers still work without it
    anthropic = None

PATIENCE = (15, 30, 60)  # seconds between attempts after the SDK's own quick retries

# $ per million tokens (input, output), for the cost estimate shown in the app.
PRICES = {"fable-5": (10, 50), "mythos": (10, 50), "opus-5-5": (4, 20), "opus-5": (5, 25), "opus-4": (5, 25),
          "sonnet-5": (2, 10), "sonnet-4": (3, 15), "haiku-4": (1, 5)}


class TransientError(Exception):
    """Overloaded, rate-limited, server-side or network trouble: worth waiting out."""


class Refusal(Exception):
    pass


@dataclass
class Step:
    text: str = ""
    thinking: str = ""
    calls: list = field(default_factory=list)  # [(id, name, input)]
    input_tokens: int = 0
    output_tokens: int = 0
    cost: float | None = None
    model: str = ""
    stop: str = ""


def estimate_cost(model, tin, tout):
    for key, (pin, pout) in PRICES.items():
        if key in model:
            return (tin * pin + tout * pout) / 1e6
    return None


# ---------------------------------------------------------------- tools shared by all providers

MEMORY_FUNCTION = {
    "name": "memory",
    "description": ("Read and write the person's brain: markdown notes under /memories. Commands: view (path, optional "
                    "view_range [start, end]), create (path, file_text), str_replace (path, old_str, new_str), insert "
                    "(path, insert_line, insert_text), delete (path), rename (old_path, new_path). Paths start with /memories."),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "enum": ["view", "create", "str_replace", "insert", "delete", "rename"]},
            "path": {"type": "string"}, "file_text": {"type": "string"}, "old_str": {"type": "string"},
            "new_str": {"type": "string"}, "insert_line": {"type": "integer"}, "insert_text": {"type": "string"},
            "old_path": {"type": "string"}, "new_path": {"type": "string"},
            "view_range": {"type": "array", "items": {"type": "integer"}},
        },
        "required": ["command"],
    },
}


def tool_def(tool):
    """A tool's definition as a plain name/description/schema dict (the memory tool gets an explicit schema)."""
    d = tool.to_dict()
    if str(d.get("type", "")).startswith("memory_"):
        return MEMORY_FUNCTION
    return {"name": d["name"], "description": d.get("description", ""), "input_schema": d["input_schema"]}


def tool_name(tool):
    return tool.to_dict().get("name")


def run_tool(tools, name, args):
    tool = tools.get(name)
    if tool is None:
        return f"Error: unknown tool {name}", True
    try:
        return str(tool.call(args)), False
    except Exception as exc:  # tools report errors back to the model instead of crashing the run
        return f"Error: {exc}", True


# ---------------------------------------------------------------- Anthropic API / Bedrock

class AnthropicWriter:
    """Anthropic API or Amazon Bedrock, through the official SDK."""

    def __init__(self, cfg):
        if anthropic is None:
            raise RuntimeError('The Anthropic SDK is missing: pip install "anthropic[bedrock]"')
        self.cfg = cfg
        self.provider = cfg["provider"]
        self.model, self.backup = cfg["model"], cfg.get("backup_model") or ""
        self._client = None
        self.native_memory = True
        self.state = BetaFallbackState()  # keeps follow-ups on whichever model accepted a refused request

    def client(self):
        if self._client is None:
            # If the model declines a request, the SDK retries it on the backup model.
            fallback = [BetaRefusalFallbackMiddleware([{"model": self.backup}], betas=() if self.provider == "bedrock" else None)] if self.backup else []
            if self.provider == "bedrock":
                region = self.cfg.get("region")
                if not region:  # the Mantle client doesn't read ~/.aws/config, so resolve the region here
                    import boto3
                    region = boto3.Session(profile_name=self.cfg.get("aws_profile") or None).region_name or "us-east-1"
                self._client = anthropic.AnthropicBedrockMantle(aws_region=region, aws_profile=self.cfg.get("aws_profile") or None,
                                                                max_retries=4, middleware=fallback)
            else:
                self._client = anthropic.Anthropic(api_key=self.cfg.get("api_key") or None, max_retries=4, middleware=fallback)
        return self._client

    def user(self, text, images=()):
        return {"role": "user", "content": [*images, {"type": "text", "text": text}]}

    def results(self, results):
        return [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": i, "content": out, **({"is_error": True} if err else {})}
                                             for i, out, err in results]}]

    def step(self, history, system, tools, model):
        defs = [t.to_dict() if tool_name(t) == "memory" else tool_def(t) for t in tools.values()]
        kwargs = {}
        if "haiku" not in model:  # Haiku 4.5 uses the older thinking API; everything current supports adaptive
            kwargs["thinking"] = {"type": "adaptive", "display": "summarized"}
        try:
            with self.state:
                msg = self.client().beta.messages.create(
                    model=model, max_tokens=16000, messages=history, tools=defs or anthropic.NOT_GIVEN,
                    system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}], **kwargs)
        except (anthropic.APIConnectionError, anthropic.RateLimitError) as exc:
            raise TransientError(str(exc)) from exc
        except anthropic.APIStatusError as exc:
            if exc.status_code >= 500:
                raise TransientError(f"{exc.status_code}: {exc.message}") from exc
            raise RuntimeError(f"{self.provider} error {exc.status_code}: {exc.message}") from exc
        if msg.stop_reason == "refusal":
            raise Refusal("The model declined this request (and so did the fallback model).")
        history.append({"role": "assistant", "content": [b.model_dump(mode="json", exclude_none=True) for b in msg.content]})
        u = msg.usage
        return Step(
            text="\n\n".join(b.text.strip() for b in msg.content if b.type == "text" and b.text.strip()),
            thinking="\n".join(b.thinking for b in msg.content if b.type == "thinking" and b.thinking),
            calls=[(b.id, b.name, b.input) for b in msg.content if b.type == "tool_use"],
            input_tokens=u.input_tokens, output_tokens=u.output_tokens,
            cost=estimate_cost(msg.model, u.input_tokens, u.output_tokens), model=msg.model, stop=msg.stop_reason or "")


# ---------------------------------------------------------------- OpenAI / OpenRouter / compatible

class OpenAIWriter:
    """Any chat-completions API with function calling: OpenAI, OpenRouter, Ollama, LM Studio..."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.provider = cfg["provider"]
        self.model, self.backup = cfg["model"], cfg.get("backup_model") or ""
        self.url = cfg["base_url"].rstrip("/") + "/chat/completions"
        self.native_memory = False

    def user(self, text, images=()):
        if not images:
            return {"role": "user", "content": text}
        parts = [{"type": "text", "text": text}]
        for img in images:
            src = img["source"]
            parts.append({"type": "image_url", "image_url": {"url": f"data:{src['media_type']};base64,{src['data']}"}})
        return {"role": "user", "content": parts}

    def results(self, results):
        return [{"role": "tool", "tool_call_id": i, "content": out} for i, out, _ in results]

    def step(self, history, system, tools, model):
        body = {"model": model, "messages": [{"role": "system", "content": system}, *history]}
        if tools:
            body["tools"] = [{"type": "function", "function": {"name": d["name"], "description": d["description"], "parameters": d["input_schema"]}}
                             for d in (tool_def(t) for t in tools.values())]
        headers = {"Content-Type": "application/json"}
        if self.cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {self.cfg['api_key']}"
        if self.provider == "openrouter":
            headers.update({"HTTP-Referer": "https://github.com/kite-app/kite", "X-Title": "Kite"})
            body["usage"] = {"include": True}
        req = urllib.request.Request(self.url, data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            if exc.code == 429 or exc.code >= 500:
                raise TransientError(f"{exc.code}: {detail}") from exc
            raise RuntimeError(f"{self.provider} error {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise TransientError(f"couldn't reach {self.url} ({exc})") from exc
        if data.get("error"):
            raise RuntimeError(f"{self.provider} error: {data['error']}")
        choice = data["choices"][0]
        msg = choice["message"]
        history.append({k: v for k, v in {"role": "assistant", "content": msg.get("content") or "",
                                          "tool_calls": msg.get("tool_calls")}.items() if v is not None})
        calls = []
        for c in msg.get("tool_calls") or []:
            try:
                args = json.loads(c["function"].get("arguments") or "{}")
            except ValueError:
                args = {}
            calls.append((c["id"], c["function"]["name"], args))
        u = data.get("usage") or {}
        tin, tout = u.get("prompt_tokens", 0), u.get("completion_tokens", 0)
        return Step(text=(msg.get("content") or "").strip(), thinking=(msg.get("reasoning") or msg.get("reasoning_content") or ""),
                    calls=calls, input_tokens=tin, output_tokens=tout,
                    cost=u.get("cost") if u.get("cost") is not None else estimate_cost(model, tin, tout),
                    model=data.get("model", model), stop=choice.get("finish_reason") or "")


def writer(cfg=None):
    cfg = cfg or config.settings()["writer"]
    return (AnthropicWriter if cfg["provider"] in ("anthropic", "bedrock") else OpenAIWriter)(cfg)


def writer_status():
    cfg = config.settings()["writer"]
    label = config.WRITERS.get(cfg["provider"], {}).get("label", cfg["provider"])
    if cfg["provider"] == "bedrock":
        if anthropic is None:
            return False, 'Install the SDK: pip install "anthropic[bedrock]"'
        if not config._aws_available():
            return False, "No AWS credentials found; run `aws configure` or `aws sso login`"
    elif cfg["provider"] == "anthropic":
        if anthropic is None:
            return False, "Install the SDK: pip install anthropic"
        if not cfg.get("api_key"):
            return False, "Add an Anthropic API key in Settings"
    elif cfg["provider"] in ("openai", "openrouter") and not cfg.get("api_key"):
        return False, f"Add your {label} API key in Settings"
    return True, f"{cfg['model']} via {label}"


# ---------------------------------------------------------------- the loop

def run_loop(w, history, system, tools, log, usage=None, max_steps=24, on_step=None):
    """Call the model, run the tools it asks for, repeat until it stops. Rides out overloads by waiting,
    then moving to the backup model, and resumes from `history` (nothing is re-run). Yields each Step."""
    model, attempt = w.model, 0
    for _ in range(max_steps):
        try:
            step = w.step(history, system, tools, model)
        except TransientError as exc:
            if attempt >= len(PATIENCE):
                raise RuntimeError(f"The model provider stayed busy even after waiting{' and trying the backup model' if w.backup else ''}. "
                                   "Everything so far is saved; try again in a few minutes.") from exc
            nxt = w.backup if attempt >= 1 and w.backup and model != w.backup else model
            log("error", f"The model is busy ({str(exc)[:60]}). Waiting {PATIENCE[attempt]}s and trying again"
                         + (f"; switching to {nxt}." if nxt != model else "."))
            time.sleep(PATIENCE[attempt])
            model, attempt = nxt, attempt + 1
            continue
        attempt = 0
        if usage:
            usage(step)
        if step.thinking:
            log("think", step.thinking)
        if step.text:
            log("claude", step.text)
        results = [(cid, *run_tool(tools, name, args)) for cid, name, args in step.calls]
        if results:
            history.extend(w.results(results))
        if on_step:
            on_step(step)
        yield step
        if not step.calls:
            return
    log("error", "Stopped after the step limit.")
