import json
import os
import tempfile
from collections import deque
import unittest
from unittest.mock import patch

import storage
from app import (
    audio_media_type,
    build_chat_payload,
    check_rate_limit,
    deerapi_request_kwargs,
    ensure_done_event_fields,
    generate_tts_bytes,
    gptsapi_request_kwargs,
    is_audio_bytes,
    is_youdao_machine_audio,
    llm_provider_settings,
    require_access_token,
    resolve_user_id,
    tts_configured,
    tts_provider_settings,
    tts_request_kwargs,
    youdao_word,
)
from fastapi import HTTPException
from json_stream_parser import JsonStreamParser
from language_strategy import EnglishStrategy, JapaneseStrategy
from models import DEFAULT_MODEL, resolve_model


class JsonStreamParserTests(unittest.TestCase):
    def test_emit_remaining_is_public_and_emits_unseen_fields(self):
        parser = JsonStreamParser(simple_fields=("query", "isWord"))
        parser.feed('{"query":"watch","isWord":true,')

        events = parser.emit_remaining({
            "query": "watch",
            "isWord": True,
            "definitions": [{"partOfSpeech": "v.", "meaning": "看", "examples": []}],
        })

        self.assertEqual(events, [
            {
                "type": "field",
                "name": "definitions",
                "value": [{"partOfSpeech": "v.", "meaning": "看", "examples": []}],
            }
        ])

    def test_streams_nested_context_and_syntax_text(self):
        parser = JsonStreamParser(simple_fields=("query", "isWord"))

        events = parser.feed(
            '{"query":"I bought it","isWord":false,'
            '"translation":"我买了它",'
            '"contextAnalysis":{"coreTranslation":"我买了它","analysis":"强调'
        )
        events.extend(
            parser.feed(
                '动作","usage":"日常表达"},'
                '"syntaxAnalysis":{"inlineComponents":[],"structureExplanation":"主谓宾'
            )
        )
        events.extend(
            parser.feed(
                '结构"},'
                '"keyExpressions":[]}'
            )
        )

        names = [(event["type"], event.get("name")) for event in events]
        self.assertIn(("text", "contextAnalysis.analysis"), names)
        self.assertIn(("text", "syntaxAnalysis.structureExplanation"), names)
        self.assertEqual(events[-1]["type"], "done")

    def test_null_complex_field_does_not_mark_field_emitted_before_done(self):
        parser = JsonStreamParser(simple_fields=("query", "isWord"))

        events = parser.feed(
            '{"query":"読む","isWord":true,"dictionaryForm":null,'
            '"definitions":null,"contextAnalysis":{"coreTranslation":"","analysis":"","usage":""}}'
        )

        done = events[-1]
        self.assertEqual(done["type"], "done")
        self.assertIsNone(done["data"]["definitions"])


class DoneEventFieldsTests(unittest.TestCase):
    def test_done_event_data_gets_default_fields(self):
        # 解析器主路径的 done 带 LLM 原始输出，可能缺 query/isWord 等字段
        event = {"type": "done", "data": {"translation": "你好"}}

        result = ensure_done_event_fields(event, EnglishStrategy(), "hello world you", False)

        self.assertEqual(result["data"]["query"], "hello world you")
        self.assertFalse(result["data"]["isWord"])
        self.assertIn("contextAnalysis", result["data"])
        self.assertIn("syntaxAnalysis", result["data"])

    def test_non_done_events_pass_through_unchanged(self):
        event = {"type": "field", "name": "query", "value": "hello"}

        result = ensure_done_event_fields(event, EnglishStrategy(), "hello", True)

        self.assertEqual(result, {"type": "field", "name": "query", "value": "hello"})

    def test_done_event_with_non_dict_data_passes_through(self):
        event = {"type": "done", "data": None}

        result = ensure_done_event_fields(event, EnglishStrategy(), "hello", True)

        self.assertIsNone(result["data"])


class LanguageStrategyTests(unittest.TestCase):
    def test_english_word_defaults_include_morphology_from_prompt_contract(self):
        data = EnglishStrategy().ensure_response_fields({}, "watched", True)

        self.assertEqual(data["query"], "watched")
        self.assertEqual(data["morphology"], [])
        self.assertEqual(data["definitions"], [])

    def test_japanese_word_schema_includes_streamed_metadata(self):
        strategy = JapaneseStrategy()

        self.assertEqual(
            strategy.get_schema_fields(True),
            ("query", "isWord", "kana", "romaji", "dictionaryForm"),
        )


