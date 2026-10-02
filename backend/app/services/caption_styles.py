"""Installation-level custom caption presets, separate from sermon data."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from dataclasses import asdict, fields, replace
from pathlib import Path

from app.config import settings
from app.services import captions

STORE_VERSION = 1
FONT_CHOICES = ("DejaVu Sans", "Arial", "Helvetica")
_lock = threading.RLock()
reference_lock = _lock  # serialize clip reference updates with preset deletion
_style_fields = {field.name for field in fields(captions.CaptionStyle)}
_optional_style_fields = {"background_persistence", "background_linger_seconds"}
_custom_id = re.compile(r"custom:[0-9a-f]{32}\Z")


class StyleStoreError(ValueError):
    pass


class StyleConflict(StyleStoreError):
    pass


def path() -> Path:
    return settings.data_work_dir / "_settings" / "caption_styles.json"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _validate_record(record: object) -> dict:
    if not isinstance(record, dict) or not _custom_id.fullmatch(str(record.get("id", ""))):
        raise StyleStoreError("custom caption style storage is invalid")
    name = record.get("name")
    revision = record.get("revision")
    descriptor = record.get("descriptor")
    if (not isinstance(name, str) or not name.strip() or len(name) > 80 or
            not isinstance(revision, int) or isinstance(revision, bool) or revision < 1 or
            not isinstance(record.get("created_at"), str) or
            not isinstance(record.get("updated_at"), str) or
            not isinstance(descriptor, dict)):
        raise StyleStoreError("custom caption style storage is invalid")
    if not (_style_fields - _optional_style_fields <= set(descriptor) <= _style_fields):
        raise StyleStoreError("custom caption style descriptor is incomplete")
    try:
        style = captions.CaptionStyle(**descriptor)
    except (TypeError, ValueError) as exc:
        raise StyleStoreError("custom caption style descriptor is invalid") from exc
    if (style.key != record["id"] or style.label != name or
            style.font_name not in FONT_CHOICES or style.preview_highlight_color is not None or
            style.preview_background_opacity is not None):
        raise StyleStoreError("custom caption style descriptor is invalid")
    return record


def _load() -> list[dict]:
    store = path()
    if not store.exists():
        return []
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StyleStoreError("custom caption style storage cannot be read") from exc
    if (not isinstance(data, dict) or data.get("schema_version") != STORE_VERSION or
            not isinstance(data.get("styles"), list)):
        raise StyleStoreError("unsupported custom caption style storage")
    records = [_validate_record(record) for record in data["styles"]]
    ids = [record["id"] for record in records]
    if len(set(ids)) != len(ids):
        raise StyleStoreError("duplicate custom caption style IDs")
    return records


def _write(records: list[dict]) -> None:
    store = path()
    store.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=store.parent, encoding="utf-8",
                                         prefix=".caption-styles-", delete=False) as handle:
            name = handle.name
            json.dump({"schema_version": STORE_VERSION, "styles": records}, handle,
                      indent=2, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, store)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def _clean_name(name: str) -> str:
    name = name.strip()
    if not name or len(name) > 80 or any(ord(char) < 32 for char in name):
        raise ValueError("style name must be 1–80 printable characters")
    return name


def _custom_style(style_id: str, name: str, descriptor: dict) -> captions.CaptionStyle:
    if not isinstance(descriptor, dict):
        raise ValueError("caption style descriptor is required")
    values = {key: value for key, value in descriptor.items() if key in _style_fields}
    values.update(key=style_id, label=name, schema_version=2,
                  preview_highlight_color=None, preview_background_opacity=None)
    try:
        style = captions.CaptionStyle(**values)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid caption style: {exc}") from exc
    if style.font_name not in FONT_CHOICES:
        raise ValueError("font is not in the supported caption font list")
    return style


def _public(record: dict) -> dict:
    return {**captions.CaptionStyle(**record["descriptor"]).descriptor(),
            "built_in": False, "editable": True,
            "revision": record["revision"], "created_at": record["created_at"],
            "updated_at": record["updated_at"]}


def list_styles() -> list[dict]:
    builtins = [{**style.descriptor(), "built_in": True, "editable": False,
                 "revision": None} for style in captions.STYLES.values()]
    return builtins + [_public(record) for record in _load()]


def resolve(key: str | None) -> tuple[captions.CaptionStyle, dict]:
    if key is None:
        key = captions.DEFAULT_STYLE
    if key in captions.STYLES:
        style = captions.STYLES[key]
        return style, {"id": key, "name": style.label, "revision": None}
    for record in _load():
        if record["id"] == key:
            return captions.CaptionStyle(**record["descriptor"]), {
                "id": key, "name": record["name"], "revision": record["revision"]}
    raise ValueError(f"unknown caption style: {key}")


def snapshot(key: str | None) -> tuple[captions.CaptionStyle, dict]:
    style, meta = resolve(key)
    descriptor = asdict(style)
    digest = hashlib.sha256(json.dumps(descriptor, sort_keys=True,
                                       separators=(",", ":")).encode("utf-8")).hexdigest()
    return style, {**meta, "hash": digest, "descriptor": descriptor}


def _find(records: list[dict], style_id: str) -> dict:
    if style_id in captions.STYLES:
        raise ValueError("built-in caption styles are read-only")
    record = next((item for item in records if item["id"] == style_id), None)
    if record is None:
        raise ValueError(f"unknown caption style: {style_id}")
    return record


def create(name: str, descriptor: dict) -> dict:
    name = _clean_name(name)
    with _lock:
        records = _load()
        style_id = f"custom:{uuid.uuid4().hex}"
        style = _custom_style(style_id, name, descriptor)
        now = _now()
        record = {"id": style_id, "name": name, "revision": 1,
                  "created_at": now, "updated_at": now, "descriptor": style.descriptor()}
        records.append(record)
        _write(records)
        return _public(record)


def update(style_id: str, name: str, descriptor: dict, expected_revision: int) -> dict:
    name = _clean_name(name)
    with _lock:
        records = _load()
        record = _find(records, style_id)
        if record["revision"] != expected_revision:
            raise StyleConflict("caption style changed; reload before saving")
        style = _custom_style(style_id, name, descriptor)
        record.update(name=name, descriptor=style.descriptor(),
                      revision=record["revision"] + 1, updated_at=_now())
        _write(records)
        return _public(record)


def duplicate(style_id: str, name: str) -> dict:
    style, _ = resolve(style_id)
    return create(name, replace(style, preview_highlight_color=None,
                                preview_background_opacity=None).descriptor())


def _reference_locations(style_id: str) -> list[tuple[Path, str]]:
    locations = []
    root = settings.data_work_dir
    if not root.exists():
        return locations
    for store in root.glob("*/clip_overrides.json"):
        try:
            overrides = json.loads(store.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise StyleConflict("cannot verify clip references; repair local overrides first") from exc
        if not isinstance(overrides, dict):
            raise StyleConflict("cannot verify clip references; repair local overrides first")
        locations.extend((store, key) for key, value in overrides.items()
                         if isinstance(value, dict) and value.get("caption_style") == style_id)
    return locations


def reference_counts(style_id: str, source_name: str, clip_index: int) -> dict[str, int | bool]:
    """Count references without exposing other sermons or clip identifiers."""
    with _lock:
        _find(_load(), style_id)
        locations = _reference_locations(style_id)
        current_store = settings.data_work_dir / Path(source_name).stem / "clip_overrides.json"
        current = (current_store, str(clip_index)) in locations
        return {"current_clip": current, "other_clips": len(locations) - int(current)}


def delete(style_id: str) -> None:
    with _lock:
        records = _load()
        record = _find(records, style_id)
        count = len(_reference_locations(style_id))
        if count:
            raise StyleConflict(
                f"caption style is still selected by {count} clip(s); "
                "select another style for those clips before deleting"
            )
        records.remove(record)
        _write(records)
