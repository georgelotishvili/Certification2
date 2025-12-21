from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic import EmailStr


def to_camel(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(word.capitalize() for word in parts[1:])


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class BlockOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    qty: int
    order_index: int


class ExamConfigResponse(BaseModel):
    exam_id: int
    title: str
    duration_minutes: int
    blocks: List[BlockOut]


class ExamSettingsResponse(CamelModel):
    exam_id: int
    title: str
    duration_minutes: int
    gate_password: str


class ExamSettingsUpdateRequest(CamelModel):
    exam_id: Optional[int] = None
    title: Optional[str] = None
    duration_minutes: Optional[int] = None
    gate_password: Optional[str] = None


class MultiApartmentSettingsResponse(CamelModel):
    model_config = ConfigDict(from_attributes=True)
    duration_minutes: int
    gate_password: str


class MultiApartmentPublicSettingsResponse(CamelModel):
    """
    Public-facing settings for multi-apartment evaluation.
    Exposes only duration_minutes (no gate password).
    """
    model_config = ConfigDict(from_attributes=True)
    duration_minutes: int


class MultiApartmentSettingsUpdateRequest(CamelModel):
    duration_minutes: Optional[int] = None
    gate_password: Optional[str] = None


class MultiApartmentGateVerifyRequest(BaseModel):
    """
    Public gate verification request for multi-apartment evaluation.
    Uses a single shared gate password from MultiApartmentSettings.
    """

    password: str


class MultiApartmentGateVerifyResponse(BaseModel):
    valid: bool


class AdminAnswerPayload(CamelModel):
    id: str
    text: str


class AdminQuestionPayload(CamelModel):
    id: str
    text: str
    code: str
    answers: List[AdminAnswerPayload]
    correct_answer_id: Optional[str] = None
    enabled: bool = True


class AdminBlockPayload(CamelModel):
    id: str
    number: int
    name: str
    qty: int
    enabled: bool = True
    questions: List[AdminQuestionPayload]


class AdminBlocksResponse(CamelModel):
    exam_id: int
    blocks: List[AdminBlockPayload]


class AdminBlocksUpdateRequest(CamelModel):
    exam_id: Optional[int] = None
    blocks: List[AdminBlockPayload]


class AuthCodeRequest(BaseModel):
    exam_id: int
    code: str


class AuthCodeResponse(BaseModel):
    session_id: int
    token: str
    exam_id: int
    duration_minutes: int
    ends_at: datetime


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    token: str
    user: "UserOut"


# Session start without code (admin-started)
class StartSessionRequest(BaseModel):
    exam_id: int
    candidate_first_name: str
    candidate_last_name: str
    candidate_code: str


class StartSessionResponse(BaseModel):
    session_id: int
    token: str
    exam_id: int
    duration_minutes: int
    ends_at: datetime


class OptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    text: str


class QuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    code: str
    text: str
    order_index: int
    options: List[OptionOut]


class QuestionsResponse(BaseModel):
    block_id: int
    block_title: str
    qty: int
    questions: List[QuestionOut]


class AnswerRequest(BaseModel):
    question_id: int
    option_id: int


class AnswerResponse(BaseModel):
    correct: bool


class FinishResponse(BaseModel):
    total_questions: int
    answered: int
    correct: int
    score_percent: float
    block_stats: List[dict]


class MediaUploadResponse(BaseModel):
    next_chunk_index: int
    completed: bool


class ExamGateVerifyRequest(BaseModel):
    exam_id: int
    password: str


class ExamGateVerifyResponse(BaseModel):
    valid: bool


class AdminStatsResponse(BaseModel):
    total_blocks: int
    total_questions: int
    enabled_blocks: int
    enabled_questions: int


# Admin results list/detail
class ResultListItem(BaseModel):
    session_id: int
    started_at: datetime
    finished_at: datetime | None
    candidate_first_name: str | None
    candidate_last_name: str | None
    candidate_code: str | None
    score_percent: float
    exam_id: int | None = None
    ends_at: datetime | None = None
    status: str = "unknown"
    personal_id: str | None = None


class ResultListResponse(BaseModel):
    items: List[ResultListItem]
    total: int


class AnswerOptionDetail(BaseModel):
    option_id: int
    option_text: str
    is_correct: bool
    is_selected: bool


class AnswerDetail(BaseModel):
    question_id: int
    question_code: str
    question_text: str
    block_id: int | None = None
    block_title: str | None = None
    selected_option_id: int | None = None
    selected_option_text: str | None = None
    is_correct: bool | None = None
    answered_at: datetime | None = None
    correct_option_id: int | None = None
    correct_option_text: str | None = None
    options: List[AnswerOptionDetail] = Field(default_factory=list)


class BlockStatDetail(BaseModel):
    block_id: int
    block_title: str | None = None
    total: int
    correct: int
    percent: float


class ResultDetailResponse(BaseModel):
    session: ResultListItem
    exam_title: str | None = None
    total_questions: int
    answered_questions: int
    correct_answers: int
    block_stats: List[BlockStatDetail]
    answers: List[AnswerDetail]


class ResultMediaItem(BaseModel):
    media_type: str
    available: bool
    download_url: str | None = None
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    duration_seconds: int | None = None
    updated_at: datetime | None = None


class ResultMediaResponse(BaseModel):
    items: List[ResultMediaItem]


# Users (registration and admin listing)
class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    personal_id: str
    first_name: str
    last_name: str
    phone: str
    email: str
    code: str
    is_admin: bool
    is_founder: bool = False
    exam_permission: bool = False
    created_at: datetime
    has_unseen_statements: bool | None = None
    unseen_statement_count: int | None = None
    certificate: dict | None = None
    certificate_info: dict | None = None
    photo_filename: str | None = None


class UserCreate(BaseModel):
    personal_id: str
    first_name: str
    last_name: str
    phone: str
    email: EmailStr
    password: str


class UserProfileUpdateRequest(BaseModel):
    """
    Self-service profile update.
    - first_name/last_name/phone/email/personal_id can be updated
    - current_password is required for any change
    - new_password is optional; when provided, confirm_new_password must match
    - email_verification_code is required when changing email
    """

    first_name: str | None = None
    last_name: str | None = None
    personal_id: str | None = None
    phone: str | None = None
    email: EmailStr | None = None
    current_password: str | None = None
    new_password: str | None = None
    confirm_new_password: str | None = None
    email_verification_code: str | None = None  # Required when changing email


class UsersListResponse(BaseModel):
    items: List[UserOut]
    total: int


class StatementCreate(BaseModel):
    message: str = Field(..., min_length=1, max_length=5000)


class StatementOut(BaseModel):
    id: int
    message: str
    created_at: datetime
    attachment_filename: str | None = None


class AdminStatementOut(BaseModel):
    id: int
    user_id: int
    user_first_name: str | None = None
    user_last_name: str | None = None
    user_email: str | None = None
    message: str
    created_at: datetime
    seen_at: datetime | None = None
    seen_by: str | None = None
    attachment_filename: str | None = None
    attachment_size_bytes: int | None = None


class AdminStatementsResponse(BaseModel):
    items: List[AdminStatementOut]
    total: int


class StatementSeenRequest(BaseModel):
    statement_ids: List[int]


class ToggleAdminRequest(BaseModel):
    is_admin: bool


class ToggleExamPermissionRequest(BaseModel):
    exam_permission: bool


class AdminUserUpdateRequest(CamelModel):
    personal_id: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[EmailStr] = None
    code: Optional[str] = None


class CertificateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    user_id: int
    unique_code: str | None = None
    level: str  # architect, expert
    status: str  # active, suspended, expired
    issue_date: datetime | None = None
    validity_term: int | None = None  # years
    valid_until: datetime | None = None
    exam_score: int | None = None
    filename: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    created_at: datetime
    updated_at: datetime


class CertificateCreate(BaseModel):
    unique_code: str | None = None
    level: str = "architect"  # architect, expert
    status: str = "active"  # active, suspended, expired
    issue_date: datetime | None = None
    validity_term: int | None = None  # years
    valid_until: datetime | None = None
    exam_score: int | None = None


class CertificateUpdate(CamelModel):
    unique_code: Optional[str] = None
    level: Optional[str] = None
    status: Optional[str] = None
    issue_date: Optional[datetime] = None
    validity_term: Optional[int] = None
    valid_until: Optional[datetime] = None
    exam_score: Optional[int] = None


class RegistryPersonOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    full_name: str
    photo_url: str
    unique_code: str
    qualification: str
    certificate_status: str
    rating: float | None = None
    exam_score: int | None = None
    registration_date: datetime


# Reviews (ratings and comments)
class ReviewCriteria(BaseModel):
    integrity: float = Field(ge=0, le=5)
    responsibility: float = Field(ge=0, le=5)
    knowledge_experience: float = Field(ge=0, le=5)
    professional_skills: float = Field(ge=0, le=5)
    price_quality: float = Field(ge=0, le=5)


class ReviewRatingCreate(BaseModel):
    criteria: ReviewCriteria


class ReviewCommentCreate(BaseModel):
    message: str


class ReviewCommentOut(BaseModel):
    id: int
    target_user_id: int
    author_user_id: int
    author_first_name: str | None = None
    author_last_name: str | None = None
    message: str
    created_at: datetime


class ReviewsSummaryOut(BaseModel):
    target_user_id: int
    average: float
    ratings_count: int
    actor_score: float | None = None
    actor_criteria: ReviewCriteria | None = None
    comments: List[ReviewCommentOut] = Field(default_factory=list)


# Expert uploads
class ExpertUploadOut(BaseModel):
    id: int
    unique_code: str
    status: str
    building_function: str
    cadastral_code: str
    project_address: str
    expertise_filename: str | None = None
    project_filename: str | None = None
    created_at: datetime
    submitted_at: datetime | None = None


class ExpertUploadCreate(BaseModel):
    building_function: str
    cadastral_code: str


class ExpertUploadUpdate(BaseModel):
    building_function: str | None = None
    cadastral_code: str | None = None


# Multi-apartment project evaluation
class MultiApartmentAnswerPayload(CamelModel):
    id: str
    text: str


class MultiApartmentProjectPayload(CamelModel):
    id: str
    number: int
    code: str
    pdfFile: Optional[str] = None
    answers: List[MultiApartmentAnswerPayload]
    correctAnswerId: Optional[str] = None
    # New: support multiple correct answers per project.
    # Admin UI can now mark several answers as correct; this array contains
    # the IDs of all correct answers. For backwards compatibility,
    # correctAnswerId may still be used to hold the first correct ID.
    correctAnswerIds: Optional[List[str]] = None


class MultiApartmentProjectsResponse(CamelModel):
    projects: List[MultiApartmentProjectPayload]


class MultiApartmentProjectsUpdateRequest(CamelModel):
    projects: List[MultiApartmentProjectPayload]


class PublicMultiApartmentProjectResponse(CamelModel):
    id: int
    number: int
    code: str
    pdfUrl: Optional[str] = None
    answers: List[MultiApartmentAnswerPayload]


class MultiApartmentEvaluationSubmitRequest(CamelModel):
    projectCode: str
    selectedAnswerId: int


class GuideVideoOut(BaseModel):
    id: int
    filename: str
    mime_type: str | None = None
    size_bytes: int | None = None
    order_index: int
    created_at: datetime
    url: str


class GuideVideosReorderRequest(BaseModel):
    ids: List[int]


class AppFileOut(BaseModel):
    id: int
    filename: str
    mime_type: str | None = None
    size_bytes: int | None = None
    created_at: datetime
    url: str


# Multi-functional project evaluation
class MultiFunctionalAnswerPayload(CamelModel):
    id: str
    text: str


class MultiFunctionalProjectPayload(CamelModel):
    id: str
    number: int
    code: str
    pdfFile: Optional[str] = None
    answers: List[MultiFunctionalAnswerPayload]
    correctAnswerId: Optional[str] = None
    # New: support multiple correct answers per project.
    # Admin UI can now mark several answers as correct; this array contains
    # the IDs of all correct answers. For backwards compatibility,
    # correctAnswerId may still be used to hold the first correct ID.
    correctAnswerIds: Optional[List[str]] = None


class MultiFunctionalProjectsResponse(CamelModel):
    projects: List[MultiFunctionalProjectPayload]


class MultiFunctionalProjectsUpdateRequest(CamelModel):
    projects: List[MultiFunctionalProjectPayload]


class PublicMultiFunctionalProjectResponse(CamelModel):
    id: int
    number: int
    code: str
    pdfUrl: Optional[str] = None
    answers: List[MultiFunctionalAnswerPayload]


class MultiFunctionalEvaluationSubmitRequest(CamelModel):
    projectCode: str
    selectedAnswerId: int


class MultiFunctionalSettingsResponse(CamelModel):
    model_config = ConfigDict(from_attributes=True)
    duration_minutes: int
    gate_password: str


class MultiFunctionalPublicSettingsResponse(CamelModel):
    """
    Public-facing settings for multi-functional evaluation.
    Exposes only duration_minutes (no gate password).
    """
    model_config = ConfigDict(from_attributes=True)
    duration_minutes: int


class MultiFunctionalSettingsUpdateRequest(CamelModel):
    duration_minutes: Optional[int] = None
    gate_password: Optional[str] = None


class MultiFunctionalGateVerifyRequest(BaseModel):
    """
    Public gate verification request for multi-functional evaluation.
    Uses a single shared gate password from MultiFunctionalSettings.
    """

    password: str


class MultiFunctionalGateVerifyResponse(BaseModel):
    valid: bool


# Email verification
class SendVerificationCodeRequest(BaseModel):
    email: EmailStr
    purpose: str = "register"  # "register" or "update"


class SendVerificationCodeResponse(BaseModel):
    success: bool
    message: str
    expires_in: int  # seconds


class VerifyCodeRequest(BaseModel):
    email: EmailStr
    code: str
    purpose: str = "register"


class VerifyCodeResponse(BaseModel):
    valid: bool


# Password recovery
class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    success: bool
    message: str


# Extended registration with verification
class UserCreateWithVerification(BaseModel):
    personal_id: str
    first_name: str
    last_name: str
    phone: str
    email: EmailStr
    password: str
    verification_code: str