class ModelAndPayloadTests(unittest.TestCase):
    def test_invalid_model_falls_back_to_default(self):
        self.assertEqual(resolve_model("unknown-model"), DEFAULT_MODEL["id"])

    def test_build_chat_payload_deduplicates_stream_and_non_stream_payload_shape(self):
        payload = build_chat_payload(
            selected_text="watch",
            context_sentence="I watch birds.",
            model=None,
            lang="en",
            stream=True,
        )

        self.assertEqual(payload["model"], DEFAULT_MODEL["id"])
        self.assertTrue(payload["stream"])
        self.assertEqual(payload["temperature"], 0.3)
        self.assertIn("messages", payload)

        encoded = json.dumps(payload, ensure_ascii=False)
        self.assertIn("单词/文本：watch", encoded)

    def test_default_model_is_deepseek_flash(self):
        self.assertEqual(DEFAULT_MODEL["id"], "deepseek-flash")

    def test_retired_glm4_falls_back_to_default(self):
        # 扩展里已存的旧选择不改也能切到新默认模型
        self.assertEqual(resolve_model("THUDM/GLM-4-9B-0414"), "deepseek-flash")

    def test_deepseek_flash_payload_disables_thinking(self):
        payload = build_chat_payload("watch", "I watch birds.", model="deepseek-flash")

        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("enable_thinking", payload)

    def test_siliconflow_model_keeps_enable_thinking_flag(self):
        payload = build_chat_payload(
            "watch", "I watch birds.", model="Pro/deepseek-ai/DeepSeek-V3.2"
        )

        self.assertIs(payload["enable_thinking"], False)
        self.assertNotIn("thinking", payload)

    def test_extra_payload_is_not_shared_between_requests(self):
        first = build_chat_payload("watch", "", model="deepseek-flash")
        first["thinking"]["type"] = "enabled"
        second = build_chat_payload("watch", "", model="deepseek-flash")

        self.assertEqual(second["thinking"], {"type": "disabled"})


class LlmProviderSettingsTests(unittest.TestCase):
    def test_deepseek_model_goes_to_official_api(self):
        with (
            patch("app.DEEPSEEK_API_KEY", "sk-ds"),
            patch("app.DEEPSEEK_BASE_URL", "https://api.deepseek.com/"),
        ):
            target = llm_provider_settings("deepseek-flash")
        self.assertEqual(target["url"], "https://api.deepseek.com/chat/completions")
        self.assertEqual(target["headers"]["Authorization"], "Bearer sk-ds")

    def test_siliconflow_model_keeps_siliconflow_endpoint(self):
        with (
            patch("app.SILICONFLOW_API_KEY", "sk-sf"),
            patch("app.LLM_API_BASE_URL", "https://api.siliconflow.cn/v1"),
        ):
            target = llm_provider_settings("Pro/zai-org/GLM-5")
        self.assertEqual(target["url"], "https://api.siliconflow.cn/v1/chat/completions")
        self.assertEqual(target["headers"]["Authorization"], "Bearer sk-sf")


class AccessTokenTests(unittest.TestCase):
    def test_access_token_not_required_when_unconfigured(self):
        self.assertIsNone(require_access_token(None, configured_token=""))

    def test_access_token_required_when_configured(self):
        with self.assertRaises(HTTPException) as ctx:
            require_access_token(None, configured_token="secret")

        self.assertEqual(ctx.exception.status_code, 401)

    def test_access_token_rejects_wrong_value(self):
        with self.assertRaises(HTTPException) as ctx:
            require_access_token("wrong", configured_token="secret")

        self.assertEqual(ctx.exception.status_code, 401)

    def test_access_token_accepts_matching_value(self):
        self.assertIsNone(require_access_token("secret", configured_token="secret"))


class RateLimitTests(unittest.TestCase):
    def test_rate_limit_allows_requests_within_limit(self):
        buckets = {"client": deque([1.0])}

        self.assertIsNone(
            check_rate_limit(
                "client",
                now=2.0,
                limit=2,
                window_seconds=60,
                buckets=buckets,
            )
        )

    def test_rate_limit_rejects_requests_over_limit(self):
        buckets = {"client": deque([1.0, 2.0])}

        with self.assertRaises(HTTPException) as ctx:
            check_rate_limit(
                "client",
                now=3.0,
                limit=2,
                window_seconds=60,
                buckets=buckets,
            )

        self.assertEqual(ctx.exception.status_code, 429)

    def test_rate_limit_expires_old_requests(self):
        buckets = {"client": deque([1.0, 2.0])}

        self.assertIsNone(
            check_rate_limit(
                "client",
                now=63.0,
                limit=2,
                window_seconds=60,
                buckets=buckets,
            )
        )
        self.assertEqual(list(buckets["client"]), [63.0])


class FavoritesStorageTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        self.db_path = tmp.name
        self._orig_path = storage.LCT_DB_PATH
        storage.LCT_DB_PATH = self.db_path
        storage.init_db()

    def tearDown(self):
        storage.LCT_DB_PATH = self._orig_path
        os.unlink(self.db_path)

    def test_upsert_dedups_case_insensitively_and_orders_newest_first(self):
        storage.upsert_favorite("default", {"query": "Watch", "lang": "en", "timestamp": 1})
        storage.upsert_favorite(
            "default", {"query": "watch", "lang": "en", "coreTranslation": "看", "timestamp": 2}
        )
        storage.upsert_favorite("default", {"query": "これ", "lang": "ja", "timestamp": 3})

        favs = storage.list_favorites("default")
        self.assertEqual(len(favs), 2)  # Watch/watch 折叠为一条
        self.assertEqual([f["query"] for f in favs], ["これ", "watch"])  # 倒序
        en = next(f for f in favs if f["lang"] == "en")
        self.assertEqual(en["coreTranslation"], "看")  # payload 被更新

    def test_delete_is_case_insensitive(self):
        storage.upsert_favorite("default", {"query": "Apple", "lang": "en"})
        storage.delete_favorite("default", "en", "APPLE")
        self.assertEqual(storage.list_favorites("default"), [])

    def test_bulk_import_skips_blank_queries(self):
        imported = storage.bulk_import(
            "default", [{"query": "a", "lang": "en"}, {"query": "  ", "lang": "en"}]
        )
        self.assertEqual(imported, 1)
        self.assertEqual(len(storage.list_favorites("default")), 1)

    def test_users_are_isolated(self):
        storage.upsert_favorite("default", {"query": "a", "lang": "en"})
        storage.upsert_favorite("alice", {"query": "b", "lang": "en"})
        self.assertEqual(len(storage.list_favorites("default")), 1)
        self.assertEqual(len(storage.list_favorites("alice")), 1)

    def test_get_favorite_and_set_audio_fields(self):
        storage.upsert_favorite("default", {"query": "Apple", "lang": "en"})
        got = storage.get_favorite("default", "en", "APPLE")
        self.assertIsNotNone(got)
        self.assertEqual(got["query"], "Apple")

        updated = storage.set_favorite_audio(
            "default", "en", "apple", "tts/default/en/abc.mp3", "alloy"
        )
        self.assertEqual(updated["audioKey"], "tts/default/en/abc.mp3")
        self.assertEqual(updated["audioVoice"], "alloy")
        again = storage.get_favorite("default", "en", "apple")
        self.assertEqual(again["audioKey"], "tts/default/en/abc.mp3")


class CosAudioKeyTests(unittest.TestCase):
    def test_audio_object_key_is_stable_and_hash_based(self):
        from cos_audio import build_audio_key

        k1 = build_audio_key("default", "en", "  Apple ", "alloy")
        k2 = build_audio_key("default", "en", "apple", "alloy")
        self.assertEqual(k1, k2)
        self.assertTrue(k1.startswith("tts/default/en/"))
        self.assertTrue(k1.endswith(".mp3"))
        self.assertNotIn("Apple", k1)
        # 文件名是 hash，不含原文
        self.assertNotIn("apple", k1.split("/")[-1])


class EnsureFavoriteAudioTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        self.db_path = tmp.name
        self._orig_path = storage.LCT_DB_PATH
        storage.LCT_DB_PATH = self.db_path
        storage.init_db()

    def tearDown(self):
        storage.LCT_DB_PATH = self._orig_path
        os.unlink(self.db_path)

    async def test_ensure_uploads_and_writes_audio_key(self):
        from unittest.mock import AsyncMock, patch

        from app import ensure_favorite_audio

        item = {"query": "hello", "lang": "en"}
        storage.upsert_favorite("default", item)

        from cos_audio import build_audio_key

        with (
            patch("app.TTS_VOICE", "nova"),
            patch("app.cos_configured", return_value=True),
            patch("app.tts_configured", return_value=True),
            patch("app.download_audio", return_value=None),
            patch("app.upload_audio") as mock_upload,
            patch(
                "app.synthesize_tts",
                new=AsyncMock(return_value=(b"ID3fake-mp3", "youdao-us")),
            ),
        ):
            result = await ensure_favorite_audio("default", dict(item))

        # 对象 key 仍按 TTS 音色算，和切换前一致；audioVoice 记实际来源
        self.assertEqual(
            result.get("audioKey"), build_audio_key("default", "en", "hello", "nova")
        )
        self.assertEqual(result.get("audioVoice"), "youdao-us")
        mock_upload.assert_called_once()
        self.assertEqual(mock_upload.call_args.args[2], "audio/mpeg")
        stored = storage.get_favorite("default", "en", "hello")
        self.assertEqual(stored.get("audioKey"), result["audioKey"])
        self.assertEqual(stored.get("audioVoice"), "youdao-us")

    async def test_ensure_uploads_wav_with_wav_content_type(self):
        from unittest.mock import AsyncMock, patch

        from app import ensure_favorite_audio

        item = {"query": "set", "lang": "en"}
        storage.upsert_favorite("default", item)
        with (
            patch("app.cos_configured", return_value=True),
            patch("app.tts_configured", return_value=True),
            patch("app.download_audio", return_value=None),
            patch("app.upload_audio") as mock_upload,
            patch(
                "app.synthesize_tts",
                new=AsyncMock(return_value=(b"RIFF\x00\x00WAVE", "youdao-us")),
            ),
        ):
            await ensure_favorite_audio("default", dict(item))

        self.assertEqual(mock_upload.call_args.args[2], "audio/wav")

    async def test_ensure_skips_when_cos_not_configured(self):
        from unittest.mock import AsyncMock, patch

        from app import ensure_favorite_audio

        item = {"query": "hello", "lang": "en"}
        with (
            patch("app.cos_configured", return_value=False),
            patch("app.synthesize_tts", new=AsyncMock()) as mock_tts,
        ):
            result = await ensure_favorite_audio("default", dict(item))

        self.assertNotIn("audioKey", result)
        mock_tts.assert_not_called()

    async def test_batch_ensure_only_fills_missing_audio(self):
        from unittest.mock import AsyncMock, patch

        from app import _missing_audio, ensure_favorite_audio

        storage.upsert_favorite(
            "default",
            {"query": "has", "lang": "en", "audioKey": "tts/default/en/x.mp3"},
        )
        storage.upsert_favorite("default", {"query": "miss", "lang": "en"})

        self.assertFalse(
            _missing_audio(storage.get_favorite("default", "en", "has"))
        )
        self.assertTrue(
            _missing_audio(storage.get_favorite("default", "en", "miss"))
        )

        with (
            patch("app.cos_configured", return_value=True),
            patch("app.tts_configured", return_value=True),
            patch("app.download_audio", return_value=None),
            patch("app.upload_audio"),
            patch(
                "app.synthesize_tts",
                new=AsyncMock(return_value=(b"ID3fake-mp3", "nova")),
            ) as mock_tts,
        ):
            items = storage.list_favorites("default")
            for item in items:
                if _missing_audio(item):
                    await ensure_favorite_audio("default", dict(item))

        self.assertEqual(mock_tts.await_count, 1)
        miss = storage.get_favorite("default", "en", "miss")
        self.assertTrue(miss.get("audioKey"))


