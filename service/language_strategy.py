"""
语言策略工厂
每种语言实现一套独立的策略，包括分词判断、Prompt 模板、Parser 字段配置和默认值填充。
新增语言只需：1) 新建 XxxStrategy 类  2) 注册到 _STRATEGIES 字典
"""

from abc import ABC, abstractmethod

from config import WORD_COUNT_THRESHOLD
from prompts import (
    JA_SENTENCE_SYSTEM_PROMPT,
    JA_WORD_SYSTEM_PROMPT,
    SENTENCE_SYSTEM_PROMPT,
    WORD_SYSTEM_PROMPT,
)


class LanguageStrategy(ABC):
    """语言处理策略基类"""

    @abstractmethod
    def is_word_mode(self, text: str) -> bool:
        """判断输入文本是单词模式还是句子模式"""

    @abstractmethod
    def get_word_prompt(self) -> str:
        """返回单词模式的 System Prompt"""

    @abstractmethod
    def get_sentence_prompt(self) -> str:
        """返回句子模式的 System Prompt"""

    @abstractmethod
    def get_schema_fields(self, word_mode: bool) -> tuple[str, ...]:
        """返回流式 JSON 解析器的 SIMPLE_FIELDS 元组"""

    @abstractmethod
    def build_user_prompt(self, selected_text: str, context_sentence: str) -> str:
        """构建发送给 LLM 的 User Prompt"""

    @abstractmethod
    def ensure_response_fields(self, data: dict, selected_text: str, word_mode: bool) -> dict:
        """确保 LLM 响应包含所有必需字段（兜底填充默认值）"""


class EnglishStrategy(LanguageStrategy):
    """英语处理策略"""

    def is_word_mode(self, text: str) -> bool:
        return len(text.strip().split()) <= WORD_COUNT_THRESHOLD

    def get_word_prompt(self) -> str:
        return WORD_SYSTEM_PROMPT

    def get_sentence_prompt(self) -> str:
        return SENTENCE_SYSTEM_PROMPT

    def get_schema_fields(self, word_mode: bool) -> tuple[str, ...]:
        return ("query", "isWord", "phonetic") if word_mode else ("query", "isWord")

    def build_user_prompt(self, selected_text: str, context_sentence: str) -> str:
        if context_sentence:
            return f"单词/文本：{selected_text}\n上下文句子：{context_sentence}"
        return f"单词/文本：{selected_text}"

    def ensure_response_fields(self, data: dict, selected_text: str, word_mode: bool) -> dict:
        data.setdefault("query", selected_text)
        data.setdefault("isWord", word_mode)
        if word_mode:
            data.setdefault("phonetic", "")
            data.setdefault("definitions", [])
        else:
            data.setdefault("translation", "")
            data.setdefault("keyExpressions", [])
            data.setdefault("syntaxAnalysis", {
                "inlineComponents": [],
                "structureExplanation": "",
            })
        data.setdefault("contextAnalysis", {
            "coreTranslation": "",
            "analysis": "",
            "usage": "",
        })
        return data


JA_WORD_CHAR_THRESHOLD = 10


class JapaneseStrategy(LanguageStrategy):
    """日语处理策略"""

    def is_word_mode(self, text: str) -> bool:
        return len(text.strip()) <= JA_WORD_CHAR_THRESHOLD

    def get_word_prompt(self) -> str:
        return JA_WORD_SYSTEM_PROMPT

    def get_sentence_prompt(self) -> str:
        return JA_SENTENCE_SYSTEM_PROMPT

    def get_schema_fields(self, word_mode: bool) -> tuple[str, ...]:
        if word_mode:
            return ("query", "isWord", "kana", "romaji", "dictionaryForm")
        return ("query", "isWord")

    def build_user_prompt(self, selected_text: str, context_sentence: str) -> str:
        if context_sentence:
            return f"日本語テキスト：{selected_text}\nコンテキスト文：{context_sentence}"
        return f"日本語テキスト：{selected_text}"

    def ensure_response_fields(self, data: dict, selected_text: str, word_mode: bool) -> dict:
        data.setdefault("query", selected_text)
        data.setdefault("isWord", word_mode)
        if word_mode:
            data.setdefault("kana", "")
            data.setdefault("romaji", "")
            # dictionaryForm 合法值包含 null，不设默认值
            data.setdefault("definitions", [])
        else:
            data.setdefault("translation", "")
            data.setdefault("keyExpressions", [])
            data.setdefault("syntaxAnalysis", {
                "inlineComponents": [],
                "structureExplanation": "",
            })
        data.setdefault("contextAnalysis", {
            "coreTranslation": "",
            "analysis": "",
            "usage": "",
        })
        return data


# ========== 策略工厂 ==========

_STRATEGIES: dict[str, LanguageStrategy] = {
    "en": EnglishStrategy(),
    "ja": JapaneseStrategy(),
}


def get_strategy(lang: str) -> LanguageStrategy:
    """根据语言代码获取对应的策略实例，未知语言 fallback 到英语"""
    return _STRATEGIES.get(lang, _STRATEGIES["en"])
