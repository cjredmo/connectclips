"""Admin-only custom caption preset actions."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.routers.auth import require_admin
from app.services import caption_styles

router = APIRouter(prefix="/caption-styles", tags=["caption-styles"])


class StyleInput(BaseModel):
    name: str
    descriptor: dict


class StyleUpdate(StyleInput):
    expected_revision: int


class DuplicateInput(BaseModel):
    name: str


def _error(exc: ValueError) -> HTTPException:
    if isinstance(exc, caption_styles.StyleConflict):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, caption_styles.StyleStoreError):
        return HTTPException(status_code=503, detail=str(exc))
    if str(exc).startswith("unknown caption style"):
        return HTTPException(status_code=404, detail=str(exc))
    if str(exc).startswith("built-in caption"):
        return HTTPException(status_code=403, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_style(body: StyleInput) -> dict:
    try:
        return caption_styles.create(body.name, body.descriptor)
    except ValueError as exc:
        raise _error(exc) from exc


@router.put("/{style_id}", dependencies=[Depends(require_admin)])
def update_style(style_id: str, body: StyleUpdate) -> dict:
    try:
        return caption_styles.update(style_id, body.name, body.descriptor,
                                     body.expected_revision)
    except ValueError as exc:
        raise _error(exc) from exc


@router.post("/{style_id}/duplicate", status_code=201,
             dependencies=[Depends(require_admin)])
def duplicate_style(style_id: str, body: DuplicateInput) -> dict:
    try:
        return caption_styles.duplicate(style_id, body.name)
    except ValueError as exc:
        raise _error(exc) from exc


@router.delete("/{style_id}", dependencies=[Depends(require_admin)])
def delete_style(style_id: str) -> dict:
    try:
        caption_styles.delete(style_id)
    except ValueError as exc:
        raise _error(exc) from exc
    return {"deleted": True}