class DeerapiProxyTests(unittest.TestCase):
    def test_no_proxy_by_default(self):
        with patch("app.DEERAPI_HTTP_PROXY", ""):
            self.assertEqual(deerapi_request_kwargs(), {})

    def test_proxy_only_attached_when_configured(self):
        with patch("app.DEERAPI_HTTP_PROXY", "http://127.0.0.1:7890"):
            self.assertEqual(
                deerapi_request_kwargs(),
                {"proxy": "http://127.0.0.1:7890"},
            )


class GptsapiProviderTests(unittest.TestCase):
    def test_gptsapi_never_attaches_proxy(self):
        with patch("app.DEERAPI_HTTP_PROXY", "http://127.0.0.1:7890"):
            self.assertEqual(gptsapi_request_kwargs(), {})

    def test_tts_request_kwargs_are_empty_when_provider_is_gptsapi(self):
        with (
            patch("app.TTS_PROVIDER", "gptsapi"),
            patch("app.DEERAPI_HTTP_PROXY", "http://127.0.0.1:7890"),
        ):
            self.assertEqual(tts_request_kwargs(), {})

    def test_tts_request_kwargs_keep_deerapi_proxy_when_provider_is_deerapi(self):
        with (
            patch("app.TTS_PROVIDER", "deerapi"),
            patch("app.DEERAPI_HTTP_PROXY", "http://127.0.0.1:7890"),
        ):
            self.assertEqual(
                tts_request_kwargs(),
                {"proxy": "http://127.0.0.1:7890"},
            )

    def test_tts_configured_reads_gptsapi_key(self):
        with patch("app.TTS_PROVIDER", "gptsapi"), patch("app.GPTSAPI_KEY", ""):
            self.assertFalse(tts_configured())
        with patch("app.TTS_PROVIDER", "gptsapi"), patch("app.GPTSAPI_KEY", "sk-x"):
            self.assertTrue(tts_configured())

    def test_tts_configured_reads_deerapi_key(self):
        with patch("app.TTS_PROVIDER", "deerapi"), patch("app.DEERAPI_KEY", ""):
            self.assertFalse(tts_configured())
        with patch("app.TTS_PROVIDER", "deerapi"), patch("app.DEERAPI_KEY", "sk-x"):
            self.assertTrue(tts_configured())

    def test_gptsapi_settings_use_tts1_and_gptsapi_host(self):
        with (
            patch("app.TTS_PROVIDER", "gptsapi"),
            patch("app.GPTSAPI_KEY", "sk-gpts"),
            patch("app.GPTSAPI_BASE_URL", "https://api.gptsapi.net/v1"),
        ):
            settings = tts_provider_settings()
        self.assertEqual(settings["key"], "sk-gpts")
        self.assertEqual(settings["base_url"], "https://api.gptsapi.net/v1")
        self.assertEqual(settings["model"], "tts-1")
        self.assertEqual(settings["request_kwargs"], {})

    def test_deerapi_settings_keep_mini_tts_and_proxy(self):
        with (
            patch("app.TTS_PROVIDER", "deerapi"),
            patch("app.DEERAPI_KEY", "sk-deer"),
            patch("app.DEERAPI_BASE_URL", "https://api.deerapi.com/v1"),
            patch("app.DEERAPI_HTTP_PROXY", "http://127.0.0.1:7890"),
        ):
            settings = tts_provider_settings()
        self.assertEqual(settings["key"], "sk-deer")
        self.assertEqual(settings["base_url"], "https://api.deerapi.com/v1")
        self.assertEqual(settings["model"], "gpt-4o-mini-tts")
        self.assertEqual(settings["request_kwargs"], {"proxy": "http://127.0.0.1:7890"})


class GenerateTtsBytesProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_tts_posts_to_gptsapi_without_proxy(self):
        from app import app

        class _Resp:
            status = 200

            async def read(self):
                return b"ID3fake-mp3"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class _Session:
            def __init__(self):
                self.calls = []

            def post(self, url, json=None, headers=None, **kwargs):
                self.calls.append(
                    {"url": url, "json": json, "headers": headers, "kwargs": kwargs}
                )
                return _Resp()

        session = _Session()
        app.state.session = session
        with (
            patch("app.YOUDAO_TTS_ENABLED", False),
            patch("app.TTS_PROVIDER", "gptsapi"),
            patch("app.GPTSAPI_KEY", "sk-gpts"),
            patch("app.GPTSAPI_BASE_URL", "https://api.gptsapi.net/v1"),
            patch("app.TTS_VOICE", "nova"),
        ):
            audio = await generate_tts_bytes("hello")

        self.assertEqual(audio, b"ID3fake-mp3")
        self.assertEqual(len(session.calls), 1)
        call = session.calls[0]
        self.assertEqual(call["url"], "https://api.gptsapi.net/v1/audio/speech")
        self.assertEqual(call["json"]["model"], "tts-1")
        self.assertEqual(call["json"]["input"], "hello")
        self.assertEqual(call["json"]["voice"], "nova")
        self.assertEqual(call["headers"]["Authorization"], "Bearer sk-gpts")
        self.assertNotIn("proxy", call["kwargs"])

    async def test_generate_tts_posts_to_deerapi_with_proxy(self):
        from app import app

        class _Resp:
            status = 200

            async def read(self):
                return b"ID3deer"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class _Session:
            def __init__(self):
                self.calls = []

            def post(self, url, json=None, headers=None, **kwargs):
                self.calls.append(
                    {"url": url, "json": json, "headers": headers, "kwargs": kwargs}
                )
                return _Resp()

        session = _Session()
        app.state.session = session
        with (
            patch("app.YOUDAO_TTS_ENABLED", False),
            patch("app.TTS_PROVIDER", "deerapi"),
            patch("app.DEERAPI_KEY", "sk-deer"),
            patch("app.DEERAPI_BASE_URL", "https://api.deerapi.com/v1"),
            patch("app.DEERAPI_HTTP_PROXY", "http://127.0.0.1:7890"),
        ):
            audio = await generate_tts_bytes("hello", voice="alloy")

        self.assertEqual(audio, b"ID3deer")
        call = session.calls[0]
        self.assertEqual(call["url"], "https://api.deerapi.com/v1/audio/speech")
        self.assertEqual(call["json"]["model"], "gpt-4o-mini-tts")
        self.assertEqual(call["kwargs"].get("proxy"), "http://127.0.0.1:7890")


