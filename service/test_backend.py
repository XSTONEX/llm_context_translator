import json
import os
import tempfile
from collections import deque
import unittest
from unittest.mock import patch

import storage
from app import (
    build_chat_payload,
    check_rate_limit,
    deerapi_request_kwargs,
    ensure_done_event_fields,
    require_access_token,
    resolve_user_id,
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

        with (
            patch("app.cos_configured", return_value=True),
            patch("app.DEERAPI_KEY", "fake-key"),
            patch("app.download_audio", return_value=None),
            patch("app.upload_audio") as mock_upload,
            patch(
                "app.generate_tts_bytes",
                new=AsyncMock(return_value=b"fake-mp3"),
            ),
        ):
            result = await ensure_favorite_audio("default", dict(item))

        self.assertTrue(result.get("audioKey", "").endswith(".mp3"))
        self.assertEqual(result.get("audioVoice"), "alloy")
        mock_upload.assert_called_once()
        stored = storage.get_favorite("default", "en", "hello")
        self.assertEqual(stored.get("audioKey"), result["audioKey"])

    async def test_ensure_skips_when_cos_not_configured(self):
        from unittest.mock import AsyncMock, patch

        from app import ensure_favorite_audio

        item = {"query": "hello", "lang": "en"}
        with (
            patch("app.cos_configured", return_value=False),
            patch("app.generate_tts_bytes", new=AsyncMock()) as mock_tts,
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
            patch("app.DEERAPI_KEY", "fake-key"),
            patch("app.download_audio", return_value=None),
            patch("app.upload_audio"),
            patch(
                "app.generate_tts_bytes",
                new=AsyncMock(return_value=b"fake-mp3"),
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


class UserResolutionTests(unittest.TestCase):
    def test_resolve_user_id_is_single_user_for_now(self):
        # 多用户预留：当前任何 token 都归到 default 用户
        self.assertEqual(resolve_user_id(None), "default")
        self.assertEqual(resolve_user_id("any-token"), "default")


if __name__ == "__main__":
    unittest.main()
