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

# 生词本 SQLite 数据库路径（默认放在 service/data/ 下，已被 .gitignore 忽略）
LCT_DB_PATH: str = os.getenv(
    "LCT_DB_PATH", str(Path(__file__).parent / "data" / "favorites.db")
)
