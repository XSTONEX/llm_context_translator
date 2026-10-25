"""
模型注册表 — 管理可用的 LLM 模型列表
添加/移除模型只需编辑 AVAILABLE_MODELS 列表即可
"""

import copy
from typing import Optional

# backend: 走哪个上游 —— siliconflow（硅基流动）| deepseek（DeepSeek 官方 API）
# support_thinking: 是否接受硅基流动的 enable_thinking 参数
# extra_payload: 该模型额外合并进请求体的参数
AVAILABLE_MODELS: list[dict] = [
    {
        "id": "deepseek-flash",
        "name": "DeepSeek V4.1 Flash",
        "provider": "DeepSeek",
        "backend": "deepseek",
        "support_thinking": False,
        # 官方 API 默认开思考（effort=high），显式关掉才是最快档
        "extra_payload": {"thinking": {"type": "disabled"}},
    },
    {
        "id": "Pro/deepseek-ai/DeepSeek-V3.2",
        "name": "DeepSeek V3.2",
        "provider": "DeepSeek",
        "backend": "siliconflow",
        "support_thinking": True,
    },
    {
        "id": "Pro/zai-org/GLM-5",
        "name": "GLM-5",
        "provider": "Zhipu AI",
        "backend": "siliconflow",
        "support_thinking": False,
    }
]

# 默认模型为列表第一个
DEFAULT_MODEL = AVAILABLE_MODELS[0]


def _find_model(model_id: str) -> Optional[dict]:
    for model in AVAILABLE_MODELS:
        if model["id"] == model_id:
            return model
    return None


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


def model_backend(model_id: str) -> str:
    """模型所属上游；未知模型按硅基流动处理"""
    model = _find_model(model_id)
    return model.get("backend", "siliconflow") if model else "siliconflow"


def model_extra_payload(model_id: str) -> dict:
    """模型专属请求参数（深拷贝，调用方可放心修改）"""
    model = _find_model(model_id)
    return copy.deepcopy(model.get("extra_payload", {})) if model else {}


def get_models_response() -> list[dict]:
    """返回给前端的模型列表"""
    return [
        {"id": m["id"], "name": m["name"], "provider": m["provider"]}
        for m in AVAILABLE_MODELS
    ]