class YoudaoTextRulesTests(unittest.TestCase):
    def test_single_english_word_is_kept_as_is(self):
        # 大小写原样保留：有道对专名区分大小写（nietzsche 会 500，Nietzsche 有录音）
        for text in ["serendipity", "Nietzsche", "well-being", "state-of-the-art",
                     "don't", "don’t", "C++", "3D", "café", "naïve", ".NET", "e-mail"]:
            self.assertEqual(youdao_word(text), text, text)

    def test_trailing_dot_kept_only_for_dotted_abbreviations(self):
        # 有道 U.S.A. 有录音、U.S.A 是 500；a.m. 是录音、a.m 是机器音
        self.assertEqual(youdao_word("U.S.A."), "U.S.A.")
        self.assertEqual(youdao_word("a.m."), "a.m.")
        self.assertEqual(youdao_word("(U.S.)"), "U.S.")
        self.assertEqual(youdao_word("etc."), "etc")
        self.assertEqual(youdao_word("Dr."), "Dr")
        self.assertEqual(youdao_word("end..."), "end")

    def test_decomposed_accents_are_normalized(self):
        self.assertEqual(youdao_word("café"), "café")

    def test_surrounding_punctuation_and_spaces_are_stripped(self):
        self.assertEqual(youdao_word("  apple  "), "apple")
        self.assertEqual(youdao_word("apple."), "apple")
        self.assertEqual(youdao_word("(apple)"), "apple")
        self.assertEqual(youdao_word("“apple,”"), "apple")
        self.assertEqual(youdao_word("students’"), "students")
        self.assertEqual(youdao_word("Wait!"), "Wait")

    def test_phrases_sentences_and_non_english_are_rejected(self):
        for text in [None, "", "   ", "look up", "take into account", "rock & roll",
                     "How are you?", "It's raining cats and dogs.", "Hello, world",
                     "...", "-", "2024", "こんにちは", "食べる", "你好", "C#", "a/b"]:
            self.assertIsNone(youdao_word(text), text)

    def test_audio_sniffing(self):
        self.assertTrue(is_audio_bytes(b"ID3\x03rest"))
        self.assertTrue(is_audio_bytes(b"RIFF\x00\x00WAVE"))
        self.assertTrue(is_audio_bytes(b"\xff\xf3\x84\xc4"))
        self.assertTrue(is_audio_bytes(b"\xff\xfb\x90\x64"))
        self.assertFalse(is_audio_bytes(b"\xff\x00\x00\x00"))
        # UTF-16LE BOM 也是 0xFF 开头，但不是 Layer III 帧
        self.assertFalse(is_audio_bytes(b"\xff\xfe{\x00"))
        self.assertFalse(is_audio_bytes(b'{"status":500}'))
        self.assertFalse(is_audio_bytes(b"<html>"))
        self.assertFalse(is_audio_bytes(b"ID3"))
        self.assertFalse(is_audio_bytes(b""))
        self.assertEqual(audio_media_type(b"RIFF\x00\x00WAVE"), "audio/wav")
        self.assertEqual(audio_media_type(b"ID3\x03rest"), "audio/mpeg")
        self.assertEqual(audio_media_type(b"\xff\xf3\x84\xc4"), "audio/mpeg")

    def test_machine_audio_detection(self):
        self.assertTrue(is_youdao_machine_audio(b"\xff\xf3\x84\xc4"))  # MPEG-2 裸帧
        self.assertTrue(is_youdao_machine_audio(b"\xff\xe3\x84\xc4"))  # MPEG-2.5 裸帧
        self.assertFalse(is_youdao_machine_audio(b"\xff\xfb\x90\x64"))  # MPEG-1，词典录音
        self.assertFalse(is_youdao_machine_audio(b"ID3\x03rest"))
        self.assertFalse(is_youdao_machine_audio(b"RIFF\x00\x00WAVE"))
        self.assertFalse(is_youdao_machine_audio(b'{"status":500}'))
        self.assertFalse(is_youdao_machine_audio(b""))


YOUDAO_MISS = (500, b'{"msg":"returned null audio"}')
YOUDAO_RECORDING = (200, b"ID3recording")
YOUDAO_MACHINE = (200, b"\xff\xf3\x84\xc4machine")
YOUDAO_WAV = (200, b"RIFF\x00\x00WAVE")


