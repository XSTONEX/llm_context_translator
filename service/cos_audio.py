"""腾讯云 COS 音频对象读写（私有桶，仅服务端使用）。"""

from __future__ import annotations

import hashlib
import logging
from typing import Optional

from qcloud_cos import CosConfig, CosS3Client
from qcloud_cos.cos_exception import CosServiceError

from config import (
    COS_BUCKET,
    COS_PREFIX,
    COS_REGION,
    COS_SECRET_ID,
    COS_SECRET_KEY,
    cos_configured,
)

log = logging.getLogger("lct.cos")


def build_audio_key(
    user_id: str, lang: str, query: str, voice: str = "alloy"
) -> str:
    """稳定、脱敏的对象 key：hash(query+voice)，不含原文。"""
    q = (query or "").strip().lower()
    digest = hashlib.sha256(f"{q}:{voice}".encode("utf-8")).hexdigest()
    prefix = (COS_PREFIX or "tts").strip("/")
    uid = user_id or "default"
    lg = lang or "en"
    return f"{prefix}/{uid}/{lg}/{digest}.mp3"


def _client() -> CosS3Client:
    if not cos_configured():
        raise RuntimeError("COS 未配置")
    conf = CosConfig(
        Region=COS_REGION,
        SecretId=COS_SECRET_ID,
        SecretKey=COS_SECRET_KEY,
        Scheme="https",
    )
    return CosS3Client(conf)


def upload_audio(key: str, data: bytes, content_type: str = "audio/mpeg") -> None:
    client = _client()
    client.put_object(
        Bucket=COS_BUCKET,
        Body=data,
        Key=key,
        ContentType=content_type,
    )
    log.info("cos upload ok key=%s bytes=%s", key, len(data))


def download_audio(key: str) -> Optional[bytes]:
    """对象不存在返回 None；其他错误上抛。"""
    client = _client()
    try:
        resp = client.get_object(Bucket=COS_BUCKET, Key=key)
        return resp["Body"].get_raw_stream().read()
    except CosServiceError as e:
        code = str(e.get_error_code() or "")
        if code in ("NoSuchKey", "NoSuchResource") or e.get_status_code() == 404:
            return None
        raise


def delete_audio(key: str) -> None:
    """删除对象；不存在视为成功。"""
    if not key or not cos_configured():
        return
    client = _client()
    try:
        client.delete_object(Bucket=COS_BUCKET, Key=key)
        log.info("cos delete ok key=%s", key)
    except CosServiceError as e:
        if e.get_status_code() == 404:
            return
        log.error("cos delete failed key=%s err=%s", key, e)
