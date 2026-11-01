from __future__ import annotations

import unicodedata
from typing import List, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Certificate, Rating, User
from ..schemas import RegistryPersonOut
from ..services.candidate_status import sync_transitional_certificates


router = APIRouter()

ALLOWED_CERTIFICATE_STATUSES = ("active", "suspended", "expired")
QUALIFICATION_ALIASES = {
    "architect": ("architect", "არქიტექტორი", "შენობა-ნაგებობის არქიტექტორი"),
    "expert": ("expert", "architect_expert", "არქიტექტორი ექსპერტი", "არქიტექტურული პროექტის ექსპერტი"),
    "municipal": ("municipal", "მუნიციპალიტეტის სპეციალისტი", "პროექტის შემსწავლელი სპეციალისტი"),
}
QUALIFICATION_KEYS = {alias: key for key, aliases in QUALIFICATION_ALIASES.items() for alias in aliases}
SortKey = Literal["date_desc", "date_asc", "name_asc", "name_desc", "rating_asc", "rating_desc"]


class RegistryPageOut(BaseModel):
    items: List[RegistryPersonOut]
    total: int
    filtered_total: int
    offset: int
    limit: int


def _normalize_text(value: str | None) -> str:
    # SQLite lower() only folds ASCII. Also handle Georgian Mtavruli,
    # repeated whitespace, and literal (not SQL-wildcard) searching.
    return " ".join((value or "").lower().split())


_GEORGIAN_ALPHABET = "აბგდევზჱთიკლმნჲოპჟრსტჳუფქღყშჩცძწჭხჴჯჰჵჶჷჸჹჺ"
_GEORGIAN_ORDER = {letter: index for index, letter in enumerate(_GEORGIAN_ALPHABET)}


def _name_sort_key(value: str) -> tuple:
    """Georgian-first order, case/accent/punctuation insensitive.

    Interleave historical Georgian letters rather than Unicode-codepoint order,
    matching the existing ka browser collation for Georgian names.
    Latin follows Georgian; numeric strings retain lexical (not natural) order.
    """
    result = []
    for char in unicodedata.normalize("NFD", value.casefold()):
        category = unicodedata.category(char)
        if category[0] in ("P", "Z", "M") or char.isspace():
            continue
        if char in _GEORGIAN_ORDER:
            result.append((1, _GEORGIAN_ORDER[char]))
        elif category[0] == "N":
            result.append((0, ord(char)))
        else:
            result.append((2, ord(char)))
    return tuple(result)


def _georgian_compare(left: str, right: str) -> int:
    a, b = _name_sort_key(left), _name_sort_key(right)
    return (a > b) - (a < b)


def _prepare_search_connection(db: Session) -> None:
    # Connection-local helpers: no schema, migration, or global locale changes.
    connection = db.connection().connection.driver_connection
    connection.create_function("registry_normalize", 1, _normalize_text, deterministic=True)
    connection.create_collation("registry_georgian", _georgian_compare)


def _rating_totals():
    # Same five-criteria mean as reviews_summary, not the legacy score column.
    average = (
        func.coalesce(Rating.integrity, 0)
        + func.coalesce(Rating.responsibility, 0)
        + func.coalesce(Rating.knowledge_experience, 0)
        + func.coalesce(Rating.professional_skills, 0)
        + func.coalesce(Rating.price_quality, 0)
    ) / 5.0
    return (
        select(Rating.target_user_id.label("user_id"), func.avg(average).label("rating"))
        .group_by(Rating.target_user_id).subquery()
    )


def _public_rows_statement():
    ratings = _rating_totals()
    rating = func.coalesce(ratings.c.rating, 0.0)
    # Only fields needed for the public view; never serialize User.__dict__.
    stmt = (
        select(User.id, User.first_name, User.last_name, User.code, User.photo_path,
               User.created_at, Certificate.unique_code, Certificate.level,
               Certificate.status, rating.label("rating"))
        .join(Certificate, Certificate.user_id == User.id)
        .outerjoin(ratings, ratings.c.user_id == User.id)
        .where(Certificate.status.in_(ALLOWED_CERTIFICATE_STATUSES))
    )
    return stmt, rating