class SynthesizeTtsYoudaoTests(unittest.IsolatedAsyncioTestCase):
    """单词走有道、失败或词组/句子回退 gptsapi 的分流逻辑"""

    def setUp(self):
        import app as app_module

        app_module._youdao_skip_until = 0.0

    def tearDown(self):
        import app as app_module

        app_module._youdao_skip_until = 0.0

    def _session(self, youdao=None, youdao_error=None):
        """youdao: {查询词: (status, body)}，没列出的词回 (200, b"ID3youdao")"""
        youdao = youdao or {}

        class _Resp:
            def __init__(self, status, body):
                self.status = status
                self._body = body

            async def read(self):
                return self._body

            async def text(self):
                return self._body.decode("utf-8", "replace")

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        class _Session:
            def __init__(self):
                self.gets = []
                self.posts = []

            def get(self, url, params=None, **kwargs):
                self.gets.append({"url": url, "params": params, "kwargs": kwargs})
                if youdao_error:
                    raise youdao_error
                status, body = youdao.get(params["audio"], (200, b"ID3youdao"))
                return _Resp(status, body)

            def post(self, url, json=None, headers=None, **kwargs):
                self.posts.append(
                    {"url": url, "json": json, "headers": headers, "kwargs": kwargs}
                )
                return _Resp(200, b"ID3nova")

            def queried(self):
                return [g["params"]["audio"] for g in self.gets]

        return _Session()

    async def _synthesize(self, session, text, accent="us", enabled=True, key="sk-gpts"):
        from app import app, synthesize_tts

        app.state.session = session
        with (
            patch("app.YOUDAO_TTS_ENABLED", enabled),
            patch("app.YOUDAO_TTS_ACCENT", accent),
            patch("app.TTS_PROVIDER", "gptsapi"),
            patch("app.GPTSAPI_KEY", key),
            patch("app.GPTSAPI_BASE_URL", "https://api.gptsapi.net/v1"),
            patch("app.TTS_VOICE", "nova"),
        ):
            return await synthesize_tts(text)

    async def test_word_uses_youdao_and_skips_provider(self):
        from app import YOUDAO_TIMEOUT

        session = self._session()
        audio, voice = await self._synthesize(session, "serendipity")
        self.assertEqual((audio, voice), (b"ID3youdao", "youdao-us"))
        self.assertEqual(session.gets[0]["url"], "https://dict.youdao.com/dictvoice")
        self.assertEqual(session.gets[0]["params"], {"audio": "serendipity", "type": "2"})
        self.assertIs(session.gets[0]["kwargs"].get("timeout"), YOUDAO_TIMEOUT)
        self.assertEqual(session.posts, [])

    async def test_youdao_works_without_tts_key(self):
        session = self._session()
        self.assertEqual(
            await self._synthesize(session, "apple", key=""), (b"ID3youdao", "youdao-us")
        )
        with self.assertRaises(HTTPException) as ctx:
            await self._synthesize(self._session(), "look up", key="")
        self.assertEqual(ctx.exception.status_code, 500)

    async def test_youdao_gets_word_without_surrounding_punctuation(self):
        session = self._session()
        await self._synthesize(session, "  (Apple.)  ")
        # 原形已是录音，不再查小写
        self.assertEqual(session.queried(), ["Apple"])

    async def test_uk_accent_uses_type_1(self):
        session = self._session()
        _, voice = await self._synthesize(session, "schedule", accent="uk")
        self.assertEqual(session.gets[0]["params"]["type"], "1")
        self.assertEqual(voice, "youdao-uk")

    async def test_capitalized_machine_audio_retries_lowercase_recording(self):
        session = self._session({"Warning": YOUDAO_MACHINE, "warning": YOUDAO_RECORDING})
        audio, voice = await self._synthesize(session, "Warning")
        self.assertEqual((audio, voice), (YOUDAO_RECORDING[1], "youdao-us"))
        self.assertEqual(session.queried(), ["Warning", "warning"])

    async def test_capitalized_miss_retries_lowercase(self):
        session = self._session({"Running": YOUDAO_MISS, "running": YOUDAO_RECORDING})
        audio, _ = await self._synthesize(session, "Running")
        self.assertEqual(audio, YOUDAO_RECORDING[1])

    async def test_capitalized_recording_is_kept_without_retry(self):
        # Polish（波兰的）和 polish（擦亮）读音不同，原形有录音就不能换成小写
        session = self._session({"Polish": YOUDAO_WAV, "polish": YOUDAO_RECORDING})
        audio, _ = await self._synthesize(session, "Polish")
        self.assertEqual(audio, YOUDAO_WAV[1])
        self.assertEqual(session.queried(), ["Polish"])

    async def test_machine_audio_for_both_cases_keeps_original(self):
        session = self._session({"ChatGPT": YOUDAO_MACHINE, "chatgpt": (200, b"\xff\xf3\x00\x00lower")})
        audio, voice = await self._synthesize(session, "ChatGPT")
        self.assertEqual((audio, voice), (YOUDAO_MACHINE[1], "youdao-us"))
        self.assertEqual(session.posts, [])

    async def test_capitalized_machine_audio_kept_when_lowercase_misses(self):
        session = self._session({"Kubernetes": YOUDAO_MACHINE, "kubernetes": YOUDAO_MISS})
        audio, _ = await self._synthesize(session, "Kubernetes")
        self.assertEqual(audio, YOUDAO_MACHINE[1])

    async def test_lowercase_machine_audio_is_used_without_retry(self):
        session = self._session({"doomscrolling": YOUDAO_MACHINE})
        audio, _ = await self._synthesize(session, "doomscrolling")
        self.assertEqual(audio, YOUDAO_MACHINE[1])
        self.assertEqual(session.queried(), ["doomscrolling"])

    async def test_youdao_miss_falls_back_to_provider_with_original_text(self):
        session = self._session({"Pontryagin": YOUDAO_MISS, "pontryagin": YOUDAO_MISS})
        audio, voice = await self._synthesize(session, "Pontryagin.")
        self.assertEqual((audio, voice), (b"ID3nova", "nova"))
        self.assertEqual(session.queried(), ["Pontryagin", "pontryagin"])
        # 回退请求和切换前一致：原文（不是剥过标点的查询词）、nova、Bearer key、不走代理
        post = session.posts[0]
        self.assertEqual(post["url"], "https://api.gptsapi.net/v1/audio/speech")
        self.assertEqual(post["json"], {"model": "tts-1", "input": "Pontryagin.", "voice": "nova"})
        self.assertEqual(post["headers"]["Authorization"], "Bearer sk-gpts")
        self.assertEqual(post["kwargs"], {})

    async def test_youdao_non_audio_body_falls_back(self):
        session = self._session({"apple": (200, b"<html>blocked</html>")})
        self.assertEqual(await self._synthesize(session, "apple"), (b"ID3nova", "nova"))

    async def test_youdao_miss_does_not_pause_youdao(self):
        await self._synthesize(self._session({"Pontryagin": YOUDAO_MISS}), "Pontryagin")
        session = self._session()
        await self._synthesize(session, "apple")
        self.assertEqual(session.queried(), ["apple"])

    async def test_youdao_network_error_falls_back_and_pauses_youdao(self):
        import aiohttp

        import app as app_module

        session = self._session(youdao_error=aiohttp.ClientConnectionError("down"))
        self.assertEqual(await self._synthesize(session, "Apple"), (b"ID3nova", "nova"))
        # 出错后同一次请求里不再查小写，之后的词也直接走 TTS，直到冷却结束
        self.assertEqual(session.queried(), ["Apple"])
        later = self._session()
        self.assertEqual(await self._synthesize(later, "banana"), (b"ID3nova", "nova"))
        self.assertEqual(later.gets, [])

        app_module._youdao_skip_until = 0.0
        recovered = self._session()
        self.assertEqual(
            await self._synthesize(recovered, "banana"), (b"ID3youdao", "youdao-us")
        )

    async def test_youdao_timeout_falls_back_and_pauses_youdao(self):
        import asyncio

        session = self._session(youdao_error=asyncio.TimeoutError())
        self.assertEqual(await self._synthesize(session, "apple"), (b"ID3nova", "nova"))
        later = self._session()
        await self._synthesize(later, "banana")
        self.assertEqual(later.gets, [])

    async def test_phrases_and_sentences_go_straight_to_provider(self):
        for text in ["look up", "take into account",
                     "The quick brown fox jumps over the lazy dog."]:
            session = self._session()
            audio, voice = await self._synthesize(session, text)
            self.assertEqual((audio, voice), (b"ID3nova", "nova"), text)
            self.assertEqual(session.gets, [], text)
            self.assertEqual(session.posts[0]["json"]["input"], text)

    async def test_japanese_goes_straight_to_provider(self):
        session = self._session()
        await self._synthesize(session, "たべる")
        self.assertEqual(session.gets, [])

    async def test_youdao_disabled_goes_straight_to_provider(self):
        session = self._session()
        result = await self._synthesize(session, "apple", enabled=False)
        self.assertEqual(result, (b"ID3nova", "nova"))
        self.assertEqual(session.gets, [])

    async def test_too_long_text_is_rejected_before_any_request(self):
        session = self._session()
        with self.assertRaises(HTTPException) as ctx:
            await self._synthesize(session, "a" * 601)
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertEqual((session.gets, session.posts), ([], []))

    async def test_generate_tts_bytes_returns_only_audio(self):
        from app import app

        app.state.session = self._session()
        with (
            patch("app.YOUDAO_TTS_ENABLED", True),
            patch("app.YOUDAO_TTS_ACCENT", "us"),
            patch("app.GPTSAPI_KEY", ""),
        ):
            self.assertEqual(await generate_tts_bytes("apple"), b"ID3youdao")


