import os
from pathlib import Path

from dotenv import load_dotenv

# 加载 .env 文件（相对于本文件所在目录）
load_dotenv(Path(__file__).parent / ".env")

SILICONFLOW_API_KEY: str = os.getenv("SILICONFLOW_API_KEY", "")
LLM_API_BASE_URL: str = os.getenv("LLM_API_BASE_URL", "https://api.siliconflow.cn/v1")
LCT_ACCESS_TOKEN: str = os.getenv("LCT_ACCESS_TOKEN", "")
LCT_RATE_LIMIT_REQUESTS: int = int(os.getenv("LCT_RATE_LIMIT_REQUESTS", "60"))
LCT_RATE_LIMIT_WINDOW_SECONDS: int = int(os.getenv("LCT_RATE_LIMIT_WINDOW_SECONDS", "60"))
WORD_COUNT_THRESHOLD: int = int(os.getenv("WORD_COUNT_THRESHOLD", "3"))

DEERAPI_KEY: str = os.getenv("DEERAPI_KEY", "")
DEERAPI_BASE_URL: str = os.getenv("DEERAPI_BASE_URL", "https://api.deerapi.com/v1")
# DeerAPI 按地区封禁国内机房 IP。阿里云等环境需走本机 HTTP 代理（如 mihomo :7890）。
DEERAPI_HTTP_PROXY: str = os.getenv("DEERAPI_HTTP_PROXY", "")

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
