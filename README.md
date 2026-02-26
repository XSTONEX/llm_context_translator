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

## 配置

在 `service/.env` 中设置：

```
SILICONFLOW_API_KEY=your_api_key
LLM_API_BASE_URL=https://api.siliconflow.cn/v1
```
