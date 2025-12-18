from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy.orm import Session

from backend.app.database import engine, SessionLocal
from backend.app.models import Base, Exam, Block, Question, Option, ExamCode
from backend.app.security import hash_code


def seed() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db: Session = SessionLocal()
    try:
        exam = Exam(title="Default Exam", duration_minutes=45, gate_password="cpig")
        db.add(exam)
        db.flush()

        b1 = Block(exam_id=exam.id, title="ბლოკი 1", qty=2, order_index=1, enabled=True)
        b2 = Block(exam_id=exam.id, title="ბლოკი 2", qty=2, order_index=2, enabled=True)
        db.add_all([b1, b2])
        db.flush()

        q1 = Question(block_id=b1.id, code="Q-0001", text="რომელი არის A?", order_index=1, enabled=True)
        q2 = Question(block_id=b1.id, code="Q-0002", text="რომელი არის B?", order_index=2, enabled=True)
        q3 = Question(block_id=b1.id, code="Q-0003", text="რომელი არის C?", order_index=3, enabled=True)

        q4 = Question(block_id=b2.id, code="Q-0004", text="ფერი წითელია?", order_index=1, enabled=True)
        q5 = Question(block_id=b2.id, code="Q-0005", text="ფერი მწვანეა?", order_index=2, enabled=True)
        q6 = Question(block_id=b2.id, code="Q-0006", text="ფერი ლურჯია?", order_index=3, enabled=True)
        db.add_all([q1, q2, q3, q4, q5, q6])
        db.flush()

        # options: exactly one correct per question
        db.add_all([
            Option(question_id=q1.id, text="A", is_correct=True),
            Option(question_id=q1.id, text="B", is_correct=False),
            Option(question_id=q1.id, text="C", is_correct=False),

            Option(question_id=q2.id, text="A", is_correct=False),
            Option(question_id=q2.id, text="B", is_correct=True),
            Option(question_id=q2.id, text="C", is_correct=False),

            Option(question_id=q3.id, text="A", is_correct=False),
            Option(question_id=q3.id, text="B", is_correct=False),
            Option(question_id=q3.id, text="C", is_correct=True),

            Option(question_id=q4.id, text="დიახ", is_correct=True),
            Option(question_id=q4.id, text="არა", is_correct=False),

            Option(question_id=q5.id, text="დიახ", is_correct=True),
            Option(question_id=q5.id, text="არა", is_correct=False),

            Option(question_id=q6.id, text="დიახ", is_correct=False),
            Option(question_id=q6.id, text="არა", is_correct=True),
        ])

        # exam code: TEST123
        code = ExamCode(exam_id=exam.id, code_hash=hash_code("TEST123"), used=False, disabled=False)
        db.add(code)

        db.commit()
        print("Seed completed. Use code: TEST123")
    finally:
        db.close()


if __name__ == "__main__":
    seed()