def _serialize_rows(rows, request: Request, *, canonical_levels: bool = False) -> List[RegistryPersonOut]:
    base_url = str(request.base_url).rstrip("/")
    return [
        RegistryPersonOut(
            id=row.id,
            full_name=" ".join(part for part in (row.first_name, row.last_name) if part).strip(),
            photo_url=f"{base_url}/users/{row.id}/photo/file" if row.photo_path else "",
            unique_code=(row.unique_code or row.code or "").strip(),
            qualification=QUALIFICATION_KEYS.get(_normalize_text(row.level), row.level) if canonical_levels else row.level,
            certificate_status=row.status,
            rating=float(round(row.rating or 0.0, 2)),
            registration_date=row.created_at,
        ) for row in rows
    ]


@router.get("/registry", response_model=List[RegistryPersonOut])
def list_certified_persons_registry(
    request: Request,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> List[RegistryPersonOut]:
    # Preserve legacy list shape, limits, fields, level values and date order.
    sync_transitional_certificates(db)
    stmt, _ = _public_rows_statement()
    rows = db.execute(stmt.order_by(User.created_at.desc(), User.id.desc()).offset(offset).limit(limit)).all()
    return _serialize_rows(rows, request)


@router.get("/registry/page", response_model=RegistryPageOut)
def list_certified_persons_page(
    request: Request,
    q: str = Query("", max_length=300),
    qualifications: str = Query("", max_length=300),
    sort: SortKey = Query("date_desc"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> RegistryPageOut:
    sync_transitional_certificates(db)
    _prepare_search_connection(db)
    selected = {_normalize_text(part) for part in qualifications.split(",") if part.strip()}
    if any(value not in QUALIFICATION_KEYS for value in selected):
        raise HTTPException(status_code=422, detail="Unknown registry qualification")
    selected = {QUALIFICATION_KEYS[value] for value in selected}
    full_name = func.trim(func.coalesce(User.first_name, "") + " " + func.coalesce(User.last_name, ""))
    conditions = []
    query = _normalize_text(q)
    if query:
        certificate_code = func.coalesce(func.nullif(Certificate.unique_code, ""), User.code, "")
        conditions.append(or_(
            func.instr(func.registry_normalize(full_name), query) > 0,
            func.instr(func.registry_normalize(certificate_code), query) > 0,
        ))
    # No checked boxes or all three include even unknown/legacy levels.
    # Partial selections form a union, as with the original browser filters.
    if 0 < len(selected) < len(QUALIFICATION_ALIASES):
        aliases = [alias for key in selected for alias in QUALIFICATION_ALIASES[key]]
        conditions.append(func.registry_normalize(Certificate.level).in_(aliases))

    count_stmt = (
        select(func.count(User.id)).join(Certificate, Certificate.user_id == User.id)
        .where(Certificate.status.in_(ALLOWED_CERTIFICATE_STATUSES))
    )
    total = int(db.scalar(count_stmt) or 0)
    filtered_total = int(db.scalar(count_stmt.where(*conditions)) or 0) if conditions else total
    # After deletions/filter changes, do not strand users beyond the last page.
    offset = min(offset, ((filtered_total - 1) // limit) * limit) if filtered_total else 0
    stmt, rating = _public_rows_statement()
    name_order = full_name.collate("registry_georgian")
    order = {
        "date_desc": User.created_at.desc(), "date_asc": User.created_at.asc(),
        "name_asc": name_order.asc(), "name_desc": name_order.desc(),
        "rating_asc": rating.asc(), "rating_desc": rating.desc(),
    }[sort]
    rows = db.execute(
        stmt.where(*conditions).order_by(order, User.created_at.desc(), User.id.desc()).offset(offset).limit(limit)
    ).all()
    return RegistryPageOut(
        items=_serialize_rows(rows, request, canonical_levels=True), total=total,
        filtered_total=filtered_total, offset=offset, limit=limit,
    )

