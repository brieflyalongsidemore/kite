import tempfile

import pytest
from anthropic import beta_tool

from kite import llm


class FakeWriter:
    """Scripted writer: each script item is a Step or an exception to raise."""
    provider, native_memory = "fake", False

    def __init__(self, script, backup="backup-model"):
        self.script, self.model, self.backup, self.models = list(script), "main-model", backup, []

    def user(self, text, images=()):
        return {"role": "user", "content": text}

    def results(self, results):
        return [{"role": "tool", "tool_call_id": i, "content": out} for i, out, _ in results]

    def step(self, history, system, tools, model):
        self.models.append(model)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        history.append({"role": "assistant", "content": item.text})
        return item


def test_loop_runs_tools_and_rides_out_overloads(monkeypatch):
    monkeypatch.setattr(llm, "PATIENCE", (0, 0, 0))
    seen = []

    @beta_tool
    def add(a: int, b: int) -> str:
        """Add two numbers.

        Args:
            a: first
            b: second
        """
        seen.append((a, b))
        return str(a + b)

    w = FakeWriter([llm.Step(calls=[("c1", "add", {"a": 2, "b": 3})]), llm.TransientError("529"), llm.TransientError("529"),
                    llm.Step(text="5")])
    history, logs = [w.user("go")], []
    steps = list(llm.run_loop(w, history, "sys", {"add": add}, lambda k, t, **_: logs.append(t)))
    assert seen == [(2, 3)]  # the tool ran once, not again after the overloads
    assert [s.text for s in steps] == ["", "5"]
    assert w.models == ["main-model", "main-model", "main-model", "backup-model"]  # backup after the first long wait
    assert any("switching to backup-model" in m for m in logs)


def test_loop_gives_up_with_a_clear_message(monkeypatch):
    monkeypatch.setattr(llm, "PATIENCE", (0,))
    w = FakeWriter([llm.TransientError("529"), llm.TransientError("529")])
    with pytest.raises(RuntimeError, match="stayed busy"):
        list(llm.run_loop(w, [], "sys", {}, lambda *a, **k: None))


def test_openai_tool_defs_include_memory():
    from anthropic.lib.tools._beta_builtin_memory_tool import BetaLocalFilesystemMemoryTool
    mem = BetaLocalFilesystemMemoryTool(base_path=tempfile.mkdtemp())
    d = llm.tool_def(mem)
    assert d["name"] == "memory" and "command" in d["input_schema"]["properties"]
    # the plain-function form drives the same backend
    out, err = llm.run_tool({"memory": mem}, "memory", {"command": "create", "path": "/memories/Note.md", "file_text": "hi [[Me]]"})
    assert not err and "created" in out.lower()


def test_openai_writer_formats_images():
    w = llm.OpenAIWriter({"provider": "compatible", "model": "m", "base_url": "http://x/v1"})
    msg = w.user("look", [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAA"}}])
    assert msg["content"][1]["image_url"]["url"] == "data:image/png;base64,AAA"
