import json
import re
from contextlib import asynccontextmanager
from typing import AsyncGenerator, List, Optional

import aiohttp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import SILICONFLOW_API_KEY, LLM_API_BASE_URL
from json_stream_parser import JsonStreamParser
from models import DEFAULT_MODEL, get_models_response, model_supports_thinking, resolve_model
from prompts import (
    SENTENCE_SYSTEM_PROMPT,
    WORD_SYSTEM_PROMPT,
    build_user_prompt,
    is_word_mode,
)

# ========== Pydantic 数据模型 ==========


class TranslateRequest(BaseModel):
    selected_text: str
    context_sentence: str = ""
    model: Optional[str] = None


class ExampleItem(BaseModel):
    sentence: str
    translation: str


class DefinitionItem(BaseModel):
    partOfSpeech: str
    meaning: str
    examples: List[ExampleItem] = []


class ContextAnalysis(BaseModel):
    coreTranslation: str = ""
    analysis: str = ""
    usage: str = ""


class TranslateResponse(BaseModel):
    query: str
    isWord: bool
    phonetic: Optional[str] = None
    translation: Optional[str] = None
    definitions: Optional[List[DefinitionItem]] = None
    contextAnalysis: Optional[ContextAnalysis] = None


# ========== aiohttp 会话生命周期 ==========


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.session = aiohttp.ClientSession()
    yield
    await app.state.session.close()


# ========== FastAPI 应用 ==========

app = FastAPI(title="LLM Context Translator", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========== LLM 响应解析 ==========


def parse_llm_response(content: str, selected_text: str, word_mode: bool) -> dict:
    """解析 LLM 返回的文本为 JSON，含容错处理"""
    # 尝试直接解析
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    # 尝试提取 markdown 代码块中的 JSON
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", content, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    raise ValueError(f"无法解析 LLM 返回内容为 JSON: {content[:200]}")


def ensure_response_fields(data: dict, selected_text: str, word_mode: bool) -> dict:
    """确保响应包含所有必需字段"""
    data.setdefault("query", selected_text)
    data.setdefault("isWord", word_mode)

    if word_mode:
        data.setdefault("phonetic", "")
        data.setdefault("definitions", [])
    else:
        data.setdefault("phonetic", None)
        data.setdefault("translation", "")
        data.setdefault("definitions", None)
        data.setdefault("keyExpressions", [])

    data.setdefault("contextAnalysis", {
        "coreTranslation": "",
        "analysis": "",
        "usage": "",
    })

    return data


# ========== 流式端点 ==========


async def stream_llm_response(
    session: aiohttp.ClientSession,
    selected_text: str,
    context_sentence: str,
    model: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """流式调用 LLM API，通过增量解析器输出结构化 SSE 事件"""
    word_mode = is_word_mode(selected_text)
    system_prompt = WORD_SYSTEM_PROMPT if word_mode else SENTENCE_SYSTEM_PROMPT
    user_prompt = build_user_prompt(selected_text, context_sentence)
    actual_model = resolve_model(model)

    url = f"{LLM_API_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": actual_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "stream": True,
        "temperature": 0.3,
    }
    if model_supports_thinking(actual_model):
        payload["enable_thinking"] = False

    parser = JsonStreamParser()

    try:
        async with session.post(url, json=payload, headers=headers) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                yield f"data: {json.dumps({'type': 'error', 'message': f'LLM API 返回 {resp.status}: {error_text[:200]}'})}\n\n"
                return

            async for line in resp.content:
                decoded = line.decode("utf-8").strip()
                if not decoded or not decoded.startswith("data: "):
                    continue

                data_str = decoded[6:]
                if data_str == "[DONE]":
                    break

                try:
                    chunk_data = json.loads(data_str)
                    delta = chunk_data.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        events = parser.feed(content)
                        for event in events:
                            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except json.JSONDecodeError:
                    continue

    except aiohttp.ClientError as e:
        yield f"data: {json.dumps({'type': 'error', 'message': f'LLM 服务请求失败: {str(e)}'})}\n\n"
        return

    # 兜底：如果解析器未完成（LLM 输出的 JSON 可能缺少闭合括号）
    if not parser.is_done:
        try:
            full_data = json.loads(parser.buffer)
        except json.JSONDecodeError:
            try:
                full_data = parse_llm_response(parser.buffer, selected_text, word_mode)
            except ValueError:
                yield f"data: {json.dumps({'type': 'error', 'message': '无法解析 LLM 返回的 JSON'})}\n\n"
                return

        full_data = ensure_response_fields(full_data, selected_text, word_mode)
        # 发射所有未发射的字段
        remaining = parser._emit_remaining(full_data)
        for event in remaining:
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'data': full_data}, ensure_ascii=False)}\n\n"


@app.post("/translate/stream")
async def translate_stream(req: TranslateRequest):
    """流式翻译端点（SSE）"""
    return StreamingResponse(
        stream_llm_response(
            app.state.session,
            req.selected_text,
            req.context_sentence,
            req.model,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ========== 非流式端点（调试用） ==========


@app.post("/translate", response_model=TranslateResponse)
async def translate(req: TranslateRequest):
    """非流式翻译端点"""
    word_mode = is_word_mode(req.selected_text)
    system_prompt = WORD_SYSTEM_PROMPT if word_mode else SENTENCE_SYSTEM_PROMPT
    user_prompt = build_user_prompt(req.selected_text, req.context_sentence)
    actual_model = resolve_model(req.model)

    url = f"{LLM_API_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": actual_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
    }
    if model_supports_thinking(actual_model):
        payload["enable_thinking"] = False

    try:
        async with app.state.session.post(url, json=payload, headers=headers) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                raise HTTPException(
                    status_code=502,
                    detail=f"LLM API 返回 {resp.status}: {error_text[:200]}",
                )
            result = await resp.json()
    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"LLM 服务请求失败: {str(e)}")

    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise HTTPException(status_code=500, detail="LLM 返回内容为空")

    try:
        data = parse_llm_response(content, req.selected_text, word_mode)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))

    data = ensure_response_fields(data, req.selected_text, word_mode)
    return data


# ========== 模型列表端点 ==========


@app.get("/api/models")
async def get_available_models():
    """返回可用模型列表，供前端下拉框使用"""
    return {
        "models": get_models_response(),
        "default": DEFAULT_MODEL["id"],
    }


# ========== 状态检测端点 ==========


@app.get("/api/status")
async def get_status():
    """供插件 popup 检测连通性并获取当前模型信息"""
    return {"status": "ok", "model": DEFAULT_MODEL["name"]}


# ========== 启动入口 ==========

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000)
