from __future__ import annotations

import random
import string
from datetime import date, datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Index,
    String,
    Text,
    UniqueConstraint,
    Float,
    Numeric,
    event,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session as OrmSession, mapped_column, relationship


def _generate_gate_password() -> str:
    """Generate a random 6-character gate password."""
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))


class Base(DeclarativeBase):
    pass


class Exam(Base):
    __tablename__ = "exams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(255), default="Default Exam")
    duration_minutes: Mapped[int] = mapped_column(Integer, default=45)
    gate_password: Mapped[str] = mapped_column(String(128), default=_generate_gate_password)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    blocks: Mapped[List[Block]] = relationship("Block", back_populates="exam", cascade="all, delete-orphan")
    codes: Mapped[List[ExamCode]] = relationship("ExamCode", back_populates="exam", cascade="all, delete-orphan")
    sessions: Mapped[List[Session]] = relationship("Session", back_populates="exam", cascade="all, delete-orphan")


class TaxonomyChapter(Base):
    __tablename__ = "taxonomy_chapters"
    __table_args__ = (
        UniqueConstraint("name", name="uq_taxonomy_chapters_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    subchapters: Mapped[List["TaxonomySubchapter"]] = relationship(
        "TaxonomySubchapter",
        back_populates="chapter",
        cascade="all, delete-orphan",
        order_by="TaxonomySubchapter.order_index",
    )
    blocks: Mapped[List["Block"]] = relationship("Block", back_populates="chapter")


class TaxonomySubchapter(Base):
    __tablename__ = "taxonomy_subchapters"
    __table_args__ = (
        UniqueConstraint("chapter_id", "name", name="uq_taxonomy_subchapters_chapter_name"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    chapter_id: Mapped[int] = mapped_column(ForeignKey("taxonomy_chapters.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    chapter: Mapped[TaxonomyChapter] = relationship("TaxonomyChapter", back_populates="subchapters")
    blocks: Mapped[List["Block"]] = relationship("Block", back_populates="subchapter")


class Block(Base):
    __tablename__ = "blocks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"))
    chapter_id: Mapped[Optional[int]] = mapped_column(ForeignKey("taxonomy_chapters.id", ondelete="SET NULL"), nullable=True, index=True)
    subchapter_id: Mapped[Optional[int]] = mapped_column(ForeignKey("taxonomy_subchapters.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    qty: Mapped[int] = mapped_column(Integer, default=1)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    exam: Mapped[Exam] = relationship("Exam", back_populates="blocks")
    chapter: Mapped[Optional[TaxonomyChapter]] = relationship("TaxonomyChapter", back_populates="blocks")
    subchapter: Mapped[Optional[TaxonomySubchapter]] = relationship("TaxonomySubchapter", back_populates="blocks")
    questions: Mapped[List[Question]] = relationship("Question", back_populates="block", cascade="all, delete-orphan", order_by="Question.order_index")


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (
        UniqueConstraint("code", name="uq_questions_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    block_id: Mapped[int] = mapped_column(ForeignKey("blocks.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    block: Mapped[Block] = relationship("Block", back_populates="questions")
    options: Mapped[List[Option]] = relationship("Option", back_populates="question", cascade="all, delete-orphan")
    answers: Mapped[List[Answer]] = relationship("Answer", back_populates="question")


class Option(Base):
    __tablename__ = "options"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False)

    question: Mapped[Question] = relationship("Question", back_populates="options")


class ExamCode(Base):
    __tablename__ = "exam_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"))
    code_hash: Mapped[str] = mapped_column(String(255), index=True)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    exam: Mapped[Exam] = relationship("Exam", back_populates="codes")
    sessions: Mapped[List[Session]] = relationship("Session", back_populates="code")


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"))
    code_id: Mapped[Optional[int]] = mapped_column(ForeignKey("exam_codes.id", ondelete="SET NULL"), nullable=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    selected_map: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    stage_grant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("user_exam_stage_grants.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    # Candidate metadata (optional, filled when using admin-started sessions)
    candidate_first_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    candidate_last_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    candidate_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Aggregated results
    block_stats: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    exam_snapshot: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    score_percent: Mapped[float] = mapped_column(Float, default=0.0)

    exam: Mapped[Exam] = relationship("Exam", back_populates="sessions")
    code: Mapped[ExamCode] = relationship("ExamCode", back_populates="sessions")
    user: Mapped[Optional["User"]] = relationship("User", back_populates="exam_sessions")
    answers: Mapped[List[Answer]] = relationship("Answer", back_populates="session", cascade="all, delete-orphan")
    media_entries: Mapped[List["ExamMedia"]] = relationship(
        "ExamMedia",
        back_populates="session",
        cascade="all, delete-orphan",
    )


class OfflineExamAttempt(Base):
    """Opt-in, exact-attempt submission capability and immutable final receipt.

    This is a separate additive table: old clients keep their existing deadlines.
    A capability authorizes only completion, never another start or account access.
    """

    __tablename__ = "offline_exam_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    start_request_id: Mapped[Optional[str]] = mapped_column(String(36), unique=True, nullable=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(String(32))
    stage_grant_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("user_exam_stage_grants.id", ondelete="CASCADE"), unique=True, nullable=True
    )
    session_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), unique=True, nullable=True
    )
    project_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    project_code: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime)
    ends_at: Mapped[datetime] = mapped_column(DateTime)
    submission_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    payload_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    receipt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)


class OfflineExamContent(Base):
    """Server-only immutable question/answer-key version for an offline attempt."""

    __tablename__ = "offline_exam_content"

    attempt_id: Mapped[int] = mapped_column(
        ForeignKey("offline_exam_attempts.id", ondelete="CASCADE"), primary_key=True
    )
    snapshot: Mapped[str] = mapped_column(Text)
    evaluation_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, index=True)


