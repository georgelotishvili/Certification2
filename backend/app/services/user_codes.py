"""Private, persistent registration codes; never restore account permissions."""
from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import User, UserCodeReservation


class UserCodeConflict(ValueError):
    """An identity or code is already bound to a different person."""


class UserCodeGenerationError(RuntimeError):
    """No unused code was found within the bounded allocation attempts."""


def generate_user_code(db: Session) -> str:
    for _ in range(100):
        code = str(1_000_000_000 + secrets.randbelow(9_000_000_000))
        reserved = db.scalar(select(UserCodeReservation.personal_id).where(UserCodeReservation.code == code))
        active = db.scalar(select(User.id).where(User.code == code))
        if reserved is None and active is None:
            return code
    # An unchecked fallback could hand out a deleted person's reserved code.
    raise UserCodeGenerationError('Unable to allocate an unused registration code')


def reserve_registration_code(db: Session, personal_id: str) -> str:
    reservation = db.get(UserCodeReservation, personal_id)
    if reservation is not None:
        conflicting_user = db.scalar(select(User.id).where(
            User.code == reservation.code,
            User.personal_id != personal_id,
        ))
        if conflicting_user is not None:
            raise UserCodeConflict('Reserved code belongs to a different active identity')
        return reservation.code

    code = generate_user_code(db)
    db.add(UserCodeReservation(personal_id=personal_id, code=code))
    # No independent commit/savepoint: user creation and this reservation must
    # either succeed together or roll back together.
    db.flush()
    return code


def remember_user_code(db: Session, user: User) -> None:
    """Preserve a legacy/current account's code before deleting its data."""
    if not user.personal_id or not user.code:
        raise UserCodeConflict('Account identity or code is missing')
    reservation = db.get(UserCodeReservation, user.personal_id)
    owner = db.scalar(select(UserCodeReservation).where(UserCodeReservation.code == user.code))
    if reservation is not None and reservation.code != user.code:
        raise UserCodeConflict('Identity is reserved with another code')
    if owner is not None and owner.personal_id != user.personal_id:
        raise UserCodeConflict('Code is reserved for another identity')
    if reservation is None:
        db.add(UserCodeReservation(personal_id=user.personal_id, code=user.code))
    db.flush()


def move_user_code(db: Session, user: User, new_personal_id: str) -> None:
    """Keep the immutable code when correcting a previously mistyped ID."""
    if new_personal_id == user.personal_id:
        remember_user_code(db, user)
        return
    if db.get(UserCodeReservation, new_personal_id) is not None:
        raise UserCodeConflict('Corrected identity already has a reserved code')
    conflicting_user = db.scalar(select(User.id).where(
        User.personal_id == new_personal_id,
        User.id != user.id,
    ))
    if conflicting_user is not None:
        raise UserCodeConflict('Corrected identity is already registered')
    remember_user_code(db, user)
    reservation = db.get(UserCodeReservation, user.personal_id)
    reservation.personal_id = new_personal_id
    db.flush()
