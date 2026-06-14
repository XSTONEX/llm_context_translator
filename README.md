# LLM Context Translator

基于 LLM 的 Chrome 划词翻译扩展，支持单词释义和句子翻译，提供上下文语境分析。

## 功能

- **划词翻译** — 选中英文单词或句子，自动调用 LLM 进行翻译
- **单词模式** — 音标、释义、例句、上下文语境分析
- **句子模式** — 高质量中文翻译、语法分析、关键表达提取
- **流式响应** — SSE 实时输出，无需等待完整结果
- **多模型支持** — GLM-4、DeepSeek、Qwen、Hunyuan 等

## 项目结构

```
├── manifest.json / popup.* / content.js / background.js   # Chrome 扩展前端
└── service/                                                # FastAPI 后端服务
```

## 快速开始

### 后端服务

需要 Python 3.12+，使用 [uv](https://docs.astral.sh/uv/) 管理环境：

```bash
cd service
uv sync
cp .env.example .env  # 填入你的 API Key
uv run uvicorn app:app --reload
```

### 浏览器扩展

1. 打开 `chrome://extensions/`，启用开发者模式
2. 点击「加载已解压的扩展程序」，选择项目根目录
3. 点击扩展图标打开 popup，在「访问令牌」里填入与后端一致的 token（见下）

## 配置

后端配置见 `service/.env`（参考 `service/.env.example`）：

```
SILICONFLOW_API_KEY=your_api_key
LLM_API_BASE_URL=https://api.siliconflow.cn/v1
DEERAPI_KEY=your_tts_key          # 可选，TTS 发音
LCT_ACCESS_TOKEN=replace_me       # 公网部署必填
LCT_RATE_LIMIT_REQUESTS=60
LCT_RATE_LIMIT_WINDOW_SECONDS=60
```

### 访问鉴权（重要）

后端的付费接口（`/translate`、`/api/tts`、`/api/favorites`）由 `LCT_ACCESS_TOKEN` 保护。

- **`LCT_ACCESS_TOKEN` 为空 = 后端不鉴权**，任何知道你域名的人都能消耗你的 API Key。公网部署务必设置。
- 扩展侧的 token 在 **popup 的「访问令牌」** 里填写，保存到 `chrome.storage.sync`，会随 Chrome 账号自动同步到所有设备（无需在每台电脑手动配置）。它必须与后端 `.env` 中的 `LCT_ACCESS_TOKEN` **完全一致**。
- `config.js` 只保存后端地址，不含任何密钥，因此可以安全地提交进公开仓库。
- 生成随机令牌：`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
- 修改后端 `.env` 后需**重启后端服务**才能生效。

## 生词本同步

收藏（生词本）存储在后端 SQLite（默认 `service/data/favorites.db`，可用 `LCT_DB_PATH` 改路径），
扩展侧保留一份本地镜像以保证响应速度和离线可读。换设备/重装扩展后，生词本会自动从后端同步回来。

> 多用户预留：数据表已带 `user_id` 列（当前恒为 `default`）。未来要按用户隔离，只需修改
> `service/app.py` 中的 `resolve_user_id()`（把 token 映射到不同用户），API 与表结构无需改动。
