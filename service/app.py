import asyncio
import json
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Deque, List, Optional

import aiohttp
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from config import (
    DEERAPI_BASE_URL,
    DEERAPI_HTTP_PROXY,
    DEERAPI_KEY,
    LCT_ACCESS_TOKEN,
    LCT_RATE_LIMIT_REQUESTS,
    LCT_RATE_LIMIT_WINDOW_SECONDS,
    LLM_API_BASE_URL,
    SILICONFLOW_API_KEY,
    cos_configured,
)
import storage
from cos_audio import build_audio_key, delete_audio, download_audio, upload_audio
from json_stream_parser import JsonStreamParser
from language_strategy import get_strategy
from models import DEFAULT_MODEL, get_models_response, model_supports_thinking, resolve_model

log = logging.getLogger("lct.app")

# ========== Pydantic 数据模型 ==========


# 输入长度上限：防止误选超长文本触发高额付费调用（即使持有 token 也兜底）
MAX_TTS_CHARS = 600
MAX_TRANSLATE_CHARS = 4000


class TTSRequest(BaseModel):
    text: str
    voice: str = "alloy"


class TranslateRequest(BaseModel):
    selected_text: str
    context_sentence: str = ""
    model: Optional[str] = None
    lang: str = "en"


class FavoriteItem(BaseModel):
    """生词本条目：保留前端的完整收藏对象（允许额外字段，向前兼容）。"""

    query: str
    lang: str = "en"
    isWord: bool = False
    phonetic: str = ""
    coreTranslation: str = ""
    translation: str = ""
    definitions: list = []
    timestamp: Optional[float] = None
    id: Optional[str] = None

    model_config = {"extra": "allow"}


class FavoriteDeleteRequest(BaseModel):
    lang: str = "en"
    query: str


class FavoriteBulkRequest(BaseModel):
    favorites: List[FavoriteItem] = []


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


class SyntaxComponent(BaseModel):
    text: str
    role: str
    type: str
    isOmitted: bool = False


class SyntaxAnalysis(BaseModel):
    inlineComponents: List[SyntaxComponent] = []
    structureExplanation: str = ""


class KeyExpressionItem(BaseModel):
    phrase: str
    meaning: str


class TranslateResponse(BaseModel):
    query: str
    isWord: bool
    phonetic: Optional[str] = None
    translation: Optional[str] = None
    definitions: Optional[List[DefinitionItem]] = None
    contextAnalysis: Optional[ContextAnalysis] = None
    syntaxAnalysis: Optional[SyntaxAnalysis] = None
    keyExpressions: Optional[List[KeyExpressionItem]] = None


# ========== aiohttp 会话生命周期 ==========


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.init_db()
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


RATE_LIMIT_BUCKETS: dict[str, Deque[float]] = defaultdict(deque)


def require_access_token(
    x_lct_token: Optional[str] = Header(default=None),
    configured_token: str = LCT_ACCESS_TOKEN,
) -> None:
    """Require a shared extension token when LCT_ACCESS_TOKEN is configured."""
    if not configured_token:
        return
    if not x_lct_token or not secrets.compare_digest(x_lct_token, configured_token):
        raise HTTPException(status_code=401, detail="Invalid access token")


def check_rate_limit(
    client_id: str,
    now: Optional[float] = None,
    limit: int = LCT_RATE_LIMIT_REQUESTS,
    window_seconds: int = LCT_RATE_LIMIT_WINDOW_SECONDS,
    buckets: Optional[dict[str, Deque[float]]] = None,
) -> None:
    """Apply a small in-memory per-client request limit."""
    if limit <= 0 or window_seconds <= 0:
        return
    current_time = time.monotonic() if now is None else now
    active_buckets = RATE_LIMIT_BUCKETS if buckets is None else buckets
    bucket = active_buckets.setdefault(client_id, deque())
    cutoff = current_time - window_seconds
    while bucket and bucket[0] <= cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        raise HTTPException(status_code=429, detail="Too many requests")
    bucket.append(current_time)


