Backend (FastAPI) ინსტრუქცია

საჭიროებები:
- Python 3.10+

დაყენება:
1) ვირტუალური გარემო (არჩევითი)
   python -m venv .venv
   .venv\\Scripts\\activate
2) პაკეტების დაყენება
   pip install -r backend/requirements.txt
3) სიდ მონაცემები (არჩევითი)
   python -m backend.scripts.seed
4) გაშვება
   uvicorn backend.app.main:app --reload

ძირიანი ენდპოინტები:
- POST /auth/code — კოდის ვალიდაცია, სესიის შექმნა
- GET /exam/{exam_id}/config — გამოცდის პარამეტრები და ბლოკები
- GET /exam/{session_id}/questions?block_id=... — ამ სესიისთვის შერჩეული კითხვები ბლოკიდან
- POST /exam/{session_id}/answer — პასუხის შენახვა (ქულა სერვერზე)
- POST /exam/{session_id}/finish — სესიის დასრულება და ქულის დაბრუნება
- GET /admin/stats — ჯამური ბლოკები/კითხვები

ბაზა: SQLite (backend/app.db). სურვილის შემთხვევაში მარტივად გადადის Postgres-ზე.

