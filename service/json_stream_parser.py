"""
增量 JSON 流解析器
将 LLM 逐字符输出的 JSON 文本实时解析为结构化 SSE 事件
"""

import json
from typing import Any, Optional

# LLM 输出 JSON 的已知字段顺序
SIMPLE_FIELDS = ("query", "isWord", "phonetic")
STREAMING_FIELDS = ("translation",)
COMPLEX_FIELDS = ("definitions", "contextAnalysis", "keyExpressions")
ALL_FIELDS = SIMPLE_FIELDS + STREAMING_FIELDS + COMPLEX_FIELDS
CONTEXT_STREAMING_SUBFIELDS = ("coreTranslation", "analysis", "usage")


class JsonStreamParser:
    """增量 JSON 解析器，已知 schema，逐字段检测完成度并发射事件"""

    def __init__(self):
        self.buffer: str = ""
        self.emitted_fields: set[str] = set()
        self.last_translation_len: int = 0
        self.last_context_lens: dict[str, int] = {
            name: 0 for name in CONTEXT_STREAMING_SUBFIELDS
        }
        self.is_done: bool = False

    def feed(self, chunk: str) -> list[dict]:
        """喂入新 chunk，返回待发射的 SSE 事件列表"""
        self.buffer += chunk
        events: list[dict] = []

        if self.is_done:
            return events

        # 1. 尝试完整解析
        try:
            full = json.loads(self.buffer)
            events.extend(self._emit_remaining(full))
            events.append({"type": "done", "data": full})
            self.is_done = True
            return events
        except json.JSONDecodeError:
            pass

        # 2. 简单字段：完成后立即发射
        for name in SIMPLE_FIELDS:
            if name not in self.emitted_fields:
                val = self._try_extract_value(name)
                if val is not None:
                    self.emitted_fields.add(name)
                    events.append({"type": "field", "name": name, "value": val})

        # 3. translation：增量文本流（打字机效果）
        if "translation" not in self.emitted_fields:
            partial = self._extract_partial_string("translation")
            if partial is not None and len(partial) > self.last_translation_len:
                self.last_translation_len = len(partial)
                events.append({"type": "text", "name": "translation", "value": partial})
            # 检查是否已完成
            complete = self._try_extract_value("translation")
            if complete is not None:
                self.emitted_fields.add("translation")

        # 4. 复杂字段：完整后才发射
        for name in COMPLEX_FIELDS:
            if name not in self.emitted_fields:
                val = self._try_extract_complex(name)
                if val is not None:
                    self.emitted_fields.add(name)
                    events.append({"type": "field", "name": name, "value": val})

        # 5. contextAnalysis 子字段：增量文本流（打字机效果）
        if "contextAnalysis" not in self.emitted_fields:
            for subfield in CONTEXT_STREAMING_SUBFIELDS:
                partial = self._extract_context_subfield_partial(subfield)
                if partial is not None and len(partial) > self.last_context_lens[subfield]:
                    self.last_context_lens[subfield] = len(partial)
                    events.append({
                        "type": "text",
                        "name": f"contextAnalysis.{subfield}",
                        "value": partial,
                    })

        return events

    def _emit_remaining(self, full: dict) -> list[dict]:
        """发射所有尚未发射的字段"""
        events = []
        for name in ALL_FIELDS:
            if name not in self.emitted_fields and name in full:
                event_type = "text" if name in STREAMING_FIELDS else "field"
                events.append({"type": event_type, "name": name, "value": full[name]})
                self.emitted_fields.add(name)
        return events

    def _find_key_colon(self, name: str) -> Optional[int]:
        """找到 "name": 之后的位置（value 起始处）"""
        pattern = f'"{name}"'
        key_pos = self.buffer.find(pattern)
        if key_pos == -1:
            return None
        colon_pos = self.buffer.find(":", key_pos + len(pattern))
        if colon_pos == -1:
            return None
        return colon_pos + 1

    def _try_extract_value(self, name: str) -> Any:
        """尝试提取一个已完成的 JSON 值（简单类型 + 字符串）"""
        value_start = self._find_key_colon(name)
        if value_start is None:
            return None

        # 跳过空白
        pos = value_start
        while pos < len(self.buffer) and self.buffer[pos] in " \t\n\r":
            pos += 1
        if pos >= len(self.buffer):
            return None

        char = self.buffer[pos]

        if char == '"':
            return self._extract_complete_string(pos)
        elif char in "0123456789-":
            return self._extract_number(pos)
        elif self.buffer[pos : pos + 4] == "true":
            return self._validate_literal(pos, 4, True)
        elif self.buffer[pos : pos + 5] == "false":
            return self._validate_literal(pos, 5, False)
        elif self.buffer[pos : pos + 4] == "null":
            return self._validate_literal(pos, 4, None)
        return None

    def _validate_literal(self, pos: int, length: int, value: Any) -> Any:
        """验证字面值后面跟着 , 或 }"""
        end = pos + length
        if end > len(self.buffer):
            return None
        rest = self.buffer[end:].lstrip()
        if rest and rest[0] in ",}":
            return value
        return None

    def _extract_complete_string(self, pos: int) -> Optional[str]:
        """提取一个完整的 JSON 字符串值（必须已关闭引号且后跟 , 或 }）"""
        i = pos + 1
        while i < len(self.buffer):
            if self.buffer[i] == "\\":
                i += 2
                continue
            if self.buffer[i] == '"':
                # 找到闭合引号，检查后续字符
                rest = self.buffer[i + 1 :].lstrip()
                if rest and rest[0] in ",}":
                    try:
                        return json.loads(self.buffer[pos : i + 1])
                    except json.JSONDecodeError:
                        return None
                return None
            i += 1
        return None

    def _extract_number(self, pos: int) -> Optional[Any]:
        """提取一个数字值"""
        i = pos
        while i < len(self.buffer) and self.buffer[i] in "0123456789.-eE+":
            i += 1
        if i >= len(self.buffer):
            return None
        rest = self.buffer[i:].lstrip()
        if rest and rest[0] in ",}":
            try:
                return json.loads(self.buffer[pos:i])
            except json.JSONDecodeError:
                return None
        return None

    def _extract_partial_string(self, name: str) -> Optional[str]:
        """提取字符串字段的部分内容（用于打字机效果）"""
        value_start = self._find_key_colon(name)
        if value_start is None:
            return None

        # 找到开头引号
        rest = self.buffer[value_start:].lstrip()
        if not rest or rest[0] != '"':
            return None

        quote_pos = self.buffer.index('"', value_start)
        content_start = quote_pos + 1

        # 扫描到闭合引号或 buffer 末尾
        i = content_start
        while i < len(self.buffer):
            if self.buffer[i] == "\\":
                i += 2
                continue
            if self.buffer[i] == '"':
                # 闭合引号 — 提取完整内容
                raw = self.buffer[content_start:i]
                return self._decode_json_string(raw)
            i += 1

        # 未闭合 — 提取当前部分内容
        raw = self.buffer[content_start:]
        # 如果末尾有不完整的转义序列，截断
        if raw.endswith("\\"):
            raw = raw[:-1]
        return self._decode_json_string(raw)

    def _find_context_analysis_start(self) -> Optional[int]:
        """找到 contextAnalysis 对象的 { 位置"""
        value_start = self._find_key_colon("contextAnalysis")
        if value_start is None:
            return None
        pos = value_start
        while pos < len(self.buffer) and self.buffer[pos] in " \t\n\r":
            pos += 1
        if pos >= len(self.buffer) or self.buffer[pos] != "{":
            return None
        return pos

    def _extract_context_subfield_partial(self, subfield: str) -> Optional[str]:
        """提取 contextAnalysis 子字段的部分内容（用于打字机效果）"""
        ctx_start = self._find_context_analysis_start()
        if ctx_start is None:
            return None

        # 在 contextAnalysis 对象内搜索子字段 key
        pattern = f'"{subfield}"'
        key_pos = self.buffer.find(pattern, ctx_start)
        if key_pos == -1:
            return None

        colon_pos = self.buffer.find(":", key_pos + len(pattern))
        if colon_pos == -1:
            return None

        # 跳过空白，找到开头引号
        vpos = colon_pos + 1
        while vpos < len(self.buffer) and self.buffer[vpos] in " \t\n\r":
            vpos += 1
        if vpos >= len(self.buffer) or self.buffer[vpos] != '"':
            return None

        # 提取字符串内容（可以是部分的）
        content_start = vpos + 1
        i = content_start
        while i < len(self.buffer):
            if self.buffer[i] == "\\":
                i += 2
                continue
            if self.buffer[i] == '"':
                # 闭合引号 — 提取完整内容
                raw = self.buffer[content_start:i]
                return self._decode_json_string(raw)
            i += 1

        # 未闭合 — 提取当前部分内容
        raw = self.buffer[content_start:]
        if raw.endswith("\\"):
            raw = raw[:-1]
        return self._decode_json_string(raw)

    def _try_extract_complex(self, name: str) -> Any:
        """提取复杂类型（数组/对象），使用括号深度计数"""
        value_start = self._find_key_colon(name)
        if value_start is None:
            return None

        pos = value_start
        while pos < len(self.buffer) and self.buffer[pos] in " \t\n\r":
            pos += 1
        if pos >= len(self.buffer):
            return None

        char = self.buffer[pos]
        # null 值
        if self.buffer[pos : pos + 4] == "null":
            return self._validate_literal(pos, 4, None)
        if char not in "[{":
            return None

        close_char = "]" if char == "[" else "}"
        depth = 0
        in_string = False
        i = pos

        while i < len(self.buffer):
            c = self.buffer[i]
            if in_string:
                if c == "\\":
                    i += 2
                    continue
                if c == '"':
                    in_string = False
            else:
                if c == '"':
                    in_string = True
                elif c == char:
                    depth += 1
                elif c == close_char:
                    depth -= 1
                    if depth == 0:
                        candidate = self.buffer[pos : i + 1]
                        try:
                            return json.loads(candidate)
                        except json.JSONDecodeError:
                            return None
            i += 1
        return None

    @staticmethod
    def _decode_json_string(raw: str) -> str:
        """解码 JSON 字符串中的转义序列"""
        try:
            return json.loads('"' + raw + '"')
        except json.JSONDecodeError:
            # 末尾可能有不完整的转义，逐步截断重试
            for trim in range(1, min(7, len(raw) + 1)):
                try:
                    return json.loads('"' + raw[:-trim] + '"')
                except json.JSONDecodeError:
                    continue
            # 最终回退：基本反转义
            return (
                raw.replace('\\"', '"')
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace("\\\\", "\\")
            )
