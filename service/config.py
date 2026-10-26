import os
from pathlib import Path

from dotenv import load_dotenv

# 加载 .env 文件（相对于本文件所在目录）
load_dotenv(Path(__file__).parent / ".env")

SILICONFLOW_API_KEY: str = os.getenv("SILICONFLOW_API_KEY", "")
LLM_API_BASE_URL: str = os.getenv("LLM_API_BASE_URL", "https://api.siliconflow.cn/v1")
# DeepSeek 官方 API：deepseek-flash 等 backend=deepseek 的模型直连, 不经硅基流动
DEEPSEEK_API_KEY: str = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL: str = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
LCT_ACCESS_TOKEN: str = os.getenv("LCT_ACCESS_TOKEN", "")
LCT_RATE_LIMIT_REQUESTS: int = int(os.getenv("LCT_RATE_LIMIT_REQUESTS", "60"))
LCT_RATE_LIMIT_WINDOW_SECONDS: int = int(os.getenv("LCT_RATE_LIMIT_WINDOW_SECONDS", "60"))
WORD_COUNT_THRESHOLD: int = int(os.getenv("WORD_COUNT_THRESHOLD", "3"))

DEERAPI_KEY: str = os.getenv("DEERAPI_KEY", "")
DEERAPI_BASE_URL: str = os.getenv("DEERAPI_BASE_URL", "https://api.deerapi.com/v1")
# DeerAPI 按地区封禁国内机房 IP。阿里云等环境需走本机 HTTP 代理（如 mihomo :7890）。
DEERAPI_HTTP_PROXY: str = os.getenv("DEERAPI_HTTP_PROXY", "")

# gptsapi 国内机房可直连, 不走代理
GPTSAPI_KEY: str = os.getenv("GPTSAPI_KEY", "")
GPTSAPI_BASE_URL: str = os.getenv("GPTSAPI_BASE_URL", "https://api.gptsapi.net/v1")

# tts 供应商: gptsapi | deerapi
TTS_PROVIDER: str = (os.getenv("TTS_PROVIDER", "gptsapi") or "gptsapi").strip().lower()
# 线上锁定的音色; 未选定时默认 nova
TTS_VOICE: str = (os.getenv("TTS_VOICE", "nova") or "nova").strip()

# 有道词典发音: 单个英文单词优先用它(免费, 多为真人录音), 拿不到或是词组/句子时走 TTS_PROVIDER
YOUDAO_TTS_ENABLED: bool = (os.getenv("YOUDAO_TTS_ENABLED", "1") or "1").strip().lower() not in ("0", "false", "no", "off")
# 口音: us(美音, 默认) | uk(英音)
YOUDAO_TTS_ACCENT: str = "uk" if (os.getenv("YOUDAO_TTS_ACCENT", "") or "").strip().lower() == "uk" else "us"

# 生词本 SQLite 数据库路径（默认放在 service/data/ 下，已被 .gitignore 忽略）
LCT_DB_PATH: str = os.getenv(
    "LCT_DB_PATH", str(Path(__file__).parent / "data" / "favorites.db")
)

# 腾讯云 COS（收藏单词音频，可选）
COS_SECRET_ID: str = os.getenv("COS_SECRET_ID", "")
COS_SECRET_KEY: str = os.getenv("COS_SECRET_KEY", "")
COS_BUCKET: str = os.getenv("COS_BUCKET", "")
COS_REGION: str = os.getenv("COS_REGION", "ap-guangzhou")
COS_PREFIX: str = os.getenv("COS_PREFIX", "tts")


def cos_configured() -> bool:
    """四项齐全才视为已启用 COS。"""
    return bool(COS_SECRET_ID and COS_SECRET_KEY and COS_BUCKET and COS_REGION)
