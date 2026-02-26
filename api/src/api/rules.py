from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.config import settings

router = APIRouter(prefix="/api/rules", tags=["rules"])

ALLOWED_FILES = {
    "blog-research",
    "blog-outline",
    "blog-write",
    "blog-edit",
    "blog-images",
}


def _rule_path(name: str) -> Path:
    if name not in ALLOWED_FILES:
        raise HTTPException(status_code=404, detail=f"Unknown rule: {name}")
    return Path(settings.rules_dir) / f"{name}.md"


@router.get("")
async def list_rules():
    rules_dir = Path(settings.rules_dir)
    result = []
    for name in sorted(ALLOWED_FILES):
        path = rules_dir / f"{name}.md"
        result.append(
            {
                "name": name,
                "filename": f"{name}.md",
                "exists": path.exists(),
                "size": path.stat().st_size if path.exists() else 0,
            }
        )
    return result


@router.get("/{name}")
async def get_rule(name: str):
    path = _rule_path(name)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Rule file not found")
    return {"name": name, "content": path.read_text(encoding="utf-8")}


class RuleUpdate(BaseModel):
    content: str


@router.put("/{name}")
async def update_rule(name: str, body: RuleUpdate):
    path = _rule_path(name)
    path.write_text(body.content, encoding="utf-8")
    return {"name": name, "content": body.content}
