from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Header, HTTPException, status, Path as FPath
from sqlalchemy import select, func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import TeamMember
from ..schemas import TeamMemberOut, TeamMemberCreate, TeamMembersListResponse, TeamMemberOrderRequest
from ..routers.admin import _require_admin


router = APIRouter()


def _team_member_out(member: TeamMember) -> TeamMemberOut:
    return TeamMemberOut(
        id=member.id,
        category=member.category,
        position=member.position or "",
        first_name=member.first_name or "",
        last_name=member.last_name or "",
        email=member.email,
        phone=member.phone,
        order_index=member.order_index or 0,
        created_at=member.created_at,
    )


# ----------------- Admin endpoints -----------------


@router.get("/admin/team", response_model=TeamMembersListResponse)
def admin_list_team_members(
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ყველა გუნდის წევრის წამოღება (ადმინისთვის)"""
    _require_admin(db, authorization)
    members = db.scalars(
        select(TeamMember).order_by(TeamMember.category.asc(), TeamMember.order_index.asc(), TeamMember.id.asc())
    ).all()
    return TeamMembersListResponse(items=[_team_member_out(m) for m in members])


@router.post("/admin/team", response_model=TeamMemberOut, status_code=status.HTTP_201_CREATED)
def admin_create_team_member(
    payload: TeamMemberCreate,
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """ახალი გუნდის წევრის დამატება"""
    _require_admin(db, authorization)

    # Get max order_index for this category
    max_order = db.scalar(
        select(func.max(TeamMember.order_index)).where(TeamMember.category == payload.category)
    ) or 0

    member = TeamMember(
        category=payload.category,
        position=(payload.position or "").strip(),
        first_name=(payload.first_name or "").strip(),
        last_name=(payload.last_name or "").strip(),
        email=(payload.email or "").strip() if payload.email else None,
        phone=(payload.phone or "").strip() if payload.phone else None,
        order_index=int(max_order) + 1,
    )
    db.add(member)
    db.commit()
    db.refresh(member)

    return _team_member_out(member)


@router.patch("/admin/team/{member_id}/order", status_code=status.HTTP_204_NO_CONTENT)
def admin_change_team_member_order(
    payload: TeamMemberOrderRequest,
    member_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """გუნდის წევრის რიგითობის შეცვლა (up/down)"""
    _require_admin(db, authorization)

    member = db.get(TeamMember, member_id)
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team member not found")

    direction = (payload.direction or "").lower().strip()
    if direction not in ("up", "down"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="direction must be 'up' or 'down'")

    # Get all members in same category, sorted by order_index
    members_in_category = db.scalars(
        select(TeamMember)
        .where(TeamMember.category == member.category)
        .order_by(TeamMember.order_index.asc(), TeamMember.id.asc())
    ).all()

    # Find current index
    current_idx = None
    for i, m in enumerate(members_in_category):
        if m.id == member.id:
            current_idx = i
            break

    if current_idx is None:
        return

    if direction == "up" and current_idx > 0:
        # Swap with previous
        other = members_in_category[current_idx - 1]
        member.order_index, other.order_index = other.order_index, member.order_index
        db.add(member)
        db.add(other)
        db.commit()
    elif direction == "down" and current_idx < len(members_in_category) - 1:
        # Swap with next
        other = members_in_category[current_idx + 1]
        member.order_index, other.order_index = other.order_index, member.order_index
        db.add(member)
        db.add(other)
        db.commit()

    return


@router.delete("/admin/team/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_team_member(
    member_id: int = FPath(..., ge=1),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    """გუნდის წევრის წაშლა (სრული წაშლა ბაზიდან)"""
    _require_admin(db, authorization)

    member = db.get(TeamMember, member_id)
    if not member:
        return

    db.delete(member)
    db.commit()
    return


# ----------------- Public endpoints -----------------


@router.get("/team", response_model=TeamMembersListResponse)
def public_list_team_members(db: Session = Depends(get_db)):
    """გუნდის წევრების წამოღება მთავარი გვერდისთვის"""
    members = db.scalars(
        select(TeamMember).order_by(TeamMember.category.asc(), TeamMember.order_index.asc(), TeamMember.id.asc())
    ).all()
    return TeamMembersListResponse(items=[_team_member_out(m) for m in members])