def require_rate_limit(request: Request) -> None:
    client_id = request.client.host if request.client else "unknown"
    check_rate_limit(client_id)


def resolve_user_id(token: Optional[str]) -> str:
    """把访问令牌解析为用户 ID（多用户预留的唯一收口点）。

    当前为个人单用户，恒定返回 'default'。未来要分用户，只需在这里
    建立 token -> user_id 的映射，其余 API / 表结构均无需改动。
    """
    return "default"


def current_user(x_lct_token: Optional[str] = Header(default=None)) -> str:
    return resolve_user_id(x_lct_token)

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


def build_chat_payload(
    selected_text: str,
    context_sentence: str,
    model: Optional[str] = None,
    lang: str = "en",
    stream: bool = False,
) -> dict:
    """Build the shared chat-completions payload for streaming and non-streaming calls."""
    strategy = get_strategy(lang)
    word_mode = strategy.is_word_mode(selected_text)
    system_prompt = strategy.get_word_prompt() if word_mode else strategy.get_sentence_prompt()
    user_prompt = strategy.build_user_prompt(selected_text, context_sentence)
    actual_model = resolve_model(model)

    payload = {
        "model": actual_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.3,
    }
    if stream:
        payload["stream"] = True
    if model_supports_thinking(actual_model):
        payload["enable_thinking"] = False
    return payload


# ========== 流式端点 ==========


def ensure_done_event_fields(event: dict, strategy, selected_text: str, word_mode: bool) -> dict:
    """done 事件的数据在发给前端前统一兜底填充默认字段。

    解析器主路径（完整 JSON 一次解析成功）发出的 done 带的是 LLM 原始输出，
    与末尾兜底路径不同，不经过 ensure_response_fields —— 在转发层统一补齐。
    """
    if event.get("type") == "done" and isinstance(event.get("data"), dict):
        event["data"] = strategy.ensure_response_fields(
            event["data"], selected_text, word_mode
        )
    return event


async def stream_llm_response(
    session: aiohttp.ClientSession,
    selected_text: str,
    context_sentence: str,
    model: Optional[str] = None,
    lang: str = "en",
) -> AsyncGenerator[str, None]:
    """流式调用 LLM API，通过增量解析器输出结构化 SSE 事件"""
    strategy = get_strategy(lang)
    word_mode = strategy.is_word_mode(selected_text)
    payload = build_chat_payload(selected_text, context_sentence, model, lang, stream=True)

    url = f"{LLM_API_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
        "Content-Type": "application/json",
    }

    parser = JsonStreamParser(simple_fields=strategy.get_schema_fields(word_mode))

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
                            event = ensure_done_event_fields(
                                event, strategy, selected_text, word_mode
                            )
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

        full_data = strategy.ensure_response_fields(full_data, selected_text, word_mode)
        # 发射所有未发射的字段
        remaining = parser.emit_remaining(full_data)
        for event in remaining:
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'data': full_data}, ensure_ascii=False)}\n\n"


