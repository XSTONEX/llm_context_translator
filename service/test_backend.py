import json
from collections import deque
import unittest

from app import build_chat_payload, check_rate_limit, require_access_token
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


if __name__ == "__main__":
    unittest.main()
