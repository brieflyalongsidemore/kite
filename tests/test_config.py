from kite import config


def test_presets_fill_blanks():
    s = config.settings()
    assert s["writer"]["provider"] == "compatible"
    assert s["writer"]["base_url"].endswith("/v1")
    assert s["judge"]["url"].startswith("https://")


def test_secrets_are_masked_and_blank_keeps_value():
    config.save_settings({"judge": {"provider": "typesafe", "typesafe_api_key": "ts-secret-123456"}})
    view = config.public_settings()["settings"]["judge"]
    assert view["typesafe_api_key"]["value"] == "••••3456" and view["typesafe_api_key"]["from"] == "app"
    assert config.settings()["judge"]["url"] == "https://api.typesafe.ai/v1/systemone"
    assert config.settings()["judge"]["api_key"] == "ts-secret-123456"
    config.save_settings({"judge": {"typesafe_api_key": ""}})  # blank: keep
    assert config.settings()["judge"]["api_key"] == "ts-secret-123456"
    config.save_settings({"judge": {"typesafe_api_key": "••••3456"}})  # masked echo: keep
    assert config.settings()["judge"]["api_key"] == "ts-secret-123456"
    config.save_settings({"judge": {"provider": "openrouter"}})  # other provider: its own (empty) key, not TypeSafe's
    assert not config.settings()["judge"]["api_key"]
    config.save_settings({"judge": {"typesafe_api_key": "-"}})  # "-": clear
    assert not config.settings()["judge"]["typesafe_api_key"]


def test_writer_keys_are_per_provider():
    config.save_settings({"writer": {"provider": "openrouter", "openrouter_api_key": "or-key-abcdef12"}})
    assert config.settings()["writer"]["api_key"] == "or-key-abcdef12"
    config.save_settings({"writer": {"provider": "openai"}})
    assert config.settings()["writer"]["api_key"] == ""  # never reuses the OpenRouter key
    config.save_settings({"writer": {"provider": "compatible"}})
