"""
模型注册表 — 管理可用的 LLM 模型列表
添加/移除模型只需编辑 AVAILABLE_MODELS 列表即可
"""

from typing import Optional

AVAILABLE_MODELS: list[dict] = [
    {
        "id": "THUDM/GLM-4-9B-0414",
        "name": "GLM-4-9B-0414",
        "provider": "THUDM",
        "support_thinking": True,
    },
    {
        "id": "THUDM/GLM-Z1-9B-0414",
        "name": "GLM-Z1-9B-0414",
        "provider": "THUDM",
        "support_thinking": False,
    },
    {
        "id": "Pro/deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek V3.2",
        "provider": "DeepSeek",
        "support_thinking": True,
    },
    {
        "id": "Qwen/Qwen3-8B",
        "name": "Qwen3 8B",
        "provider": "Qwen",
        "support_thinking": True,
    },
    {
        "id": "tencent/Hunyuan-MT-7B",
        "name": "Hunyuan-MT-7B",
        "provider": "Tencent",
        "support_thinking": False,
    },
]

# 默认模型为列表第一个
DEFAULT_MODEL = AVAILABLE_MODELS[0]


def resolve_model(model_id: Optional[str]) -> str:
    """解析模型 ID，无效或为空则回退到默认模型"""
    if not model_id:
        return DEFAULT_MODEL["id"]
    for model in AVAILABLE_MODELS:
        if model["id"] == model_id:
            return model["id"]
    return DEFAULT_MODEL["id"]


def model_supports_thinking(model_id: str) -> bool:
    """判断指定模型是否支持 enable_thinking 参数"""
    for model in AVAILABLE_MODELS:
        if model["id"] == model_id:
            return model["support_thinking"]
    return False


def get_models_response() -> list[dict]:
    """返回给前端的模型列表"""
    return [
        {"id": m["id"], "name": m["name"], "provider": m["provider"]}
        for m in AVAILABLE_MODELS
    ]
