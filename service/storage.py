"""
生词本（收藏）持久化层 —— SQLite 单文件存储。

设计要点：
- 表的第一列就是 user_id，当前所有数据默认归到 'default' 用户。
- 未来要支持多用户时，只需让 app 层的 resolve_user_id() 返回真实用户即可，
  本模块和表结构都无需改动（已为多用户预留）。
"""

import json
import sqlite3
import time
from pathlib import Path

from config import LCT_DB_PATH


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(LCT_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    """建表（幂等），应在应用启动时调用一次。"""
    Path(LCT_DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS favorites (
                user_id    TEXT NOT NULL DEFAULT 'default',
                lang       TEXT NOT NULL,
                qkey       TEXT NOT NULL,
                query      TEXT NOT NULL,
                payload    TEXT NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (user_id, lang, qkey)
            )
            """
        )


def _qkey(query: str) -> str:
    """去重键：与前端 getLookupKey 保持一致（trim + lower）。"""
    return (query or "").strip().lower()


def list_favorites(user_id: str) -> list[dict]:
    """按收藏时间倒序返回某用户的全部生词。"""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT payload FROM favorites WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def get_favorite(user_id: str, lang: str, query: str) -> dict | None:
    """按 lang + query 取单条生词；不存在返回 None。"""
    qkey = _qkey(query)
    if not qkey:
        return None
    with _connect() as conn:
        row = conn.execute(
            "SELECT payload FROM favorites WHERE user_id = ? AND lang = ? AND qkey = ?",
            (user_id, lang or "en", qkey),
        ).fetchone()
    return json.loads(row["payload"]) if row else None


def set_favorite_audio(
    user_id: str, lang: str, query: str, audio_key: str, voice: str = "alloy"
) -> dict | None:
    """给已存在的生词写入 audioKey / audioVoice。"""
    item = get_favorite(user_id, lang, query)
    if not item:
        return None
    item["audioKey"] = audio_key
    item["audioVoice"] = voice
    upsert_favorite(user_id, item)
    return item


def upsert_favorite(user_id: str, item: dict) -> None:
    """新增或更新一条生词；payload 原样保存前端的收藏对象。"""
    qkey = _qkey(item.get("query", ""))
    if not qkey:
        return
    lang = item.get("lang") or "en"
    created_at = item.get("timestamp") or (time.time() * 1000)
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO favorites (user_id, lang, qkey, query, payload, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, lang, qkey) DO UPDATE SET payload = excluded.payload
            """,
            (
                user_id,
                lang,
                qkey,
                item.get("query", ""),
                json.dumps(item, ensure_ascii=False),
                created_at,
            ),
        )


def delete_favorite(user_id: str, lang: str, query: str) -> None:
    with _connect() as conn:
        conn.execute(
            "DELETE FROM favorites WHERE user_id = ? AND lang = ? AND qkey = ?",
            (user_id, lang, _qkey(query)),
        )


def bulk_import(user_id: str, items: list[dict]) -> int:
    """批量导入（用于把客户端本地已有的收藏迁移到后端）。返回导入条数。"""
    count = 0
    for item in items:
        if _qkey(item.get("query", "")):
            upsert_favorite(user_id, item)
            count += 1
    return count