@app.post(
    "/translate/stream",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
async def translate_stream(req: TranslateRequest):
    """流式翻译端点（SSE）"""
    if len(req.selected_text) > MAX_TRANSLATE_CHARS:
        raise HTTPException(
            status_code=413, detail=f"选中文本过长（上限 {MAX_TRANSLATE_CHARS} 字符）"
        )
    return StreamingResponse(
        stream_llm_response(
            app.state.session,
            req.selected_text,
            req.context_sentence,
            req.model,
            req.lang,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ========== 非流式端点（调试用） ==========


@app.post(
    "/translate",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
async def translate(req: TranslateRequest):
    """非流式翻译端点（调试用）"""
    if len(req.selected_text) > MAX_TRANSLATE_CHARS:
        raise HTTPException(
            status_code=413, detail=f"选中文本过长（上限 {MAX_TRANSLATE_CHARS} 字符）"
        )
    strategy = get_strategy(req.lang)
    word_mode = strategy.is_word_mode(req.selected_text)
    payload = build_chat_payload(
        req.selected_text,
        req.context_sentence,
        req.model,
        req.lang,
        stream=False,
    )

    url = f"{LLM_API_BASE_URL}/chat/completions"
    headers = {
        "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
        "Content-Type": "application/json",
    }

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

    data = strategy.ensure_response_fields(data, req.selected_text, word_mode)
    return data


# ========== TTS ==========


def deerapi_request_kwargs() -> dict:
    """仅给 DeerAPI 请求附加代理。国内机房直连会被按地区 403。"""
    if DEERAPI_HTTP_PROXY:
        return {"proxy": DEERAPI_HTTP_PROXY}
    return {}


async def generate_tts_bytes(text: str, voice: str = "alloy") -> bytes:
    """调用 DeerAPI 生成语音二进制；失败抛 HTTPException。"""
    if not DEERAPI_KEY:
        raise HTTPException(status_code=500, detail="DEERAPI_KEY 未配置")
    if len(text) > MAX_TTS_CHARS:
        raise HTTPException(
            status_code=413, detail=f"TTS 文本过长（上限 {MAX_TTS_CHARS} 字符）"
        )

    url = f"{DEERAPI_BASE_URL}/audio/speech"
    headers = {
        "Authorization": f"Bearer {DEERAPI_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": "gpt-4o-mini-tts",
        "input": text,
        "voice": voice,
    }

    try:
        async with app.state.session.post(
            url, json=payload, headers=headers, **deerapi_request_kwargs()
        ) as resp:
            if resp.status != 200:
                error_text = await resp.text()
                raise HTTPException(
                    status_code=502,
                    detail=f"TTS API 返回 {resp.status}: {error_text[:200]}",
                )
            return await resp.read()
    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"TTS 服务请求失败: {str(e)}")


async def ensure_favorite_audio(
    user_id: str, item: dict, voice: str = "alloy"
) -> dict:
    """保证 item 带 audioKey 并已上传 COS。失败时原样返回，不阻断收藏主路径。"""
    if not cos_configured() or not DEERAPI_KEY:
        return item

    query = (item.get("query") or "").strip()
    if not query:
        return item

    lang = item.get("lang") or "en"
    key = item.get("audioKey") or build_audio_key(user_id, lang, query, voice)

    try:
        existing = await asyncio.to_thread(download_audio, key)
        if existing:
            item["audioKey"] = key
            item["audioVoice"] = voice
            storage.upsert_favorite(user_id, item)
            return item

        audio = await generate_tts_bytes(query, voice)
        await asyncio.to_thread(upload_audio, key, audio)
        item["audioKey"] = key
        item["audioVoice"] = voice
        storage.upsert_favorite(user_id, item)
    except Exception:
        log.exception("ensure_favorite_audio failed query=%s", query)
    return item


@app.post(
    "/api/tts",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
async def text_to_speech(req: TTSRequest):
    """调用 DeerAPI 生成语音，返回 audio/mpeg 二进制流"""
    audio_data = await generate_tts_bytes(req.text, req.voice)
    return Response(
        content=audio_data,
        media_type="audio/mpeg",
        headers={"Content-Disposition": "inline"},
    )


# ========== 模型列表端点 ==========


@app.get("/api/models")
async def get_available_models():
    """返回可用模型列表，供前端下拉框使用"""
    return {
        "models": get_models_response(),
        "default": DEFAULT_MODEL["id"],
    }


# ========== 生词本（收藏）端点 ==========


@app.get(
    "/api/favorites",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
def get_favorites(user_id: str = Depends(current_user)):
    """返回当前用户的生词本（按收藏时间倒序）。"""
    return {"favorites": storage.list_favorites(user_id)}


@app.post(
    "/api/favorites",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
def add_favorite(item: FavoriteItem, user_id: str = Depends(current_user)):
    """新增/更新一条生词。

    不在此处同步生成 TTS：发音由 /api/favorites/ensure-audio（打开生词本）
    或 /api/favorites/audio（播放时懒生成）补全，避免收藏接口被 TTS/COS 拖慢。
    """
    data = item.model_dump()
    storage.upsert_favorite(user_id, data)
    return {"ok": True, "favorite": data}


@app.get(
    "/api/favorites/audio",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
async def get_favorite_audio(
    query: str,
    lang: str = "en",
    voice: str = "alloy",
    user_id: str = Depends(current_user),
):
    """返回收藏词的 mp3。优先 COS；缺失则懒生成并回填。"""
    if not query or not query.strip():
        raise HTTPException(status_code=400, detail="query 不能为空")

    item = storage.get_favorite(user_id, lang, query)
    if item is None:
        raise HTTPException(status_code=404, detail="未找到该生词")

    data = None
    key = item.get("audioKey")
    if key and cos_configured():
        data = await asyncio.to_thread(download_audio, key)

    if data is None:
        item = await ensure_favorite_audio(user_id, item, voice=voice)
        key = item.get("audioKey")
        if key and cos_configured():
            data = await asyncio.to_thread(download_audio, key)
        if data is None:
            # COS 未配置或上传失败时，退回即时 TTS（不落盘）
            data = await generate_tts_bytes(item.get("query") or query, voice)

    return Response(
        content=data,
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": "inline",
            "Cache-Control": "private, max-age=86400",
        },
    )


@app.post(
    "/api/favorites/delete",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
def remove_favorite(req: FavoriteDeleteRequest, user_id: str = Depends(current_user)):
    """删除一条生词（用 POST 而非 DELETE，便于在请求体携带长句子）。"""
    existing = storage.get_favorite(user_id, req.lang, req.query)
    if existing and existing.get("audioKey"):
        try:
            delete_audio(existing["audioKey"])
        except Exception:
            log.exception("cos delete on unfavorite failed")
    storage.delete_favorite(user_id, req.lang, req.query)
    return {"ok": True}


@app.post(
    "/api/favorites/bulk",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
def import_favorites(req: FavoriteBulkRequest, user_id: str = Depends(current_user)):
    """批量导入（客户端首次同步时把本地已有收藏迁移上来）。"""
    count = storage.bulk_import(user_id, [item.model_dump() for item in req.favorites])
    return {"ok": True, "imported": count}


# 单次请求最多补多少条，避免 popup/复习页打开时一次卡死或烧爆 TTS
MAX_ENSURE_AUDIO_PER_REQUEST = 20


def _missing_audio(item: dict) -> bool:
    return not (item.get("audioKey") or "").strip()


@app.post(
    "/api/favorites/ensure-audio",
    dependencies=[Depends(require_rate_limit), Depends(require_access_token)],
)
async def ensure_favorites_audio(
    voice: str = "alloy",
    user_id: str = Depends(current_user),
):
    """为缺 audioKey 的生词现场生成 TTS 并上传 COS，写回完整链路。

    打开生词本 / 复习页时由客户端在 list 同步后调用。
    单次最多处理 MAX_ENSURE_AUDIO_PER_REQUEST 条；remaining>0 时可再调。
    """
    items = storage.list_favorites(user_id)
    missing = [item for item in items if _missing_audio(item)]
    batch = missing[:MAX_ENSURE_AUDIO_PER_REQUEST]

    filled = 0
    failed = 0
    for item in batch:
        updated = await ensure_favorite_audio(user_id, dict(item), voice=voice)
        if not _missing_audio(updated):
            filled += 1
        else:
            failed += 1

    final = storage.list_favorites(user_id)
    remaining = sum(1 for item in final if _missing_audio(item))
    log.info(
        "ensure-audio user=%s batch=%s filled=%s failed=%s remaining=%s",
        user_id,
        len(batch),
        filled,
        failed,
        remaining,
    )
    return {
        "ok": True,
        "checked": len(batch),
        "filled": filled,
        "failed": failed,
        "remaining": remaining,
        "favorites": final,
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
