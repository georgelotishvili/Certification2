from __future__ import annotations

import random
import string
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Float,
    Numeric,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


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


class Block(Base):
    __tablename__ = "blocks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    exam_id: Mapped[int] = mapped_column(ForeignKey("exams.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(255))
    qty: Mapped[int] = mapped_column(Integer, default=1)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)

    exam: Mapped[Exam] = relationship("Exam", back_populates="blocks")
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
    # Candidate metadata (optional, filled when using admin-started sessions)
    candidate_first_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    candidate_last_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    candidate_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # Aggregated results
    block_stats: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON
    score_percent: Mapped[float] = mapped_column(Float, default=0.0)

    exam: Mapped[Exam] = relationship("Exam", back_populates="sessions")
    code: Mapped[ExamCode] = relationship("ExamCode", back_populates="sessions")
    answers: Mapped[List[Answer]] = relationship("Answer", back_populates="session", cascade="all, delete-orphan")
    media_entries: Mapped[List["ExamMedia"]] = relationship(
        "ExamMedia",
        back_populates="session",
        cascade="all, delete-orphan",
    )


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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Profile photo
    photo_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    photo_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
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


class Statement(Base):
    __tablename__ = "statements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    seen_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Attachment metadata (optional)
    attachment_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    attachment_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    attachment_mime_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    attachment_size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="statements")


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
    level: Mapped[str] = mapped_column(String(32), default="architect")  # architect, expert
    status: Mapped[str] = mapped_column(String(32), default="active")  # active, suspended, expired
    issue_date: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    validity_term: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # years
    valid_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, index=True)
    exam_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=0)
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