class Answer(Base):
    __tablename__ = "answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    question_id: Mapped[int] = mapped_column(ForeignKey("questions.id", ondelete="CASCADE"))
    option_id: Mapped[int] = mapped_column(ForeignKey("options.id", ondelete="CASCADE"))
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False)
    answered_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    session: Mapped[Session] = relationship("Session", back_populates="answers")
    question: Mapped[Question] = relationship("Question", back_populates="answers")



class UserCodeReservation(Base):
    """Minimal identity-to-code record that survives account deletion."""

    __tablename__ = "user_code_reservations"
    __table_args__ = (
        UniqueConstraint("code", name="uq_user_code_reservations_code"),
    )

    # Deliberately no foreign key to users: deleting an account must not delete
    # this reservation or make its code available to another person.
    personal_id: Mapped[str] = mapped_column(String(11), primary_key=True)
    code: Mapped[str] = mapped_column(String(10))


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("personal_id", name="uq_users_personal_id"),
        UniqueConstraint("code", name="uq_users_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    personal_id: Mapped[str] = mapped_column(String(11), index=True)
    first_name: Mapped[str] = mapped_column(String(100))
    last_name: Mapped[str] = mapped_column(String(100))
    phone: Mapped[str] = mapped_column(String(20), index=True)
    email: Mapped[str] = mapped_column(String(255), index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    code: Mapped[str] = mapped_column(String(10), index=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    exam_permission: Mapped[bool] = mapped_column(Boolean, default=False)
    exam_stage: Mapped[str] = mapped_column(String(32), default="none")
    exam_stage_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    exam_stage_started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Profile photo
    photo_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    photo_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Candidate status tracking ('exam_candidate', 'cert_candidate', or None)
    candidate_status: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    candidate_category: Mapped[str | None] = mapped_column(String(16), nullable=True)
    candidate_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    statements: Mapped[List["Statement"]] = relationship(
        "Statement",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    certificate: Mapped["Certificate"] = relationship(
        "Certificate",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan",
    )
    sessions: Mapped[List["UserSession"]] = relationship(
        "UserSession",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    exam_sessions: Mapped[List["Session"]] = relationship(
        "Session",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    exam_schedules: Mapped[List["ExamSchedule"]] = relationship(
        "ExamSchedule",
        back_populates="user",
        cascade="all, delete-orphan",
    )
    planning_letters: Mapped[List["PlanningLetter"]] = relationship(
        "PlanningLetter", back_populates="user", cascade="all, delete-orphan",
    )


class UserExamStageGrant(Base):
    """One independently issued, historical permission for one exam stage."""

    __tablename__ = "user_exam_stage_grants"
    __table_args__ = (
        CheckConstraint(
            "stage IN ('theory', 'project_stage_1', 'project_stage_2')",
            name="ck_user_exam_stage_grants_stage",
        ),
        Index(
            "uq_user_exam_stage_grants_open",
            "user_id",
            "stage",
            unique=True,
            sqlite_where=text(
                "consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL"
            ),
        ),
        Index("ix_user_exam_stage_grants_user_stage", "user_id", "stage", "id"),
        # Grant IDs cross the desktop/API boundary; never let a stale result
        # target a later generation after cascaded account deletion.
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    stage: Mapped[str] = mapped_column(String(32), index=True)
    granted_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    expired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class ExamSchedule(Base):
    """Administrative planning only; never grants permission to take an exam."""

    __tablename__ = "exam_schedules"
    __table_args__ = (
        UniqueConstraint("user_id", "exam_date", "period", name="uq_exam_schedules_user_date_period"),
        CheckConstraint("period IN ('morning', 'evening')", name="ck_exam_schedules_period"),
        Index("ix_exam_schedules_date_period_user", "exam_date", "period", "user_id"),
        # A stale admin page must never target a newly created row by a reused ID.
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    exam_date: Mapped[date] = mapped_column(Date)
    period: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship("User", back_populates="exam_schedules")


class PlanningTemplate(Base):
    """Shared editable text; sent letters always contain an independent snapshot."""

    __tablename__ = "planning_templates"
    __table_args__ = (CheckConstraint("kind IN ('exam', 'certificate')", name="ck_planning_template_kind"),)

    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    subject: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    attachment_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)


class PlanningLetter(Base):
    """Immutable appointment/email snapshot, independent of exam permissions."""

    __tablename__ = "planning_letters"
    __table_args__ = (
        CheckConstraint("kind IN ('exam', 'certificate')", name="ck_planning_letter_kind"),
        CheckConstraint("status IN ('sending', 'sent', 'failed', 'simulated', 'uncertain')", name="ck_planning_letter_status"),
        Index("ix_planning_letters_user_date", "user_id", "event_date", "id"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    exam_schedule_id: Mapped[int | None] = mapped_column(ForeignKey("exam_schedules.id", ondelete="SET NULL"), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(16))
    event_date: Mapped[date] = mapped_column(Date)
    event_time: Mapped[str] = mapped_column(String(5))
    period: Mapped[str | None] = mapped_column(String(16), nullable=True)
    request_id: Mapped[str] = mapped_column(String(36), unique=True)
    request_fingerprint: Mapped[str] = mapped_column(String(64))
    to_email: Mapped[str] = mapped_column(String(255))
    subject: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="sending")
    error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_by: Mapped[str] = mapped_column(String(255))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    attachment_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    attachment_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    doc_number: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    statement_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)

    user: Mapped["User"] = relationship("User", back_populates="planning_letters")


class Statement(Base):
    __tablename__ = "statements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    seen_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    answered_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Attachment metadata (slot 1 / general attachment + slots 2 & 3 for exam application)
    attachment_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    attachment_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment_mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attachment_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attachment2_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    attachment2_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment2_mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attachment2_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attachment3_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    attachment3_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment3_mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attachment3_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    doc_number: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)

    user: Mapped["User"] = relationship("User", back_populates="statements")


def build_statement_attachments_list(statement: Statement | None) -> list[dict]:
    if statement is None:
        return []
    items: list[dict] = []
    if getattr(statement, "attachment_filename", None) or getattr(statement, "attachment_path", None):
        items.append({
            "slot": 1,
            "filename": statement.attachment_filename or "file_1",
            "size_bytes": statement.attachment_size_bytes,
        })
    if getattr(statement, "attachment2_filename", None) or getattr(statement, "attachment2_path", None):
        items.append({
            "slot": 2,
            "filename": statement.attachment2_filename or "file_2",
            "size_bytes": statement.attachment2_size_bytes,
        })
    if getattr(statement, "attachment3_filename", None) or getattr(statement, "attachment3_path", None):
        items.append({
            "slot": 3,
            "filename": statement.attachment3_filename or "file_3",
            "size_bytes": statement.attachment3_size_bytes,
        })
    return items


def iter_statement_attachment_paths(statement: Statement | None) -> list[str]:
    if statement is None:
        return []
    paths: list[str] = []
    for attr in ("attachment_path", "attachment2_path", "attachment3_path"):
        val = getattr(statement, attr, None)
        if val:
            paths.append(val)
    return paths


def format_statement_doc_number(statement: Statement | None) -> str | None:
    if statement is None:
        return None
    existing = (getattr(statement, "doc_number", None) or "").strip()
    if existing:
        return existing
    if getattr(statement, "id", None) is None:
        return None
    dt = getattr(statement, "created_at", None) or datetime.utcnow()
    year = dt.year if hasattr(dt, "year") else datetime.utcnow().year
    return f"IN-{year}-{int(statement.id):04d}"


def format_letter_doc_number(letter: PlanningLetter | None) -> str | None:
    if letter is None:
        return None
    existing = (getattr(letter, "doc_number", None) or "").strip()
    if existing:
        return existing
    if getattr(letter, "id", None) is None:
        return None
    dt = getattr(letter, "created_at", None) or getattr(letter, "event_date", None) or datetime.utcnow()
    year = dt.year if hasattr(dt, "year") else datetime.utcnow().year
    return f"OUT-{year}-{int(letter.id):04d}"


@event.listens_for(Statement, "after_insert")
def _assign_statement_doc_number(mapper, connection, target: Statement) -> None:
    if not (target.doc_number or "").strip() and target.id is not None:
        doc_num = format_statement_doc_number(target)
        if doc_num:
            target.doc_number = doc_num
            connection.execute(
                Statement.__table__.update()
                .where(Statement.__table__.c.id == target.id)
                .values(doc_number=doc_num)
            )


@event.listens_for(PlanningLetter, "after_insert")
def _assign_letter_doc_number(mapper, connection, target: PlanningLetter) -> None:
    if not (target.doc_number or "").strip() and target.id is not None:
        doc_num = format_letter_doc_number(target)
        if doc_num:
            target.doc_number = doc_num
            connection.execute(
                PlanningLetter.__table__.update()
                .where(PlanningLetter.__table__.c.id == target.id)
                .values(doc_number=doc_num)
            )


class UserSession(Base):
    __tablename__ = "user_sessions"
    __table_args__ = (
        UniqueConstraint("token", name="uq_user_sessions_token"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="sessions")


class ExamMedia(Base):
    __tablename__ = "exam_media"
    __table_args__ = (
        UniqueConstraint("session_id", "media_type", name="uq_exam_media_session_type"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    media_type: Mapped[str] = mapped_column(String(32), default="camera")
    storage_path: Mapped[str] = mapped_column(String(1024))
    filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(128), default="video/webm")
    size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    completed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    session: Mapped["Session"] = relationship("Session", back_populates="media_entries")


class Certificate(Base):
    __tablename__ = "certificates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True)
    unique_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    level: Mapped[str] = mapped_column(String(32), default="architect")  # architect, expert, municipal
    status: Mapped[str] = mapped_column(String(32), default="active")  # active, suspended, expired
    issue_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    validity_term: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # years
    valid_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    is_transitional: Mapped[bool] = mapped_column(Boolean, default=False)
    exam_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # File metadata
    file_path: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)
    filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    mime_type: Mapped[Optional[str]] = mapped_column(String(128), nullable=True, default="application/pdf")
    size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user: Mapped["User"] = relationship("User", back_populates="certificate")


class Rating(Base):
    __tablename__ = "ratings"
    __table_args__ = (
        UniqueConstraint("target_user_id", "author_user_id", name="uq_ratings_target_author"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    author_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    score: Mapped[int] = mapped_column(Integer, default=0)  # legacy 1..10 overall (kept for compatibility)
    # Five-criteria scores: 0.00..5.00 (stored with 2 decimal precision)
    integrity: Mapped[float] = mapped_column(Numeric(4, 2), default=0.00)
    responsibility: Mapped[float] = mapped_column(Numeric(4, 2), default=0.00)
    knowledge_experience: Mapped[float] = mapped_column(Numeric(4, 2), default=0.00)
    professional_skills: Mapped[float] = mapped_column(Numeric(4, 2), default=0.00)
    price_quality: Mapped[float] = mapped_column(Numeric(4, 2), default=0.00)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    author_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class ExpertUpload(Base):
    __tablename__ = "expert_uploads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    unique_code: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft, submitted
    building_function: Mapped[str] = mapped_column(String(255), default="")
    cadastral_code: Mapped[str] = mapped_column(String(255), default="")
    project_address: Mapped[str] = mapped_column(String(255), default="")
    expertise_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    expertise_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    project_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    project_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)


class MultiApartmentProject(Base):
    __tablename__ = "multi_apartment_projects"
    __table_args__ = (
        UniqueConstraint("code", name="uq_multi_apartment_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    number: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(32), index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    pdf_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    pdf_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    answers: Mapped[List["MultiApartmentAnswer"]] = relationship(
        "MultiApartmentAnswer",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="MultiApartmentAnswer.order_index",
    )
    submissions: Mapped[List["MultiApartmentSubmission"]] = relationship(
        "MultiApartmentSubmission",
        back_populates="project",
        cascade="all, delete-orphan",
    )


class MultiApartmentAnswer(Base):
    __tablename__ = "multi_apartment_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("multi_apartment_projects.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped["MultiApartmentProject"] = relationship("MultiApartmentProject", back_populates="answers")


class MultiApartmentSubmission(Base):
    __tablename__ = "multi_apartment_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("multi_apartment_projects.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    selected_answer_id: Mapped[int | None] = mapped_column(
        ForeignKey("multi_apartment_answers.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped["MultiApartmentProject"] = relationship("MultiApartmentProject", back_populates="submissions")
    user: Mapped["User"] = relationship("User")


class MultiApartmentSettings(Base):
    __tablename__ = "multi_apartment_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=60)
    gate_password: Mapped[str] = mapped_column(String(64), default=_generate_gate_password)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MultiApartmentEvaluation(Base):
    """მრავალბინიანის პროექტის შეფასების სრული შედეგი"""
    __tablename__ = "multi_apartment_evaluations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("multi_apartment_projects.id", ondelete="CASCADE"), index=True)
    stage_grant_id: Mapped[int | None] = mapped_column(
        ForeignKey("user_exam_stage_grants.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
        index=True,
    )
    project_code: Mapped[str] = mapped_column(String(50))
    project_name: Mapped[str] = mapped_column(String(255))
    
    # შედეგები
    percentage: Mapped[float] = mapped_column(Float, default=0.0)
    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    wrong_count: Mapped[int] = mapped_column(Integer, default=0)
    total_correct_answers: Mapped[int] = mapped_column(Integer, default=0)
    
    # მონიშნული პასუხების ID-ები (JSON)
    selected_answer_ids: Mapped[str] = mapped_column(Text, default="[]")
    
    # დრო
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    user: Mapped["User"] = relationship("User")
    project: Mapped["MultiApartmentProject"] = relationship("MultiApartmentProject")


class GuideVideo(Base):
    __tablename__ = "guide_videos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0, index=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    url: Mapped[str] = mapped_column(String(2048), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class AppFile(Base):
    __tablename__ = "app_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    storage_path: Mapped[str] = mapped_column(String(1024))
    filename: Mapped[str] = mapped_column(String(255))
    mime_type: Mapped[str] = mapped_column(String(128), default="application/octet-stream")
    size_bytes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class MultiFunctionalProject(Base):
    __tablename__ = "multi_functional_projects"
    __table_args__ = (
        UniqueConstraint("code", name="uq_multi_functional_code"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    number: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(32), index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    pdf_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    pdf_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    answers: Mapped[List["MultiFunctionalAnswer"]] = relationship(
        "MultiFunctionalAnswer",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="MultiFunctionalAnswer.order_index",
    )
    submissions: Mapped[List["MultiFunctionalSubmission"]] = relationship(
        "MultiFunctionalSubmission",
        back_populates="project",
        cascade="all, delete-orphan",
    )


class MultiFunctionalAnswer(Base):
    __tablename__ = "multi_functional_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("multi_functional_projects.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(Text)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    is_correct: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped["MultiFunctionalProject"] = relationship("MultiFunctionalProject", back_populates="answers")


class MultiFunctionalSubmission(Base):
    __tablename__ = "multi_functional_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("multi_functional_projects.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    selected_answer_id: Mapped[int | None] = mapped_column(
        ForeignKey("multi_functional_answers.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    project: Mapped["MultiFunctionalProject"] = relationship("MultiFunctionalProject", back_populates="submissions")
    user: Mapped["User"] = relationship("User")


class MultiFunctionalSettings(Base):
    __tablename__ = "multi_functional_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    duration_minutes: Mapped[int] = mapped_column(Integer, default=60)
    gate_password: Mapped[str] = mapped_column(String(64), default=_generate_gate_password)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MultiFunctionalEvaluation(Base):
    """მრავალფუნქციურის პროექტის შეფასების სრული შედეგი"""
    __tablename__ = "multi_functional_evaluations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("multi_functional_projects.id", ondelete="CASCADE"), index=True)
    stage_grant_id: Mapped[int | None] = mapped_column(
        ForeignKey("user_exam_stage_grants.id", ondelete="SET NULL"),
        nullable=True,
        unique=True,
        index=True,
    )
    project_code: Mapped[str] = mapped_column(String(50))
    project_name: Mapped[str] = mapped_column(String(255))
    
    # შედეგები
    percentage: Mapped[float] = mapped_column(Float, default=0.0)
    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    wrong_count: Mapped[int] = mapped_column(Integer, default=0)
    total_correct_answers: Mapped[int] = mapped_column(Integer, default=0)
    
    # მონიშნული პასუხების ID-ები (JSON)
    selected_answer_ids: Mapped[str] = mapped_column(Text, default="[]")
    
    # დრო
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    duration_seconds: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Regulation(Base):
    """რეგულაციები / დადგენილებები - გამოცდის დროს კანდიდატს გამოუჩნდება"""
    __tablename__ = "regulations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SiteDocument(Base):
    """საიტის დოკუმენტები - ინფორმაცია მენიუში გამოჩნდება"""
    __tablename__ = "site_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(255), default="")  # სათაური მენიუში
    content: Mapped[str] = mapped_column(Text, default="")  # HTML კონტენტი
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    contract_type: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    # Word ფაილის მეტადატა
    file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class GuideDocument(Base):
    """საინფორმაციო ნავიგაციის დოკუმენტები — ინფორმაცია მენიუში (მოდალურ ფანჯარაში)"""
    __tablename__ = "guide_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    title: Mapped[str] = mapped_column(String(255), default="გზამკვლევი")
    content: Mapped[str] = mapped_column(Text, default="")
    order_index: Mapped[int] = mapped_column(Integer, default=0, index=True)
    file_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    file_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

