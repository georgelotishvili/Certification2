"""Read-only, candidate-scoped production acceptance inspection. No DB/source export."""
import json
import sys

import deploy_codes_schedules_20261008 as release

release.FILES = []

REMOTE_CHECK = r"""
from datetime import datetime, timezone
def json_number_normalized(value):
    # JS JSON roundtrips encode integral floats as integers (0.0 -> 0).
    if isinstance(value,float) and value.is_integer(): return int(value)
    if isinstance(value,list): return [json_number_normalized(v) for v in value]
    if isinstance(value,dict): return {k:json_number_normalized(v) for k,v in value.items()}
    return value
with closing(sqlite3.connect(DB.as_uri()+'?mode=ro',uri=True)) as db:
    db.execute('PRAGMA query_only=ON')
    db.row_factory=sqlite3.Row
    users=db.execute('SELECT id,first_name,last_name FROM users WHERE trim(first_name)=? AND trim(last_name)=?',
        ('ნათია','ფოფხაძე')).fetchall()
    assert len(users)==1, 'Candidate match count: '+str(len(users))
    uid=users[0]['id']
    since='2026-10-08 22:00:00'
    attempts=[]
    for row in db.execute('''SELECT id,user_id,stage,stage_grant_id,session_id,project_id,
        started_at,ends_at,submission_id,payload_hash,submitted_at,receipt
        FROM offline_exam_attempts WHERE user_id=? AND started_at>=? ORDER BY id DESC LIMIT 5''',(uid,since)):
        attempt=dict(row)
        raw_receipt=attempt.pop('receipt')
        receipt=json.loads(raw_receipt) if raw_receipt else None
        attempt['receipt_present']=receipt is not None
        fields=['session_id','stage_grant_id','submission_id','total_questions','answered','correct','score_percent',
            'id','userId','stageGrantId','offlineSubmissionId','correctCount','wrongCount','totalCorrectAnswers','percentage']
        attempt['receipt_summary']={key:receipt[key] for key in fields if key in receipt} if receipt else None
        attempt['receipt_sha256']=digest(json.dumps(receipt,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()) if receipt else None
        attempt['receipt_json_number_normalized_sha256']=digest(json.dumps(json_number_normalized(receipt),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()) if receipt else None
        attempt['snapshot_exists']=db.execute('SELECT count(*) FROM offline_exam_content WHERE attempt_id=?',(row['id'],)).fetchone()[0]==1
        attempt['same_submission_receipts']=db.execute('SELECT count(*) FROM offline_exam_attempts WHERE user_id=? AND submission_id=?',(uid,row['submission_id'])).fetchone()[0] if row['submission_id'] else 0
        if row['session_id']:
            session=db.execute('''SELECT id,user_id,exam_id,stage_grant_id,started_at,ends_at,finished_at,active,score_percent
                FROM sessions WHERE id=? AND user_id=?''',(row['session_id'],uid)).fetchone()
            attempt['session']=dict(session) if session else None
            answers=db.execute('SELECT question_id,option_id FROM answers WHERE session_id=? ORDER BY question_id',(row['session_id'],)).fetchall()
            pairs=[[a['question_id'],a['option_id']] for a in answers]
            attempt['stored_answers_count']=len(pairs)
            attempt['stored_answers_sha256']=digest(json.dumps(pairs,separators=(',',':')).encode())
            attempt['duplicate_answer_questions']=db.execute('''SELECT count(*) FROM
                (SELECT question_id FROM answers WHERE session_id=? GROUP BY question_id HAVING count(*)>1)''',(row['session_id'],)).fetchone()[0]
            attempt['sessions_for_grant']=db.execute('SELECT count(*) FROM sessions WHERE user_id=? AND stage_grant_id=?',(uid,row['stage_grant_id'])).fetchone()[0]
        attempts.append(attempt)
    grants=[dict(r) for r in db.execute('''SELECT id,stage,granted_at,expires_at,started_at,consumed_at,revoked_at,expired_at
        FROM user_exam_stage_grants WHERE user_id=? AND granted_at>=? ORDER BY id DESC LIMIT 10''',(uid,since))]
    counts={
        'test_offline_attempts':db.execute('SELECT count(*) FROM offline_exam_attempts WHERE user_id=? AND started_at>=?',(uid,since)).fetchone()[0],
        'test_unsubmitted_offline_attempts':db.execute('SELECT count(*) FROM offline_exam_attempts WHERE user_id=? AND started_at>=? AND submitted_at IS NULL',(uid,since)).fetchone()[0],
        'test_sessions':db.execute('SELECT count(*) FROM sessions WHERE user_id=? AND started_at>=?',(uid,since)).fetchone()[0],
        'unfinished_sessions':db.execute('SELECT count(*) FROM sessions WHERE user_id=? AND active=1 AND finished_at IS NULL',(uid,)).fetchone()[0],
        'available_or_started_grants':db.execute("SELECT count(*) FROM user_exam_stage_grants WHERE user_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL AND (started_at IS NOT NULL OR datetime(expires_at)>datetime('now'))",(uid,)).fetchone()[0],
    }
    slot=db.execute('SELECT filename,size_bytes FROM app_files WHERE id=1').fetchone()
result={'read_only':True,'checked_at_utc':datetime.now(timezone.utc).isoformat(),'user_id':uid,'pid':service_pid(),
    'capabilities':get_json('/exam/offline/capabilities'),'published_app':dict(slot),**counts,'attempts':attempts,'grants':grants}
print(json.dumps(result,ensure_ascii=True))
"""

if __name__=='__main__':
    assert sys.argv[1:] == ['server']
    print(json.dumps(release.remote(REMOTE_CHECK),ensure_ascii=True,indent=2))
