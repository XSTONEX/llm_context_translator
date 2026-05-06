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