class AudioEndpointMediaTypeTests(unittest.IsolatedAsyncioTestCase):
    """有道的 WAV 要以 audio/wav 返回，其余仍是 audio/mpeg"""

    def setUp(self):
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        self.db_path = tmp.name
        self._orig_path = storage.LCT_DB_PATH
        storage.LCT_DB_PATH = self.db_path
        storage.init_db()

    def tearDown(self):
        storage.LCT_DB_PATH = self._orig_path
        os.unlink(self.db_path)

    async def test_tts_endpoint_media_type_follows_audio_bytes(self):
        from unittest.mock import AsyncMock

        from app import TTSRequest, text_to_speech

        for body, media_type in [(YOUDAO_WAV[1], "audio/wav"), (b"ID3nova", "audio/mpeg")]:
            with patch("app.generate_tts_bytes", new=AsyncMock(return_value=body)):
                resp = await text_to_speech(TTSRequest(text="set"))
            self.assertEqual(resp.media_type, media_type)
            self.assertEqual(resp.body, body)

    async def test_favorite_audio_endpoint_media_type_follows_audio_bytes(self):
        from app import get_favorite_audio

        storage.upsert_favorite(
            "default", {"query": "set", "lang": "en", "audioKey": "tts/default/en/x.mp3"}
        )
        for body, media_type in [(YOUDAO_WAV[1], "audio/wav"), (b"ID3nova", "audio/mpeg")]:
            with (
                patch("app.cos_configured", return_value=True),
                patch("app.download_audio", return_value=body),
            ):
                resp = await get_favorite_audio(
                    query="set", lang="en", voice="", user_id="default"
                )
            self.assertEqual(resp.media_type, media_type)


class UserResolutionTests(unittest.TestCase):
    def test_resolve_user_id_is_single_user_for_now(self):
        # 多用户预留：当前任何 token 都归到 default 用户
        self.assertEqual(resolve_user_id(None), "default")
        self.assertEqual(resolve_user_id("any-token"), "default")


if __name__ == "__main__":
    unittest.main()
