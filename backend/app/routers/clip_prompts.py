"""Admin-only prompt library for external AI chats."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict

from app.routers.auth import require_admin
from app.services import clip_prompts

router = APIRouter(prefix="/clip-prompts", tags=["clip-prompts"],
                   dependencies=[Depends(require_admin)])


class PromptInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    selection_focus: str


class PromptUpdate(PromptInput):
    expected_revision: int


class DuplicateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str


def _error(exc: ValueError) -> HTTPException:
    if isinstance(exc, clip_prompts.PromptConflict):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, clip_prompts.PromptReadOnly):
        return HTTPException(status_code=403, detail=str(exc))
    if isinstance(exc, clip_prompts.PromptNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, clip_prompts.PromptStoreError):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.get("")
def list_prompts() -> dict:
    try:
        return {"default": clip_prompts.DEFAULT_ID,
                "core_rules": clip_prompts.CORE_RULES,
                "output_contract": clip_prompts.OUTPUT_CONTRACT,
                "prompts": clip_prompts.list_prompts()}
    except ValueError as exc:
        raise _error(exc) from exc


@router.post("", status_code=201)
def create_prompt(body: PromptInput) -> dict:
    try:
        return clip_prompts.create(body.name, body.description, body.selection_focus)
    except ValueError as exc:
        raise _error(exc) from exc


@router.put("/{prompt_id}")
def update_prompt(prompt_id: str, body: PromptUpdate) -> dict:
    try:
        return clip_prompts.update(prompt_id, body.name, body.description,
                                   body.selection_focus, body.expected_revision)
    except ValueError as exc:
        raise _error(exc) from exc


@router.post("/{prompt_id}/duplicate", status_code=201)
def duplicate_prompt(prompt_id: str, body: DuplicateInput) -> dict:
    try:
        return clip_prompts.duplicate(prompt_id, body.name)
    except ValueError as exc:
        raise _error(exc) from exc


@router.delete("/{prompt_id}")
def delete_prompt(prompt_id: str) -> dict:
    try:
        clip_prompts.delete(prompt_id)
    except ValueError as exc:
        raise _error(exc) from exc
    return {"deleted": True}
