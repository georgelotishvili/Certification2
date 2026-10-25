(function (global) {
  const DEFAULT_EXAM_SUBJECT = 'გამოცდაზე დაშვება';
  const DEFAULT_EXAM_BODY = [
    'ადრესატი: {name}',
    '',
    'მოგესალმებით,',
    '',
    'გაცნობებთ, რომ თქვენი განაცხადი დადასტურდა და დაშვებული ხართ სერტიფიცირების გამოცდაზე. თქვენი გამოცდა დაიგეგმა {date}, {time}-ზე, მისამართზე: ქ. თბილისი, მირიან მეფის ქუჩა №98, მე-2 სართული, საოფისე ფართი №6.',
    '',
    'გამოცდაზე დასაშვებად აუცილებელია:',
    '- საგამოცდო მომსახურების ხელშეკრულებაზე ხელმოწერამდე გადაიხადოთ საგამოცდო საფასური (350 ლარი) უნაღდო ანგარიშსწორებით ანგარიშზე: GE33TB7313736080100014 (დანიშნულება: საგამოცდო საფასური, {name});',
    '- საგამოცდო ცენტრში გამოცხადდეთ გამოცდის დაწყებამდე 30 წუთით ადრე პირადობის დამადასტურებელი მოქმედი დოკუმენტით, ხელშეკრულებაზე ხელმოწერისა და რეგისტრაციის გავლის მიზნით.',
    '',
    'გთხოვთ წინასწარ გაეცნოთ შესაბამისი მომსახურების ხელშეკრულებას, რომელიც განთავსებულია საიტზე gipc.org.ge.',
    '',
    'პატივისცემით,',
    'საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი',
  ].join('\n');

  const DEFAULT_REJECTION_SUBJECT = 'განაცხადის უარყოფა';
  const DEFAULT_REJECTION_BODY = [
    'ადრესატი: {name}',
    '',
    'მოგესალმებით,',
    '',
    'გაცნობებთ, რომ თქვენი განაცხადი არ დაკმაყოფილდა, ვინაიდან ვერ აკმაყოფილებთ საქართველოს მთავრობის №134 დადგენილებითა და სერტიფიკაციის სქემით განსაზღვრულ სასერტიფიკაციო მოთხოვნებს.',
    '',
    'გადაწყვეტილების გასაჩივრების წესი და ვადები იხილეთ საიტზე gipc.org.ge-ზე გამოქვეყნებულ შესაბამის ოფიციალურ დოკუმენტებში.',
    '',
    'პატივისცემით,',
    'საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი',
  ].join('\n');

  const DEFAULT_CERTIFICATE_SUBJECT = 'სერტიფიცირების გამოცდის წარმატებით ჩაბარება';
  const DEFAULT_CERTIFICATE_BODY = [
    'ადრესატი: {name}',
    '',
    'მოგესალმებით,',
    '',
    'გაცნობებთ, რომ თქვენ წარმატებით ჩააბარეთ სერტიფიცირების გამოცდა და მიღებულია გადაწყვეტილება თქვენთვის [კატეგორია] სერტიფიკატის მინიჭების შესახებ.',
    '',
    'სერტიფიკატის მისაღებად აუცილებელია წინამდებარე შეტყობინების მიღებიდან 30 კალენდარული დღის ვადაში:',
    '- სასერტიფიკაციო ხელშეკრულებაზე ხელმოწერამდე გადაიხადოთ სერტიფიკატის გაცემის საფასური (3 000 ლარი) უნაღდო ანგარიშსწორებით ანგარიშზე: GE33TB7313736080100014 (დანიშნულება: სერტიფიკატის გაცემის საფასური, {name});',
    '- გააფორმოთ სასერტიფიკაციო ხელშეკრულება ინსტიტუტის ოფისში (მისამართი: ქ. თბილისი, მირიან მეფის ქუჩა №98, მე-2 სართული, საოფისე ფართი №6) ან კვალიფიციური ელექტრონული ხელმოწერით.',
    '',
    'საფასურის გადახდისა და სასერტიფიკაციო ხელშეკრულების ხელმოწერიდან არაუმეტეს 10 სამუშაო დღის ვადაში გაიცემა სერტიფიკატი და გააქტიურდება საიტზე gipc.org.ge-ზე არსებულ საჯარო რეესტრში.',
    '',
    'გთხოვთ გაითვალისწინოთ, რომ დადგენილი წესის შესაბამისად, გამოცდის დადებითი შედეგი სერტიფიკატის მისაღებად მოქმედებს წინამდებარე შეტყობინების მიღებიდან 30 კალენდარული დღის განმავლობაში, ხოლო აღნიშნული ვადის გასვლის შემთხვევაში საგამოცდო შედეგი ძალას კარგავს.',
    '',
    'გთხოვთ წინასწარ გაეცნოთ შესაბამის სასერტიფიკაციო ხელშეკრულებას, რომელიც განთავსებულია საიტზე gipc.org.ge.',
    '',
    'პატივისცემით,',
    'საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი',
  ].join('\n');

  const DEFAULT_EXAM_FAIL_SUBJECT = 'სერტიფიცირების გამოცდის შედეგი';
  const DEFAULT_EXAM_FAIL_BODY = [
    'ადრესატი: {name}',
    '',
    'მოგესალმებით,',
    '',
    'გაცნობებთ, რომ სერტიფიცირების გამოცდაზე ვერ დააკმაყოფილეთ სერტიფიცირების სქემით დადგენილი გამსვლელი ბარიერი.',
    '',
    'განმეორებით გამოცდაზე გასვლისა და შედეგის გასაჩივრების (აპელაციის) წესი განთავსებულია საიტზე gipc.org.ge.',
    '',
    'პატივისცემით,',
    'საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი',
  ].join('\n');

  const MODE_META = {
    exam: {
      mode: 'exam',
      backendKind: 'exam',
      templateKind: 'exam',
      hasTemplate: true,
      hasTimeAndPeriod: true,
      createTitle: 'გამოცდის დაგეგმვა',
      editTitle: 'დაგეგმილი გამოცდის რედაქტირება',
      dateLabel: 'გამოცდის თარიღი',
      letterBoxTitle: 'გამოცდის მოწვევის წერილი',
      historyTypeLabel: 'გამოცდა',
      defaultSubject: DEFAULT_EXAM_SUBJECT,
      defaultBody: DEFAULT_EXAM_BODY,
      modalClass: 'is-exam-modal',
      rowClass: 'is-exam-row',
      saveAndSendDesc: 'შეინახავს გამოცდის დაგეგმვას სისტემაში და გაუგზავნის წერილს კანდიდატს ოფიციალური მეილიდან.',
      saveOnlyDesc: 'შეინახავს მხოლოდ გამოცდის დაგეგმვას სისტემაში, მეილზე წერილის გაგზავნის გარეშე.',
      sendOnlyDesc: 'გაუგზავნის მხოლოდ წერილს კანდიდატს მეილზე, დაგეგმვის ცხრილში ცვლილების გარეშე.',
      toastSaved: 'გამოცდის დაგეგმვა შეინახა',
      toastSavedAndSent: 'გამოცდა დაიგეგმა და წერილი გაიგზავნა',
    },
    rejection: {
      mode: 'rejection',
      backendKind: 'exam',
      templateKind: 'rejection',
      hasTemplate: true,
      hasTimeAndPeriod: false,
      createTitle: 'უარყოფითი პასუხი (განაცხადზე)',
      editTitle: 'უარყოფითი პასუხის რედაქტირება',
      dateLabel: 'განხილვის თარიღი',
      letterBoxTitle: 'უარყოფითი პასუხის წერილი',
      historyTypeLabel: 'უარყოფითი პასუხი',
      defaultSubject: DEFAULT_REJECTION_SUBJECT,
      defaultBody: DEFAULT_REJECTION_BODY,
      modalClass: 'is-rejection-modal',
      rowClass: 'is-rejection-row',
      saveAndSendDesc: 'შეინახავს უარყოფით პასუხს სისტემაში და გაუგზავნის წერილს კანდიდატს ოფიციალური მეილიდან.',
      saveOnlyDesc: 'შეინახავს მხოლოდ უარყოფით პასუხს სისტემაში, მეილზე წერილის გაგზავნის გარეშე.',
      sendOnlyDesc: 'გაუგზავნის მხოლოდ უარყოფით პასუხს კანდიდატს მეილზე.',
      toastSaved: 'უარყოფითი პასუხი შეინახა',
      toastSavedAndSent: 'უარყოფითი პასუხი შეინახა და გაიგზავნა',
    },
    certificate: {
      mode: 'certificate',
      backendKind: 'certificate',
      templateKind: 'certificate',
      hasTemplate: true,
      hasTimeAndPeriod: false,
      createTitle: 'სერტიფიკატის მინიჭების შეტყობინება (ჩაბარება)',
      editTitle: 'სერტიფიკატის მინიჭების შეტყობინების რედაქტირება',
      dateLabel: 'შეტყობინების თარიღი',
      letterBoxTitle: 'ჩაბარებისა და სერტიფიკატის მინიჭების წერილი',
      historyTypeLabel: 'სერტიფიკატის გადაცემა',
      defaultSubject: DEFAULT_CERTIFICATE_SUBJECT,
      defaultBody: DEFAULT_CERTIFICATE_BODY,
      modalClass: 'is-certificate-modal',
      rowClass: 'is-certificate-row',
      saveAndSendDesc: 'შეინახავს ჩაბარების შეტყობინებას სისტემაში, გაუგზავნის წერილს მეილზე და გაუაქტიურებს კანდიდატს სერტიფიკატის აღების დაჯავშნის 30-დღიან ღილაკს.',
      saveOnlyDesc: 'შეინახავს ჩაბარების შეტყობინებას სისტემაში და გაუაქტიურებს დაჯავშნის ღილაკს, მეილზე წერილის გაგზავნის გარეშე.',
      sendOnlyDesc: 'გაუგზავნის ჩაბარებისა და სერტიფიკატის მინიჭების წერილს კანდიდატს მეილზე და გაუაქტიურებს დაჯავშნის ღილაკს.',
      toastSaved: 'სერტიფიკატის მინიჭების შეტყობინება შეინახა',
      toastSavedAndSent: 'სერტიფიკატის მინიჭების წერილი შეინახა და გაიგზავნა',
    },
    exam_fail: {
      mode: 'exam_fail',
      backendKind: 'certificate',
      templateKind: 'exam_fail',
      hasTemplate: true,
      hasTimeAndPeriod: false,
      createTitle: 'ჩაჭრის შეტყობინება (განმეორებითი გამოცდა)',
      editTitle: 'ჩაჭრის შეტყობინების რედაქტირება',
      dateLabel: 'შეფასების თარიღი',
      letterBoxTitle: 'ჩაჭრისა და განმეორებითი გამოცდის წერილი',
      historyTypeLabel: 'ჩაჭრის შეტყობინება',
      defaultSubject: DEFAULT_EXAM_FAIL_SUBJECT,
      defaultBody: DEFAULT_EXAM_FAIL_BODY,
      modalClass: 'is-fail-modal',
      rowClass: 'is-fail-row',
      saveAndSendDesc: 'შეინახავს ჩაჭრის შეტყობინებას სისტემაში და გაუგზავნის წერილს კანდიდატს ოფიციალური მეილიდან.',
      saveOnlyDesc: 'შეინახავს მხოლოდ ჩაჭრის შეტყობინებას სისტემაში, მეილზე წერილის გაგზავნის გარეშე.',
      sendOnlyDesc: 'გაუგზავნის მხოლოდ ჩაჭრის შეტყობინებას კანდიდატს მეილზე.',
      toastSaved: 'ჩაჭრის შეტყობინება შეინახა',
      toastSavedAndSent: 'ჩაჭრის შეტყობინება შეინახა და გაიგზავნა',
    },
    custom: {
      mode: 'custom',
      backendKind: 'exam',
      templateKind: null,
      hasTemplate: false,
      hasTimeAndPeriod: false,
      createTitle: 'სხვა შეტყობინება',
      editTitle: 'შეტყობინების რედაქტირება',
      dateLabel: 'შეტყობინების თარიღი',
      letterBoxTitle: 'შეტყობინების ტექსტი (შაბლონის გარეშე)',
      historyTypeLabel: 'სხვა შეტყობინება',
      defaultSubject: 'შეტყობინება — საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი (GIPC)',
      defaultBody: '',
      modalClass: 'is-custom-modal',
      rowClass: 'is-custom-row',
      saveAndSendDesc: 'შეინახავს შეტყობინებას ისტორიაში და გაუგზავნის წერილს კანდიდატს ოფიციალური მეილიდან.',
      saveOnlyDesc: 'შეინახავს მხოლოდ შეტყობინებას ისტორიაში, მეილზე წერილის გაგზავნის გარეშე.',
      sendOnlyDesc: 'გაუგზავნის მხოლოდ შეტყობინებას კანდიდატს მეილზე.',
      toastSaved: 'შეტყობინება შეინახა',
      toastSavedAndSent: 'შეტყობინება შეინახა და გაიგზავნა',
    },
  };

  const HISTORY_FILTER_TYPES = [
    { key: 'statement', label: 'შემოსული განცხადება', pillClass: 'type-statement' },
    { key: 'exam', label: 'გამოცდა', pillClass: 'type-exam' },
    { key: 'rejection', label: 'უარყოფითი პასუხი', pillClass: 'type-rejection' },
    { key: 'certificate', label: 'სერტიფიკატის გადაცემა', pillClass: 'type-certificate' },
    { key: 'cert_issued', label: 'სერტიფიკატის გააქტიურება', pillClass: 'type-cert_issued' },
    { key: 'exam_fail', label: 'ჩაჭრის შეტყობინება', pillClass: 'type-exam_fail' },
    { key: 'custom', label: 'სხვა შეტყობინება', pillClass: 'type-custom' },
  ];

  function todayIsoDate() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatDisplayDate(isoDate) {
    const raw = String(isoDate || '').trim();
    const parts = raw.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return raw;
  }

  function formatTimestampDisplay(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${day}-${month}-${year} ${hours}:${mins}`;
  }

  function parseTimestampMs(isoStr) {
    if (!isoStr) return 0;
    const d = new Date(String(isoStr).trim());
    const ms = d.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  function compareHistoryItemsChronologically(a, b) {
    const msDiff = parseTimestampMs(b.sentAt) - parseTimestampMs(a.sentAt);
    if (msDiff !== 0) return msDiff;
    const sentStrDiff = String(b.sentAt || '').localeCompare(String(a.sentAt || ''));
    if (sentStrDiff !== 0) return sentStrDiff;
    const dateDiff = String(b.examDate || '').localeCompare(String(a.examDate || ''));
    if (dateDiff !== 0) return dateDiff;
    const timeDiff = String(b.eventTime || '').localeCompare(String(a.eventTime || ''));
    if (timeDiff !== 0) return timeDiff;
    return Number(b.statementId || b.letterId || b.scheduleId || 0)
      - Number(a.statementId || a.letterId || a.scheduleId || 0);
  }

  function extractIsoDateFromTimestamp(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 10);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function periodLabelText(period) {
    if (period === 'morning' || period === 'cert_am_send') return 'დილით';
    if (period === 'evening' || period === 'cert_pm_send') return 'საღამოს';
    if (period === 'certificate' || period === 'cert_send_only') return 'სერტიფიკატის მინიჭება';
    if (period === 'cert_issued') return 'საჯარო რეესტრში ასახვა';
    if (period === 'rejection' || period === 'rej_send_only' || period === 'rejection_send_only') return 'უარყოფითი პასუხი';
    if (period === 'exam_fail' || period === 'fail_send_only') return 'ჩაჭრის შეტყობინება';
    if (period === 'custom' || period === 'cust_send_only') return 'სხვა შეტყობინება';
    return '';
  }

  function isRejectionPeriod(period) {
    return period === 'rejection' || period === 'rej_send_only' || period === 'rejection_send_only';
  }

  function isExamFailPeriod(period) {
    return period === 'exam_fail' || period === 'fail_send_only';
  }

  function isCustomPeriod(period) {
    return period === 'custom' || period === 'cust_send_only';
  }

  function generateUuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function isValidTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
  }

  function createExamSchedulesModule(context = {}) {
    const {
      API_BASE,
      getAdminHeaders = () => ({}),
      getActorHeaders = () => ({}),
      showToast = () => {},
      handleAdminErrorResponse = async () => {},
      downloadStatementPdf = null,
      escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    } = context;

    const mountedPanels = new WeakMap();
    const sharedTemplates = {
      exam: {
        kind: 'exam',
        subject: DEFAULT_EXAM_SUBJECT,
        body: DEFAULT_EXAM_BODY,
        attachment_filename: null,
        attachment_size_bytes: null,
      },
      rejection: {
        kind: 'rejection',
        subject: DEFAULT_REJECTION_SUBJECT,
        body: DEFAULT_REJECTION_BODY,
        attachment_filename: null,
        attachment_size_bytes: null,
      },
      certificate: {
        kind: 'certificate',
        subject: DEFAULT_CERTIFICATE_SUBJECT,
        body: DEFAULT_CERTIFICATE_BODY,
        attachment_filename: null,
        attachment_size_bytes: null,
      },
      exam_fail: {
        kind: 'exam_fail',
        subject: DEFAULT_EXAM_FAIL_SUBJECT,
        body: DEFAULT_EXAM_FAIL_BODY,
        attachment_filename: null,
        attachment_size_bytes: null,
      },
    };
    let sharedTemplatesLoaded = false;

    const SCHEDULE_TIMES_STORAGE_KEY = 'gipc_schedule_times_v1';
    const sharedScheduleTimes = {
      morning: '10:00',
      evening: '14:00',
    };
    try {
      const rawStoredTimes = global.localStorage?.getItem?.(SCHEDULE_TIMES_STORAGE_KEY);
      if (rawStoredTimes) {
        const parsedTimes = JSON.parse(rawStoredTimes);
        if (isValidTime(parsedTimes?.morning)) sharedScheduleTimes.morning = parsedTimes.morning.trim();
        if (isValidTime(parsedTimes?.evening)) sharedScheduleTimes.evening = parsedTimes.evening.trim();
      }
    } catch {}

    function getDefaultScheduleTime(period) {
      if (period === 'evening' || period === 'cert_pm_send') {
        return isValidTime(sharedScheduleTimes.evening) ? sharedScheduleTimes.evening : '14:00';
      }
      return isValidTime(sharedScheduleTimes.morning) ? sharedScheduleTimes.morning : '10:00';
    }

    function applyLoadedScheduleTimes(serverTimes) {
      if (!serverTimes || typeof serverTimes !== 'object') return;
      let changed = false;
      if (isValidTime(serverTimes.morning)) {
        sharedScheduleTimes.morning = String(serverTimes.morning).trim();
        changed = true;
      }
      if (isValidTime(serverTimes.evening)) {
        sharedScheduleTimes.evening = String(serverTimes.evening).trim();
        changed = true;
      }
      if (changed) {
        try {
          global.localStorage?.setItem?.(SCHEDULE_TIMES_STORAGE_KEY, JSON.stringify(sharedScheduleTimes));
        } catch {}
      }
    }

    async function saveDefaultScheduleTimes(updates = {}) {
      if (isValidTime(updates.morning)) {
        sharedScheduleTimes.morning = updates.morning.trim();
      }
      if (isValidTime(updates.evening)) {
        sharedScheduleTimes.evening = updates.evening.trim();
      }
      try {
        global.localStorage?.setItem?.(SCHEDULE_TIMES_STORAGE_KEY, JSON.stringify(sharedScheduleTimes));
      } catch {}
      if (!API_BASE) return true;
      try {
        const formData = new FormData();
        formData.append('morning', sharedScheduleTimes.morning);
        formData.append('evening', sharedScheduleTimes.evening);
        const response = await fetch(`${API_BASE}/admin/planning-schedule-times`, {
          method: 'PUT',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });
        if (!response.ok) return false;
        const data = await response.json().catch(() => null);
        if (data?.schedule_times) {
          applyLoadedScheduleTimes(data.schedule_times);
        }
        return true;
      } catch {
        return false;
      }
    }

    function parseStatementCategory(message) {
      const text = String(message || '').trim();
      if (!text) return null;
      if (text.includes('2) კატეგორია C ან A') || text.includes('კატეგორია C ან A')) return 'C_A';
      if (text.includes('3) კატეგორია B ან A') || text.includes('კატეგორია B ან A')) return 'B_A';
      if (text.includes('1) კატეგორია A') || text.includes('კატეგორია A —')) return 'A';
      if (text.includes('4) კატეგორია B') || text.includes('კატეგორია B —')) return 'B';
      if (text.includes('5) კატეგორია C') || text.includes('კატეგორია C —')) return 'C';
      return null;
    }

    function inferExamCandidateCategory(user, statementItems = [], replyToStatement = null) {
      const valid = new Set(['A', 'B', 'C', 'B_A', 'C_A']);
      if (replyToStatement) {
        const fromReplyStmt = parseStatementCategory(
          replyToStatement.body || replyToStatement.statementRaw?.message || ''
        );
        if (fromReplyStmt && valid.has(fromReplyStmt)) return fromReplyStmt;
      }
      const candCat = String(user?.candidate_category || '').trim().toUpperCase();
      if (valid.has(candCat)) return candCat;
      const reqCat = String(user?.requested_category || '').trim().toUpperCase();
      if (valid.has(reqCat)) return reqCat;
      for (const stmt of statementItems) {
        const parsed = parseStatementCategory(stmt?.message);
        if (parsed && valid.has(parsed)) return parsed;
      }
      return 'A';
    }

    function inferCertificateCandidateCategory(user, examOutcome, statementItems = [], replyToStatement = null) {
      const base = inferExamCandidateCategory(user, statementItems, replyToStatement);
      if (base === 'A' || base === 'B' || base === 'C') return base;
      const outcome = examOutcome?.outcome || user?.exam_outcome?.outcome || '';
      if (base === 'B_A') {
        return outcome === 'pass_a' ? 'A' : 'B';
      }
      if (base === 'C_A') {
        return outcome === 'pass_a' ? 'A' : 'C';
      }
      return outcome === 'pass_bc' ? 'B' : 'A';
    }

    function categoryLabelForLetter(certCategory, fallbackOutcomeLabel = '') {
      const cat = String(certCategory || '').trim().toUpperCase();
      if (cat === 'A') return 'A კატეგორიის';
      if (cat === 'B') return 'B კატეგორიის';
      if (cat === 'C') return 'C კატეგორიის';
      return String(fallbackOutcomeLabel || 'შესაბამისი კატეგორიის').trim();
    }

    function candidateTokens(user, examDate, examTime, period, selectedCertCategory = '') {
      const fullName = `${user?.first_name || ''} ${user?.last_name || ''}`.trim() || '(უსახელო)';
      const personalId = String(user?.personal_id || '—').trim();
      const code = String(user?.code || '—').trim();
      const dateStr = isValidDate(examDate) ? formatDisplayDate(examDate) : '[თარიღი]';
      const timeStr = isValidTime(examTime) ? String(examTime).trim() : '[საათი]';
      const periodStr = periodLabelText(period) || '[დილით/საღამოს]';
      const categoryStr = categoryLabelForLetter(selectedCertCategory, user?.exam_outcome?.category_label);
      const examResultsStr = String(user?.exam_outcome?.results_text || '').trim();
      return {
        name: fullName,
        personal_id: personalId,
        code,
        date: dateStr,
        time: timeStr,
        period: periodStr,
        category: categoryStr,
        exam_results: examResultsStr,
      };
    }

    function applyTemplateTokens(text, tokens) {
      let result = String(text || '');
      const replacements = [
        [/\{name\}|\[სახელი და გვარი\]|\[სახელი,\s*გვარი\]/gi, tokens.name],
        [/სახელი და გვარი(?=\))/gi, tokens.name],
        [/\[IBAN ანგარიში\]|\[IBAN\]/gi, 'GE33TB7313736080100014'],
        [/\[მისამართი\]/gi, 'ქ. თბილისი, მირიან მეფის ქუჩა №98, მე-2 სართული, საოფისე ფართი №6'],
        [/\{personal_id\}|\[პირადი ნომერი\]/gi, tokens.personal_id],
        [/\{code\}|\[უნიკალური კოდი\]/gi, tokens.code],
        [/\{date\}|\[გამოცდის თარიღი\]|\[თარიღი\]/gi, tokens.date],
        [/\{time\}|\[საათი\]/gi, tokens.time],
        [/\{period\}|\[ცვლა\]|\[დილით\/საღამოს\]/gi, tokens.period],
        [/\[კატეგორია\]\s*კატეგორიის/gi, tokens.category || 'შესაბამისი კატეგორიის'],
        [/\{category\}|\[კატეგორია\]/gi, tokens.category || 'შესაბამისი კატეგორიის'],
        [/\{exam_results\}|\[გამოცდის შედეგები\]/gi, tokens.exam_results || ''],
      ];
      for (const [pattern, val] of replacements) {
        result = result.replace(pattern, () => val);
      }
      return result;
    }

    function injectExamResultsIntoBody(bodyText, examOutcome, mode) {
      let text = String(bodyText || '');
      const resultsBlock = String(examOutcome?.results_text || '').trim();
      if (!resultsBlock) return text;
      if (mode !== 'certificate' && mode !== 'exam_fail') return text;
      if (text.includes(resultsBlock) || text.includes('თქვენი გამოცდის შედეგები:')) {
        return text;
      }
      const certAnchor = 'სერტიფიკატის მისაღებად აუცილებელია';
      const failAnchor = 'განმეორებით გამოცდაზე გასვლისა';
      const signoffAnchor = 'პატივისცემით,';
      if (mode === 'certificate' && text.includes(certAnchor)) {
        return text.replace(certAnchor, `${resultsBlock}\n\n${certAnchor}`);
      }
      if (mode === 'exam_fail' && text.includes(failAnchor)) {
        return text.replace(failAnchor, `${resultsBlock}\n\n${failAnchor}`);
      }
      if (text.includes(signoffAnchor)) {
        return text.replace(signoffAnchor, `${resultsBlock}\n\n${signoffAnchor}`);
      }
      return `${text.trimEnd()}\n\n${resultsBlock}`;
    }

    function convertRenderedToTemplate(renderedText, tokens) {
      let result = String(renderedText || '');
      if (tokens.exam_results) {
        result = result.split(`\n\n${tokens.exam_results}`).join('');
        result = result.split(`${tokens.exam_results}\n\n`).join('');
        result = result.split(tokens.exam_results).join('');
      }
      const pairs = [
        [tokens.name, '{name}'],
        [tokens.personal_id, '{personal_id}'],
        [tokens.code, '{code}'],
        [tokens.date, '{date}'],
        [tokens.time, '{time}'],
        [tokens.period, '{period}'],
      ];
      for (const [literal, placeholder] of pairs) {
        if (literal && literal !== '—' && literal !== '(უსახელო)' && !literal.startsWith('[')) {
          result = result.split(literal).join(placeholder);
        }
      }
      result = result
        .replace(/[ABC] კატეგორიის|B\/C კატეგორიის|შესაბამისი კატეგორიის/g, '[კატეგორია]')
        .replace(/\[თარიღი\]|\[გამოცდის თარიღი\]/g, '{date}')
        .replace(/\[საათი\]/g, '{time}')
        .replace(/\[დილით\/საღამოს\]|\[ცვლა\]/g, '{period}');
      return result;
    }

    function isLegacyTemplateBody(body) {
      const raw = String(body || '').trim();
      return (
        !raw ||
        raw.startsWith('ბატონო/ქალბატონო') ||
        raw.startsWith('გამარჯობა,') ||
        /\[შეავსეთ/.test(raw) ||
        raw.includes('GIPC-PRO-') ||
        raw.includes('GIPC-CON-') ||
        raw.includes('GIPC-FRM-') ||
        raw.includes('შპს „საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი“') ||
        raw.includes('შპს "საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი"') ||
        raw.includes('წინამდებარე შეტყობინების მიღებიდან 1 თვის ვადაში')
      );
    }

    function normalizeGreeting(body, fallback) {
      const raw = String(body || '').trim();
      if (isLegacyTemplateBody(raw)) {
        return fallback;
      }
      return raw;
    }

    function mount(panel, user, { onChanged = () => {} } = {}) {
      if (!panel || user?.id == null) return { load: async () => {}, openHistoryModal: async () => {} };
      const mountToken = {};
      mountedPanels.set(panel, mountToken);
      const isCurrent = () => mountedPanels.get(panel) === mountToken;

      panel.innerHTML = `
        <div class="exam-schedule-card-bar">
          <button type="button" class="btn-schedule-exam">გამოცდის დაგეგმვა</button>
          <button type="button" class="btn-rejection-letter">უარყოფითი პასუხი</button>
          <button type="button" class="btn-certificate-handover">სერტიფიკატის გადაცემა</button>
          <button type="button" class="btn-exam-fail-letter">ჩაჭრის შეტყობინება</button>
          <button type="button" class="btn-custom-letter">სხვა შეტყობინება</button>
        </div>
      `;

      const openScheduleModalBtn = panel.querySelector('.btn-schedule-exam');
      const openRejectionModalBtn = panel.querySelector('.btn-rejection-letter');
      const openCertificateModalBtn = panel.querySelector('.btn-certificate-handover');
      const openExamFailModalBtn = panel.querySelector('.btn-exam-fail-letter');
      const openCustomModalBtn = panel.querySelector('.btn-custom-letter');
      const cardEl = panel.closest('.block-card');
      const openHistoryModalBtn = cardEl?.querySelector('.btn-user-announcements');
      const countBadge = openHistoryModalBtn?.querySelector('.btn-scheduled-exams-badge');

      const schedulesEndpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/exam-schedules`;
      const lettersEndpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/planning-letters`;
      const statementsEndpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/statements`;
      const examOutcomeEndpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/exam-outcome`;
      const templatesEndpoint = `${API_BASE}/admin/planning-templates`;

      let scheduleItems = [];
      let letterItems = [];
      let statementItems = [];
      let examOutcome = user.exam_outcome || null;
      let loadingData = false;
      const seenInFlight = new Set();

      function inferLetterMode(letter) {
        if (isRejectionPeriod(letter.period)) return 'rejection';
        if (isExamFailPeriod(letter.period)) return 'exam_fail';
        if (isCustomPeriod(letter.period)) return 'custom';
        if (letter.kind === 'certificate') return 'certificate';
        return 'exam';
      }

      function normalizeLetterPeriod(letter, mode) {
        if (mode === 'rejection') return 'rejection';
        if (mode === 'exam_fail') return 'exam_fail';
        if (mode === 'custom') return 'custom';
        if (letter.period === 'cert_issued') return 'cert_issued';
        if (mode === 'certificate') return 'certificate';
        if (letter.period === 'morning' || letter.period === 'cert_am_send') return 'morning';
        if (letter.period === 'evening' || letter.period === 'cert_pm_send') return 'evening';
        return (letter.event_time || '') < '12:00' ? 'morning' : 'evening';
      }

      function isSendOnlyLetter(letter, mode) {
        if (mode === 'rejection') {
          return letter.period === 'rej_send_only' || letter.period === 'rejection_send_only';
        }
        if (mode === 'exam_fail') {
          return letter.period === 'fail_send_only';
        }
        if (mode === 'custom') {
          return letter.period === 'cust_send_only';
        }
        if (mode === 'certificate') {
          return letter.period === 'cert_send_only' || letter.period === 'cert_am_send' || letter.period === 'cert_pm_send';
        }
        return letter.exam_schedule_id == null;
      }

      function buildCombinedHistory() {
        const lettersByScheduleId = new Map();
        const standaloneLetters = [];
        const sortedLetters = [...letterItems].sort((a, b) => Number(b.id) - Number(a.id));

        for (const letter of sortedLetters) {
          const mode = inferLetterMode(letter);
          if (mode === 'exam' && letter.exam_schedule_id != null) {
            const key = String(letter.exam_schedule_id);
            if (!lettersByScheduleId.has(key)) {
              lettersByScheduleId.set(key, letter);
            }
          } else {
            standaloneLetters.push(letter);
          }
        }

        const combined = [];
        const matchedLetterIds = new Set();

        for (const stmt of statementItems) {
          const createdAtRaw = stmt.created_at || null;
          const dateIso = extractIsoDateFromTimestamp(createdAtRaw);
          const unseen = stmt.seen_at == null;
          const pending = !unseen && stmt.answered_at == null;
          const msgText = String(stmt.message || '').trim();
          const previewLine = msgText.replace(/\s+/g, ' ');
          const docNumber = (stmt.doc_number || '').trim() || (
            stmt.id != null
              ? `IN-${new Date(createdAtRaw || Date.now()).getFullYear()}-${String(stmt.id).padStart(4, '0')}`
              : ''
          );
          combined.push({
            key: `stmt-${stmt.id}`,
            isIncomingStatement: true,
            statementId: stmt.id,
            statementRaw: stmt,
            docNumber,
            mode: 'statement',
            filterType: 'statement',
            typeLabel: '↙ შემოსული განცხადება',
            rowClass: `is-statement-row${unseen ? ' is-stmt-unseen-row' : pending ? ' is-stmt-pending-row' : ' is-stmt-answered-row'}`,
            scheduleId: null,
            letterId: null,
            examDate: dateIso,
            period: 'statement',
            eventTime: '',
            subject: previewLine.length > 72 ? `${previewLine.slice(0, 69)}…` : previewLine,
            body: msgText,
            status: unseen ? 'stmt_unseen' : pending ? 'stmt_pending' : 'stmt_answered',
            seenAt: stmt.seen_at,
            answeredAt: stmt.answered_at,
            error: null,
            attachmentFilename: stmt.attachment_filename || null,
            toEmail: user.email || '',
            sentAt: createdAtRaw,
            sentAtDisplay: formatTimestampDisplay(createdAtRaw),
            sentDateIso: dateIso,
            isStandaloneLetter: false,
          });
        }

        for (const sched of scheduleItems) {
          let letter = lettersByScheduleId.get(String(sched.id)) || null;
          if (!letter) {
            letter = sortedLetters.find(
              (l) => !matchedLetterIds.has(l.id)
                && inferLetterMode(l) === 'exam'
                && l.event_date === sched.exam_date
                && l.period === sched.period
            ) || null;
          }
          if (letter) matchedLetterIds.add(letter.id);
          const sentAtRaw = letter ? (letter.sent_at || letter.created_at || sched.created_at || null) : (sched.created_at || null);
          const docNumber = letter
            ? ((letter.doc_number || '').trim() || (
                letter.id != null
                  ? `OUT-${new Date(sentAtRaw || Date.now()).getFullYear()}-${String(letter.id).padStart(4, '0')}`
                  : ''
              ))
            : '';
          combined.push({
            key: `sched-${sched.id}`,
            docNumber,
            mode: 'exam',
            filterType: 'exam',
            typeLabel: MODE_META.exam.historyTypeLabel,
            rowClass: MODE_META.exam.rowClass,
            scheduleId: sched.id,
            letterId: letter ? letter.id : null,
            examDate: sched.exam_date,
            period: sched.period,
            eventTime: (letter && letter.event_time) ? letter.event_time : getDefaultScheduleTime(sched.period),
            subject: letter ? letter.subject : '',
            body: letter ? letter.body : '',
            status: letter ? letter.status : 'saved',
            error: letter ? letter.error : null,
            attachmentFilename: letter ? letter.attachment_filename : null,
            toEmail: (letter && letter.to_email) || user.email || '',
            sentAt: sentAtRaw,
            sentAtDisplay: formatTimestampDisplay(sentAtRaw),
            sentDateIso: extractIsoDateFromTimestamp(sentAtRaw),
            isStandaloneLetter: false,
          });
        }

        for (const letter of standaloneLetters) {
          if (matchedLetterIds.has(letter.id)) continue;
          const mode = inferLetterMode(letter);
          const meta = MODE_META[mode] || MODE_META.exam;
          const isCertIssued = letter.period === 'cert_issued';
          const filterType = isCertIssued ? 'cert_issued' : mode;
          const typeLabel = isCertIssued ? 'სერტიფიკატის გააქტიურება' : meta.historyTypeLabel;
          const rowClass = isCertIssued ? 'is-cert-issued-row' : meta.rowClass;
          const sentAtRaw = letter.sent_at || letter.created_at || null;
          const docNumber = (letter.doc_number || '').trim() || (
            letter.id != null
              ? `OUT-${new Date(sentAtRaw || Date.now()).getFullYear()}-${String(letter.id).padStart(4, '0')}`
              : ''
          );
          combined.push({
            key: `letter-${letter.id}`,
            docNumber,
            mode,
            filterType,
            typeLabel,
            rowClass,
            scheduleId: null,
            letterId: letter.id,
            examDate: letter.event_date,
            period: normalizeLetterPeriod(letter, mode),
            eventTime: (meta.hasTimeAndPeriod && !isCertIssued) ? (letter.event_time || '') : '',
            subject: letter.subject || '',
            body: letter.body || '',
            status: letter.status || 'sent',
            error: letter.error || null,
            attachmentFilename: letter.attachment_filename || null,
            toEmail: letter.to_email || user.email || '',
            sentAt: sentAtRaw,
            sentAtDisplay: formatTimestampDisplay(letter.sent_at || letter.created_at || null),
            sentDateIso: extractIsoDateFromTimestamp(sentAtRaw),
            isStandaloneLetter: isSendOnlyLetter(letter, mode),
          });
        }

        combined.sort(compareHistoryItemsChronologically);
        return combined;
      }

      function updateCardButtonBadge() {
        const combined = buildCombinedHistory();
        const count = combined.length;
        if (countBadge) {
          countBadge.textContent = String(count);
          countBadge.hidden = count === 0;
        }
        openRejectionModalBtn?.classList.toggle(
          'has-rejection-record',
          combined.some((item) => item.mode === 'rejection')
        );
        openCertificateModalBtn?.classList.toggle(
          'has-certificate-record',
          combined.some((item) => item.mode === 'certificate')
        );
        openExamFailModalBtn?.classList.toggle(
          'has-fail-record',
          combined.some((item) => item.mode === 'exam_fail')
        );
        openCustomModalBtn?.classList.toggle(
          'has-custom-record',
          combined.some((item) => item.mode === 'custom')
        );

        const isPendingPass = Boolean(
          examOutcome?.unacknowledged &&
            (examOutcome.outcome === 'pass_bc' || examOutcome.outcome === 'pass_a')
        );
        const isPendingFail = Boolean(
          examOutcome?.unacknowledged && examOutcome.outcome === 'fail'
        );
        openCertificateModalBtn?.classList.toggle('has-pending-exam-pass', isPendingPass);
        openExamFailModalBtn?.classList.toggle('has-pending-exam-fail', isPendingFail);

        const outcomeBadgeEl = cardEl?.querySelector('.user-exam-outcome-badge');
        if (outcomeBadgeEl) {
          outcomeBadgeEl.classList.remove('is-pass-bc', 'is-pass-a', 'is-fail');
          if (examOutcome?.unacknowledged && examOutcome.outcome === 'pass_bc') {
            outcomeBadgeEl.textContent = '✓ ჩააბარა (B/C)';
            outcomeBadgeEl.classList.add('is-pass-bc');
            outcomeBadgeEl.hidden = false;
          } else if (examOutcome?.unacknowledged && examOutcome.outcome === 'pass_a') {
            outcomeBadgeEl.textContent = '✓ ჩააბარა (A)';
            outcomeBadgeEl.classList.add('is-pass-a');
            outcomeBadgeEl.hidden = false;
          } else if (examOutcome?.unacknowledged && examOutcome.outcome === 'fail') {
            outcomeBadgeEl.textContent = '✕ ჩაიჭრა';
            outcomeBadgeEl.classList.add('is-fail');
            outcomeBadgeEl.hidden = false;
          } else {
            outcomeBadgeEl.textContent = '';
            outcomeBadgeEl.hidden = true;
          }
        }
      }

      function notifyStatementState(serverState = null) {
        const unseen = serverState?.unseen_statement_count ?? statementItems.filter((item) => item.seen_at == null).length;
        const pending = serverState?.pending_statement_count ?? statementItems.filter((item) => item.seen_at != null && item.answered_at == null).length;
        try {
          global.dispatchEvent(new CustomEvent('admin:statementsSeen', {
            detail: {
              userId: user.id,
              remainingCount: unseen,
              hasUnseen: unseen > 0,
              pendingCount: pending,
              hasPending: pending > 0,
              refreshSummary: true,
            },
          }));
        } catch {}
      }

      async function notifyChanged() {
        try { await onChanged({ userId: user.id }); } catch {}
      }

      async function load() {
        if (loadingData || !isCurrent()) return;
        loadingData = true;
        try {
          const requests = [
            fetch(schedulesEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }),
            fetch(lettersEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null),
            fetch(statementsEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null),
            fetch(examOutcomeEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null),
          ];
          if (!sharedTemplatesLoaded) {
            requests.push(
              fetch(templatesEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null)
            );
          }
          const [schedRes, lettersRes, stmtRes, outcomeRes, tmplRes] = await Promise.all(requests);
          if (!isCurrent()) return;

          if (tmplRes && tmplRes.ok) {
            const tmplData = await tmplRes.json().catch(() => null);
            const items = Array.isArray(tmplData?.items) ? tmplData.items : [];
            const examTmpl = items.find((t) => t.kind === 'exam');
            if (examTmpl) {
              const legacy = isLegacyTemplateBody(examTmpl.body);
              sharedTemplates.exam = {
                ...examTmpl,
                subject: legacy ? DEFAULT_EXAM_SUBJECT : (examTmpl.subject || DEFAULT_EXAM_SUBJECT),
                body: normalizeGreeting(examTmpl.body, DEFAULT_EXAM_BODY),
              };
            }
            const certTmpl = items.find((t) => t.kind === 'certificate');
            if (certTmpl) {
              const legacy = isLegacyTemplateBody(certTmpl.body);
              sharedTemplates.certificate = {
                ...certTmpl,
                subject: legacy ? DEFAULT_CERTIFICATE_SUBJECT : (certTmpl.subject || DEFAULT_CERTIFICATE_SUBJECT),
                body: normalizeGreeting(certTmpl.body, DEFAULT_CERTIFICATE_BODY),
              };
            }
            if (tmplData?.rejection_template) {
              const rejTmpl = tmplData.rejection_template;
              const legacy = isLegacyTemplateBody(rejTmpl.body);
              sharedTemplates.rejection = {
                ...rejTmpl,
                subject: legacy ? DEFAULT_REJECTION_SUBJECT : (rejTmpl.subject || DEFAULT_REJECTION_SUBJECT),
                body: normalizeGreeting(rejTmpl.body, DEFAULT_REJECTION_BODY),
              };
            }
            if (tmplData?.exam_fail_template) {
              const failTmpl = tmplData.exam_fail_template;
              const legacy = isLegacyTemplateBody(failTmpl.body);
              sharedTemplates.exam_fail = {
                ...failTmpl,
                subject: legacy ? DEFAULT_EXAM_FAIL_SUBJECT : (failTmpl.subject || DEFAULT_EXAM_FAIL_SUBJECT),
                body: normalizeGreeting(failTmpl.body, DEFAULT_EXAM_FAIL_BODY),
              };
            }
            if (tmplData?.schedule_times) {
              applyLoadedScheduleTimes(tmplData.schedule_times);
            }
            sharedTemplatesLoaded = true;
          }

          if (schedRes && schedRes.ok) {
            const schedData = await schedRes.json().catch(() => null);
            scheduleItems = Array.isArray(schedData?.items) ? schedData.items : [];
          }
          if (lettersRes && lettersRes.ok) {
            const lettersData = await lettersRes.json().catch(() => null);
            letterItems = Array.isArray(lettersData?.items) ? lettersData.items : [];
          }
          if (stmtRes && stmtRes.ok) {
            const stmtData = await stmtRes.json().catch(() => null);
            statementItems = Array.isArray(stmtData?.items) ? stmtData.items : [];
            notifyStatementState();
          }
          if (outcomeRes && outcomeRes.ok) {
            const outcomeData = await outcomeRes.json().catch(() => null);
            if (outcomeData) {
              examOutcome = outcomeData;
              user.exam_outcome = outcomeData;
              if ('candidate_status' in outcomeData) {
                user.candidate_status = outcomeData.candidate_status ?? null;
              }
              if ('candidate_category' in outcomeData) {
                user.candidate_category = outcomeData.candidate_category ?? null;
              }
              if ('requested_category' in outcomeData) {
                user.requested_category = outcomeData.requested_category ?? null;
              }
            }
          }
          updateCardButtonBadge();
        } catch {
          // Ignore silent background load errors; modals can retry
        } finally {
          loadingData = false;
        }
      }

      async function downloadLetterAttachment(letterId, filename) {
        try {
          const response = await fetch(`${lettersEndpoint}/${encodeURIComponent(letterId)}/attachment`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!response.ok) {
            await handleAdminErrorResponse(response, 'მიმაგრებული ფაილი ვერ ჩამოიტვირთა.', showToast);
            return;
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename || 'attachment';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
          showToast('მიმაგრებული ფაილი ვერ ჩამოიტვირთა.', 'error');
        }
      }

      async function downloadStatementAttachment(statementId, filename) {
        try {
          const response = await fetch(`${API_BASE}/admin/statements/${encodeURIComponent(statementId)}/file`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!response.ok) {
            showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error');
            return;
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename || 'file';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
          showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error');
        }
      }

      function statusBadgeMeta(item) {
        if (item.isIncomingStatement) {
          if (item.seenAt == null) return { label: 'ახალი', cls: 'is-stmt-unseen' };
          if (item.answeredAt == null) return { label: 'უპასუხო', cls: 'is-stmt-pending' };
          return { label: 'პასუხი გაცემულია', cls: 'is-stmt-answered' };
        }
        if (item.isStandaloneLetter) {
          if (item.status === 'failed') return { label: 'მხოლოდ გაგზავნა (შეცდომა)', cls: 'is-error' };
          return { label: 'მხოლოდ გაგზავნილი', cls: 'is-sent-only' };
        }
        if (!item.letterId || item.status === 'saved') {
          return { label: 'მხოლოდ შენახული', cls: 'is-saved-only' };
        }
        if (item.status === 'failed') {
          return { label: 'შენახულია (მეილი ვერ გაიგზავნა)', cls: 'is-error' };
        }
        if (item.status === 'uncertain') {
          return { label: 'შენახულია (გაგზავნა გადასამოწმებელია)', cls: 'is-warning' };
        }
        return { label: 'შენახული და გაგზავნილი', cls: 'is-sent' };
      }

      function closeAnyExamModal() {
        document.querySelectorAll('.exam-schedule-modal-overlay').forEach((el) => el.remove());
        panel.dataset.dirty = 'false';
      }

      const REPLY_TEMPLATE_OPTIONS = [
        {
          mode: 'exam',
          pill: '📅 დადებითი პასუხი',
          pillClass: 'is-exam-pill',
          title: 'გამოცდის დაგეგმვა (გამოცდაზე დაშვება)',
          desc: 'განაცხადის დაკმაყოფილება, გამოცდაზე დაშვების წერილი და თარიღის/დროის ჩანიშვნა',
        },
        {
          mode: 'rejection',
          pill: '✕ უარყოფითი პასუხი',
          pillClass: 'is-rejection-pill',
          title: 'განაცხადზე უარი (უარყოფითი პასუხი)',
          desc: 'განაცხადის დაუკმაყოფილებლობის სტანდარტული შაბლონით პასუხის გაგზავნა',
        },
        {
          mode: 'certificate',
          pill: '🎓 სერტიფიკატის მინიჭება',
          pillClass: 'is-certificate-pill',
          title: 'სერტიფიკატის გადაცემა (ჩაბარება)',
          desc: 'გამოცდის წარმატებით ჩაბარებისა და სერტიფიკატის მინიჭების შეტყობინება',
        },
        {
          mode: 'exam_fail',
          pill: '⚠ გამოცდაზე ჩაჭრა',
          pillClass: 'is-fail-pill',
          title: 'ჩაჭრის შეტყობინება (განმეორებითი გამოცდა)',
          desc: 'გამოცდაზე გამსვლელი ბარიერის ვერდაძლევის სტანდარტული შეტყობინება',
        },
        {
          mode: 'custom',
          pill: '✉ თავისუფალი ტექსტი',
          pillClass: 'is-custom-pill',
          title: 'სხვა შეტყობინება (ინდივიდუალური წერილი)',
          desc: 'ნებისმიერი შინაარსის წერილის შედგენა და გაგზავნა შაბლონის გარეშე',
        },
      ];

      // =========================================================================
      // MODAL 0: Statement Reply Template Chooser
      // =========================================================================
      async function openReplyTemplateChooserModal(statementItem, { returnToHistory = true } = {}) {
        await load();
        closeAnyExamModal();

        const candidateName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '(უსახელო)';
        const safeEmail = escapeHtml(user.email || '—');
        const docNum = statementItem?.docNumber || (statementItem?.statementId ? `#${statementItem.statementId}` : '');
        const parsedStmtCat = parseStatementCategory(
          statementItem?.body || statementItem?.statementRaw?.message || ''
        );

        const optionsHtml = REPLY_TEMPLATE_OPTIONS.map((opt) => `
          <button type="button" class="stmt-reply-template-card mode-${opt.mode}" data-reply-mode="${opt.mode}">
            <div class="stmt-reply-template-card-top">
              <span class="stmt-reply-template-pill ${opt.pillClass}">${escapeHtml(opt.pill)}</span>
              <span class="stmt-reply-template-arrow">გადასვლა →</span>
            </div>
            <div class="stmt-reply-template-title">${escapeHtml(opt.title)}</div>
            <div class="stmt-reply-template-desc">${escapeHtml(opt.desc)}</div>
          </button>
        `).join('');

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay exam-schedule-modal-overlay open';
        overlay.setAttribute('aria-hidden', 'false');
        overlay.innerHTML = `
          <div class="modal stmt-reply-chooser-modal" role="dialog" aria-modal="true" aria-labelledby="stmtReplyChooserTitle">
            <div class="modal-header">
              <h3 class="modal-title" id="stmtReplyChooserTitle">პასუხის გაცემა განცხადებაზე${docNum ? ` — № ${escapeHtml(docNum)}` : ''}</h3>
              <button class="modal-close stmt-reply-chooser-close" type="button" aria-label="დახურვა">×</button>
            </div>
            <div class="modal-body stmt-reply-chooser-body">
              <div class="exam-schedule-candidate-bar">
                <span><strong>კანდიდატი:</strong> ${escapeHtml(candidateName)}</span>
                <span><strong>კოდი:</strong> ${escapeHtml(user.code || '—')}</span>
                <span><strong>მეილი:</strong> ${safeEmail}</span>
                ${docNum ? `<span><strong>განცხადება:</strong> № ${escapeHtml(docNum)}</span>` : ''}
                ${parsedStmtCat ? `<span><strong>მოთხოვნილი კატეგორია:</strong> ${escapeHtml(parsedStmtCat.replace('_', '/'))}</span>` : ''}
              </div>
              <p class="stmt-reply-chooser-hint">
                აირჩიეთ სტანდარტული შაბლონი, რომლითაც გსურთ პასუხის გაცემა (გაგზავნის ან შენახვის შემდეგ <strong>„პასუხი გაცემულია“</strong> ავტომატურად მოინიშნება):
              </p>
              <div class="stmt-reply-template-grid">
                ${optionsHtml}
              </div>
            </div>
            <div class="modal-footer stmt-reply-chooser-footer">
              <button type="button" class="btn-secondary stmt-reply-chooser-back">უკან დაბრუნება</button>
            </div>
          </div>
        `;

        document.body.appendChild(overlay);

        overlay.querySelectorAll('[data-reply-mode]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const chosenMode = btn.getAttribute('data-reply-mode') || 'exam';
            void openScheduleFormModal(null, {
              mode: chosenMode,
              returnToHistory,
              replyToStatement: statementItem,
            });
          });
        });

        const handleCloseChooser = () => {
          closeAnyExamModal();
          if (returnToHistory) {
            void openScheduledExamsListModal();
          }
        };

        overlay.querySelector('.stmt-reply-chooser-close')?.addEventListener('click', handleCloseChooser);
        overlay.querySelector('.stmt-reply-chooser-back')?.addEventListener('click', handleCloseChooser);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) handleCloseChooser();
        });
      }

      // =========================================================================
      // MODAL 1: Form & Letter Editor for all 5 Modes
      // ('exam' | 'rejection' | 'certificate' | 'exam_fail' | 'custom')
      // =========================================================================
      async function openScheduleFormModal(
        editingItem = null,
        { mode = 'exam', returnToHistory = false, replyToStatement = null } = {}
      ) {
        const resolvedMode = editingItem?.mode || mode || 'exam';
        const meta = MODE_META[resolvedMode] || MODE_META.exam;
        const hasTimeAndPeriod = meta.hasTimeAndPeriod;
        const hasTemplate = meta.hasTemplate !== false;
        const hasCategorySelect = resolvedMode === 'exam' || resolvedMode === 'certificate';

        await load();
        closeAnyExamModal();
        panel.dataset.dirty = 'true';

        const getActiveTemplate = () => (hasTemplate && sharedTemplates[resolvedMode]) || {
          subject: meta.defaultSubject,
          body: meta.defaultBody,
          attachment_filename: null,
        };

        const candidateName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '(უსახელო)';
        const safeEmail = escapeHtml(user.email || '—');

        let textEditable = !hasTemplate;
        let textCustomized = !hasTemplate || !!(editingItem && (editingItem.subject || editingItem.body));
        let selectedFile = null;
        let useTemplateFile = hasTemplate && !editingItem;
        let keepExistingFile = !!(editingItem && editingItem.attachmentFilename);
        let modalBusy = false;

        const initialCategory = resolvedMode === 'certificate'
          ? inferCertificateCandidateCategory(user, examOutcome, statementItems, replyToStatement)
          : inferExamCandidateCategory(user, statementItems, replyToStatement);
        const categoryOptionsHtml = resolvedMode === 'certificate'
          ? [
              { key: 'A', label: 'A კატეგორია — შენობა-ნაგებობის არქიტექტორი' },
              { key: 'B', label: 'B კატეგორია — არქიტექტურული პროექტის შემსწავლელი სპეციალისტი' },
              { key: 'C', label: 'C კატეგორია — არქიტექტურული პროექტის ექსპერტი' },
            ].map((opt) => `<option value="${opt.key}"${opt.key === initialCategory ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`).join('')
          : [
              { key: 'A', label: 'A — შენობა-ნაგებობის არქიტექტორი' },
              { key: 'B', label: 'B — არქიტექტურული პროექტის შემსწავლელი სპეციალისტი' },
              { key: 'C', label: 'C — არქიტექტურული პროექტის ექსპერტი' },
              { key: 'B_A', label: 'B ან A (ქულების შესაბამისად)' },
              { key: 'C_A', label: 'C ან A (ქულების ან გამოცდილების შესაბამისად)' },
            ].map((opt) => `<option value="${opt.key}"${opt.key === initialCategory ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`).join('');

        const initialDate = editingItem?.examDate || (hasTimeAndPeriod ? '' : todayIsoDate());
        const initialPeriod = hasTimeAndPeriod ? (editingItem?.period || '') : resolvedMode;
        let modalMorningTime = (editingItem && initialPeriod === 'morning' && isValidTime(editingItem.eventTime))
          ? editingItem.eventTime.trim()
          : getDefaultScheduleTime('morning');
        let modalEveningTime = (editingItem && initialPeriod === 'evening' && isValidTime(editingItem.eventTime))
          ? editingItem.eventTime.trim()
          : getDefaultScheduleTime('evening');
        const initialTime = hasTimeAndPeriod
          ? (initialPeriod === 'morning'
              ? modalMorningTime
              : initialPeriod === 'evening'
                ? modalEveningTime
                : (editingItem?.eventTime || ''))
          : '00:00';
        let lastTokens = candidateTokens(
          user,
          initialDate,
          initialTime,
          initialPeriod,
          resolvedMode === 'certificate' ? initialCategory : ''
        );

        const modalTitleText = editingItem ? meta.editTitle : meta.createTitle;
        const replyDocNum = replyToStatement?.docNumber || (replyToStatement?.statementId ? `#${replyToStatement.statementId}` : '');
        const templateSwitcherOptionsHtml = REPLY_TEMPLATE_OPTIONS.map((opt) => (
          `<option value="${opt.mode}"${opt.mode === resolvedMode ? ' selected' : ''}>${escapeHtml(opt.title)}</option>`
        )).join('');

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay exam-schedule-modal-overlay open';
        overlay.setAttribute('aria-hidden', 'false');
        overlay.innerHTML = `
          <div class="modal exam-schedule-form-modal ${meta.modalClass}" role="dialog" aria-modal="true" aria-labelledby="examScheduleFormModalTitle">
            <div class="modal-header">
              <h3 class="modal-title" id="examScheduleFormModalTitle">${escapeHtml(modalTitleText)}</h3>
              <button class="modal-close exam-modal-close-btn" type="button" aria-label="დახურვა">×</button>
            </div>

            <div class="modal-body exam-schedule-form-modal-body">
              <!-- STEP 1: Form & Letter Editor -->
              <div class="exam-schedule-step-form">
                <div class="exam-schedule-candidate-bar">
                  <span><strong>კანდიდატი:</strong> ${escapeHtml(candidateName)}</span>
                  <span><strong>პირადი №:</strong> ${escapeHtml(user.personal_id || '—')}</span>
                  <span><strong>კოდი:</strong> ${escapeHtml(user.code || '—')}</span>
                  <span><strong>მეილი:</strong> ${safeEmail}</span>
                </div>

                ${!editingItem ? `
                  <div class="exam-schedule-reply-context-bar${replyToStatement ? ' is-statement-reply' : ''}">
                    <div class="exam-schedule-reply-context-info">
                      ${replyToStatement ? `
                        <span class="exam-schedule-reply-badge">↩ პასუხი განცხადებაზე ${escapeHtml(replyDocNum)}</span>
                        <span class="exam-schedule-reply-auto-note">✓ დადასტურებისას „პასუხი გაცემულია“ ავტომატურად მოინიშნება</span>
                      ` : `
                        <span class="exam-schedule-reply-label-text">პასუხის / შეტყობინების შაბლონი:</span>
                      `}
                    </div>
                    <label class="exam-schedule-template-switch-label">
                      <span>შაბლონის შეცვლა:</span>
                      <select class="exam-schedule-template-switch-select">${templateSwitcherOptionsHtml}</select>
                    </label>
                  </div>
                ` : ''}

                ${hasTimeAndPeriod ? `
                  <div class="exam-schedule-controls">
                    <label class="exam-schedule-date-label">${escapeHtml(meta.dateLabel)}
                      <input class="exam-schedule-date users-filter-date" type="date" value="${escapeHtml(initialDate)}" />
                    </label>

                    <div class="exam-schedule-period-group ${initialPeriod === 'morning' ? 'is-active' : ''}" data-period-group="morning">
                      <label class="users-filter-label exam-schedule-period-check">
                        <input class="exam-schedule-morning" type="checkbox" ${initialPeriod === 'morning' ? 'checked' : ''} />
                        <span>დილით</span>
                      </label>
                      <button type="button" class="exam-schedule-time-trigger" data-time-trigger="morning" title="დილის საათის რეგულირება" aria-expanded="false">
                        <svg class="exam-schedule-clock-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="10"></circle>
                          <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        <span class="exam-schedule-time-trigger-text" data-time-display="morning">${escapeHtml(modalMorningTime)}</span>
                        <span class="exam-schedule-time-trigger-badge" data-time-badge="morning" ${modalMorningTime !== getDefaultScheduleTime('morning') ? '' : 'hidden'}>ერთჯერადი</span>
                        <span class="exam-schedule-time-trigger-pill">დრო ▾</span>
                      </button>
                      <div class="exam-schedule-time-popover" data-time-popover="morning" hidden>
                        <div class="exam-schedule-time-popover-head">
                          <span class="exam-schedule-time-popover-title">დილის საათის რეგულირება</span>
                          <button type="button" class="exam-schedule-time-popover-close" data-time-close="morning" aria-label="დახურვა">×</button>
                        </div>
                        <div class="exam-schedule-time-popover-meta">
                          სტანდარტული დრო: <strong data-default-display="morning">${escapeHtml(getDefaultScheduleTime('morning'))}</strong>
                        </div>
                        <label class="exam-schedule-time-popover-field">
                          <span>აირჩიეთ საათი:</span>
                          <input class="exam-schedule-morning-time users-filter-date" type="time" step="60" value="${escapeHtml(modalMorningTime)}" aria-label="დილის საათი" />
                        </label>
                        <div class="exam-schedule-time-popover-actions">
                          <button type="button" class="exam-schedule-time-once-btn" data-time-once="morning">
                            ერთჯერადი ცვლილება
                          </button>
                          <button type="button" class="exam-schedule-time-default-btn" data-time-default="morning">
                            სტანდარტული დროის შენახვა
                          </button>
                        </div>
                      </div>
                    </div>

                    <div class="exam-schedule-period-group ${initialPeriod === 'evening' ? 'is-active' : ''}" data-period-group="evening">
                      <label class="users-filter-label exam-schedule-period-check">
                        <input class="exam-schedule-evening" type="checkbox" ${initialPeriod === 'evening' ? 'checked' : ''} />
                        <span>საღამოს</span>
                      </label>
                      <button type="button" class="exam-schedule-time-trigger" data-time-trigger="evening" title="საღამოს საათის რეგულირება" aria-expanded="false">
                        <svg class="exam-schedule-clock-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <circle cx="12" cy="12" r="10"></circle>
                          <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        <span class="exam-schedule-time-trigger-text" data-time-display="evening">${escapeHtml(modalEveningTime)}</span>
                        <span class="exam-schedule-time-trigger-badge" data-time-badge="evening" ${modalEveningTime !== getDefaultScheduleTime('evening') ? '' : 'hidden'}>ერთჯერადი</span>
                        <span class="exam-schedule-time-trigger-pill">დრო ▾</span>
                      </button>
                      <div class="exam-schedule-time-popover" data-time-popover="evening" hidden>
                        <div class="exam-schedule-time-popover-head">
                          <span class="exam-schedule-time-popover-title">საღამოს საათის რეგულირება</span>
                          <button type="button" class="exam-schedule-time-popover-close" data-time-close="evening" aria-label="დახურვა">×</button>
                        </div>
                        <div class="exam-schedule-time-popover-meta">
                          სტანდარტული დრო: <strong data-default-display="evening">${escapeHtml(getDefaultScheduleTime('evening'))}</strong>
                        </div>
                        <label class="exam-schedule-time-popover-field">
                          <span>აირჩიეთ საათი:</span>
                          <input class="exam-schedule-evening-time users-filter-date" type="time" step="60" value="${escapeHtml(modalEveningTime)}" aria-label="საღამოს საათი" />
                        </label>
                        <div class="exam-schedule-time-popover-actions">
                          <button type="button" class="exam-schedule-time-once-btn" data-time-once="evening">
                            ერთჯერადი ცვლილება
                          </button>
                          <button type="button" class="exam-schedule-time-default-btn" data-time-default="evening">
                            სტანდარტული დროის შენახვა
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ` : `
                  <input class="exam-schedule-date" type="hidden" value="${escapeHtml(initialDate)}" />
                `}

                ${hasCategorySelect ? `
                  <div class="planning-letter-category-row">
                    <label class="planning-letter-category-label">
                      <span>${resolvedMode === 'certificate' ? 'მისანიჭებელი სერტიფიკატის კატეგორია:' : 'კანდიდატის კატეგორია (განაცხადიდან):'}</span>
                      <select class="exam-schedule-category-select">${categoryOptionsHtml}</select>
                    </label>
                  </div>
                ` : ''}

                <div class="exam-schedule-letter-box">
                  <div class="exam-schedule-letter-toolbar">
                    <span class="exam-schedule-letter-title">${escapeHtml(meta.letterBoxTitle)}</span>
                    ${hasTemplate ? `
                      <div class="exam-schedule-letter-actions">
                        <button type="button" class="exam-schedule-text-edit-btn">რედაქტირება</button>
                        <button type="button" class="exam-schedule-save-template-btn" hidden>სტანდარტულ ტექსტად შენახვა</button>
                        <button type="button" class="exam-schedule-reset-text-btn" hidden>სტანდარტულის დაბრუნება</button>
                      </div>
                    ` : ''}
                  </div>
                  <label class="exam-schedule-field-label">წერილის სათაური
                    <input type="text" class="exam-schedule-subject ${!hasTemplate ? 'is-editable' : ''}" maxlength="200" ${hasTemplate ? 'readonly' : ''} placeholder="${!hasTemplate ? escapeHtml(meta.defaultSubject) : ''}" />
                  </label>
                  <label class="exam-schedule-field-label">წერილის ტექსტი
                    <textarea class="exam-schedule-body ${!hasTemplate ? 'is-editable' : ''}" rows="8" maxlength="10000" ${hasTemplate ? 'readonly' : ''} placeholder="${!hasTemplate ? 'ჩაწერეთ შეტყობინების ტექსტი...' : ''}"></textarea>
                  </label>
                </div>

                <div class="exam-schedule-attachment-wrap">
                  <label class="exam-schedule-file-btn">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                    <span>ფაილის მიბმა</span>
                    <input type="file" class="exam-schedule-file-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.zip,.rar" hidden />
                  </label>
                  <span class="exam-schedule-file-name">ფაილი არ არის მიბმული</span>
                  <button type="button" class="exam-schedule-file-clear" title="ფაილის მოხსნა" hidden>×</button>
                </div>
              </div>

              <!-- STEP 2: Confirmation & 3 Action Modes (shown when clicking "შემდეგი") -->
              <div class="exam-schedule-step-confirm" hidden>
                <div class="exam-schedule-confirm-summary"></div>
                <div class="exam-schedule-confirm-preview">
                  <div class="exam-schedule-confirm-preview-subject"></div>
                  <pre class="exam-schedule-confirm-preview-text"></pre>
                </div>
                <div class="exam-schedule-mode-group" role="radiogroup" aria-label="აირჩიეთ მოქმედება">
                  <div class="exam-schedule-mode-heading">აირჩიეთ მოქმედება:</div>
                  <label class="exam-schedule-mode-option is-selected">
                    <input type="radio" name="examScheduleActionMode" value="save_and_send" checked />
                    <div class="exam-schedule-mode-content">
                      <span class="exam-schedule-mode-title">შენახვა და გაგზავნა (სტანდარტული)</span>
                      <span class="exam-schedule-mode-desc">${escapeHtml(meta.saveAndSendDesc)}</span>
                    </div>
                  </label>
                  <label class="exam-schedule-mode-option">
                    <input type="radio" name="examScheduleActionMode" value="save_only" />
                    <div class="exam-schedule-mode-content">
                      <span class="exam-schedule-mode-title">მხოლოდ შენახვა</span>
                      <span class="exam-schedule-mode-desc">${escapeHtml(meta.saveOnlyDesc)}</span>
                    </div>
                  </label>
                  <label class="exam-schedule-mode-option">
                    <input type="radio" name="examScheduleActionMode" value="send_only" />
                    <div class="exam-schedule-mode-content">
                      <span class="exam-schedule-mode-title">მხოლოდ გაგზავნა</span>
                      <span class="exam-schedule-mode-desc">${escapeHtml(meta.sendOnlyDesc)}</span>
                    </div>
                  </label>
                </div>
              </div>

              <p class="exam-schedule-status" role="status" aria-live="polite"></p>
            </div>

            <div class="modal-footer exam-schedule-confirm-footer">
              <!-- Footer for Step 1 -->
              <div class="exam-schedule-footer-step1">
                <button type="button" class="btn-secondary exam-modal-cancel-btn">გაუქმება</button>
                <button type="button" class="btn-primary exam-schedule-next-btn">შემდეგი</button>
              </div>
              <!-- Footer for Step 2 -->
              <div class="exam-schedule-footer-step2" hidden>
                <button type="button" class="btn-secondary exam-schedule-back-btn">უკან / რედაქტირება</button>
                <button type="button" class="btn-primary exam-schedule-confirm-submit-btn">დადასტურება</button>
              </div>
            </div>
          </div>
        `;

        document.body.appendChild(overlay);

        const stepForm = overlay.querySelector('.exam-schedule-step-form');
        const stepConfirm = overlay.querySelector('.exam-schedule-step-confirm');
        const footerStep1 = overlay.querySelector('.exam-schedule-footer-step1');
        const footerStep2 = overlay.querySelector('.exam-schedule-footer-step2');

        const dateInput = overlay.querySelector('.exam-schedule-date');
        const morning = overlay.querySelector('.exam-schedule-morning');
        const evening = overlay.querySelector('.exam-schedule-evening');
        const morningTimeInput = overlay.querySelector('.exam-schedule-morning-time');
        const eveningTimeInput = overlay.querySelector('.exam-schedule-evening-time');
        const morningGroup = overlay.querySelector('[data-period-group="morning"]');
        const eveningGroup = overlay.querySelector('[data-period-group="evening"]');
        const morningTrigger = overlay.querySelector('[data-time-trigger="morning"]');
        const eveningTrigger = overlay.querySelector('[data-time-trigger="evening"]');
        const morningPopover = overlay.querySelector('[data-time-popover="morning"]');
        const eveningPopover = overlay.querySelector('[data-time-popover="evening"]');
        const morningDisplay = overlay.querySelector('[data-time-display="morning"]');
        const eveningDisplay = overlay.querySelector('[data-time-display="evening"]');
        const morningBadge = overlay.querySelector('[data-time-badge="morning"]');
        const eveningBadge = overlay.querySelector('[data-time-badge="evening"]');
        const morningDefaultDisplay = overlay.querySelector('[data-default-display="morning"]');
        const eveningDefaultDisplay = overlay.querySelector('[data-default-display="evening"]');
        const categorySelect = overlay.querySelector('.exam-schedule-category-select');
        const templateSwitchSelect = overlay.querySelector('.exam-schedule-template-switch-select');
        const subjectInput = overlay.querySelector('.exam-schedule-subject');
        const bodyInput = overlay.querySelector('.exam-schedule-body');
        const textEditBtn = overlay.querySelector('.exam-schedule-text-edit-btn');
        const saveTemplateBtn = overlay.querySelector('.exam-schedule-save-template-btn');
        const resetTextBtn = overlay.querySelector('.exam-schedule-reset-text-btn');
        const fileInput = overlay.querySelector('.exam-schedule-file-input');
        const fileNameSpan = overlay.querySelector('.exam-schedule-file-name');
        const fileClearBtn = overlay.querySelector('.exam-schedule-file-clear');
        const statusEl = overlay.querySelector('.exam-schedule-status');
        const nextBtn = overlay.querySelector('.exam-schedule-next-btn');
        const backBtn = overlay.querySelector('.exam-schedule-back-btn');
        const confirmSubmitBtn = overlay.querySelector('.exam-schedule-confirm-submit-btn');

        templateSwitchSelect?.addEventListener('change', () => {
          if (modalBusy) return;
          const nextMode = templateSwitchSelect.value || 'exam';
          if (nextMode === resolvedMode) return;
          void openScheduleFormModal(null, {
            mode: nextMode,
            returnToHistory,
            replyToStatement,
          });
        });

        function setModalStatus(msg = '', isError = false) {
          statusEl.textContent = msg;
          statusEl.classList.toggle('is-error', !!isError);
        }

        function syncPeriodGroupState() {
          morningGroup?.classList.toggle('is-active', !!morning?.checked);
          eveningGroup?.classList.toggle('is-active', !!evening?.checked);
        }

        function syncTimeTriggerUI() {
          const defMorning = getDefaultScheduleTime('morning');
          const defEvening = getDefaultScheduleTime('evening');
          if (morningDisplay) morningDisplay.textContent = modalMorningTime;
          if (eveningDisplay) eveningDisplay.textContent = modalEveningTime;
          if (morningDefaultDisplay) morningDefaultDisplay.textContent = defMorning;
          if (eveningDefaultDisplay) eveningDefaultDisplay.textContent = defEvening;
          if (morningBadge) morningBadge.hidden = modalMorningTime === defMorning;
          if (eveningBadge) eveningBadge.hidden = modalEveningTime === defEvening;
        }

        function closeTimePopovers() {
          if (morningPopover) morningPopover.hidden = true;
          if (eveningPopover) eveningPopover.hidden = true;
          morningTrigger?.setAttribute('aria-expanded', 'false');
          eveningTrigger?.setAttribute('aria-expanded', 'false');
          morningTrigger?.classList.remove('is-open');
          eveningTrigger?.classList.remove('is-open');
        }

        function toggleTimePopover(periodKey) {
          const isMorning = periodKey === 'morning';
          const targetPopover = isMorning ? morningPopover : eveningPopover;
          const targetTrigger = isMorning ? morningTrigger : eveningTrigger;
          const targetInput = isMorning ? morningTimeInput : eveningTimeInput;
          if (!targetPopover) return;
          const willOpen = targetPopover.hidden;
          closeTimePopovers();
          if (willOpen) {
            if (targetInput) {
              targetInput.value = isMorning ? modalMorningTime : modalEveningTime;
            }
            syncTimeTriggerUI();
            targetPopover.hidden = false;
            targetTrigger?.setAttribute('aria-expanded', 'true');
            targetTrigger?.classList.add('is-open');
            setTimeout(() => targetInput?.focus(), 20);
          }
        }

        function currentPeriod() {
          if (!hasTimeAndPeriod) return resolvedMode;
          if (morning?.checked) return 'morning';
          if (evening?.checked) return 'evening';
          return '';
        }

        function currentTimeValue() {
          if (!hasTimeAndPeriod) return '00:00';
          const period = currentPeriod();
          if (period === 'morning') return modalMorningTime;
          if (period === 'evening') return modalEveningTime;
          return '';
        }

        function currentSelectedCategory() {
          return categorySelect?.value || initialCategory;
        }

        function refreshRenderedText({ forceTemplate = false } = {}) {
          if (!hasTemplate) return;
          const tmpl = getActiveTemplate();
          const nextTokens = candidateTokens(
            user,
            dateInput.value,
            currentTimeValue(),
            currentPeriod(),
            resolvedMode === 'certificate' ? currentSelectedCategory() : ''
          );
          if (forceTemplate || !textCustomized) {
            subjectInput.value = applyTemplateTokens(tmpl.subject || meta.defaultSubject, nextTokens);
            const rawBody = applyTemplateTokens(tmpl.body || meta.defaultBody, nextTokens);
            bodyInput.value = injectExamResultsIntoBody(rawBody, examOutcome, resolvedMode);
          } else {
            let nextSubject = subjectInput.value;
            let nextBody = bodyInput.value;
            if (lastTokens.date && lastTokens.date !== nextTokens.date) {
              nextSubject = nextSubject.split(lastTokens.date).join(nextTokens.date);
              nextBody = nextBody.split(lastTokens.date).join(nextTokens.date);
            }
            if (hasTimeAndPeriod && lastTokens.time && lastTokens.time !== nextTokens.time) {
              nextSubject = nextSubject.split(lastTokens.time).join(nextTokens.time);
              nextBody = nextBody.split(lastTokens.time).join(nextTokens.time);
            }
            if (hasTimeAndPeriod && lastTokens.period && lastTokens.period !== nextTokens.period) {
              nextBody = nextBody.split(`(${lastTokens.period})`).join(`(${nextTokens.period})`);
            }
            if (resolvedMode === 'certificate' && lastTokens.category && lastTokens.category !== nextTokens.category) {
              nextBody = nextBody.split(lastTokens.category).join(nextTokens.category);
              nextBody = nextBody.replace(/(?:[ABC]|B\/C|შესაბამისი)\s*კატეგორიის(?=\s+სერტიფიკატის)/g, nextTokens.category);
            }
            subjectInput.value = applyTemplateTokens(nextSubject, nextTokens);
            bodyInput.value = applyTemplateTokens(nextBody, nextTokens);
          }
          lastTokens = nextTokens;
        }

        function setTextEditable(editable) {
          if (!hasTemplate) return;
          textEditable = !!editable;
          subjectInput.readOnly = !textEditable;
          bodyInput.readOnly = !textEditable;
          subjectInput.classList.toggle('is-editable', textEditable);
          bodyInput.classList.toggle('is-editable', textEditable);
          if (textEditBtn) {
            textEditBtn.textContent = textEditable ? 'რედაქტირების დასრულება' : 'რედაქტირება';
            textEditBtn.classList.toggle('is-active', textEditable);
          }
          if (saveTemplateBtn) saveTemplateBtn.hidden = !textEditable;
          if (resetTextBtn) resetTextBtn.hidden = !textEditable && !textCustomized;
        }

        function updateAttachmentUI() {
          const tmpl = getActiveTemplate();
          if (selectedFile) {
            fileNameSpan.textContent = selectedFile.name;
            fileClearBtn.hidden = false;
          } else if (keepExistingFile && editingItem?.attachmentFilename) {
            fileNameSpan.textContent = `${editingItem.attachmentFilename} (მიმაგრებული)`;
            fileClearBtn.hidden = false;
          } else if (hasTemplate && useTemplateFile && tmpl.attachment_filename) {
            fileNameSpan.textContent = `${tmpl.attachment_filename} (შაბლონის დანართი)`;
            fileClearBtn.hidden = false;
          } else {
            fileNameSpan.textContent = 'ფაილი არ არის მიბმული';
            fileClearBtn.hidden = true;
          }
        }

        // Initialize text & attachment
        const activeTmpl = getActiveTemplate();
        if (!hasTemplate) {
          subjectInput.value = editingItem?.subject || '';
          bodyInput.value = editingItem?.body || '';
          setTimeout(() => bodyInput.focus(), 50);
        } else if (editingItem && (editingItem.subject || editingItem.body)) {
          subjectInput.value = editingItem.subject || applyTemplateTokens(activeTmpl.subject || meta.defaultSubject, lastTokens);
          bodyInput.value = editingItem.body || applyTemplateTokens(activeTmpl.body || meta.defaultBody, lastTokens);
          if (resetTextBtn) resetTextBtn.hidden = false;
        } else {
          refreshRenderedText({ forceTemplate: true });
        }
        updateAttachmentUI();
        syncTimeTriggerUI();

        // Event listeners inside modal
        dateInput?.addEventListener('change', () => {
          setModalStatus('');
          refreshRenderedText();
        });

        categorySelect?.addEventListener('change', () => {
          setModalStatus('');
          refreshRenderedText();
        });

        morning?.addEventListener('change', () => {
          if (morning.checked && evening) {
            evening.checked = false;
          }
          syncPeriodGroupState();
          setModalStatus('');
          refreshRenderedText();
        });

        evening?.addEventListener('change', () => {
          if (evening.checked && morning) {
            morning.checked = false;
          }
          syncPeriodGroupState();
          setModalStatus('');
          refreshRenderedText();
        });

        morningTrigger?.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleTimePopover('morning');
        });

        eveningTrigger?.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleTimePopover('evening');
        });

        overlay.querySelectorAll('[data-time-close]').forEach((btn) => {
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            closeTimePopovers();
          });
        });

        // Clicking inside popover should not close it
        morningPopover?.addEventListener('click', (e) => e.stopPropagation());
        eveningPopover?.addEventListener('click', (e) => e.stopPropagation());

        // Clicking anywhere else in the modal closes open time popovers
        overlay.querySelector('.modal')?.addEventListener('click', () => {
          closeTimePopovers();
        });

        // Input changes inside the popover apply as a one-time change by default (without checking checkbox!)
        const applyOneTimeChange = (periodKey, closeCard = false) => {
          const isMorning = periodKey === 'morning';
          const inputEl = isMorning ? morningTimeInput : eveningTimeInput;
          const val = inputEl?.value?.trim() || '';
          if (!isValidTime(val)) {
            if (closeCard) {
              setModalStatus('გთხოვთ მიუთითოთ სწორი საათი (მაგ.: 10:00 ან 14:00).', true);
              inputEl?.focus();
            }
            return;
          }
          if (isMorning) {
            modalMorningTime = val;
          } else {
            modalEveningTime = val;
          }
          syncTimeTriggerUI();
          refreshRenderedText();
          if (closeCard) {
            closeTimePopovers();
            const label = isMorning ? 'დილის' : 'საღამოს';
            setModalStatus(`${label} საათი (${val}) დაყენდა ერთჯერადად ამ განცხადებისთვის.`);
          }
        };

        morningTimeInput?.addEventListener('input', () => applyOneTimeChange('morning', false));
        morningTimeInput?.addEventListener('change', () => applyOneTimeChange('morning', false));
        eveningTimeInput?.addEventListener('input', () => applyOneTimeChange('evening', false));
        eveningTimeInput?.addEventListener('change', () => applyOneTimeChange('evening', false));

        overlay.querySelector('[data-time-once="morning"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          applyOneTimeChange('morning', true);
        });

        overlay.querySelector('[data-time-once="evening"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          applyOneTimeChange('evening', true);
        });

        const applyAndSaveStandardTime = async (periodKey, btnEl) => {
          const isMorning = periodKey === 'morning';
          const inputEl = isMorning ? morningTimeInput : eveningTimeInput;
          const val = inputEl?.value?.trim() || '';
          if (!isValidTime(val)) {
            setModalStatus('გთხოვთ მიუთითოთ სწორი საათი (მაგ.: 10:00 ან 14:00).', true);
            inputEl?.focus();
            return;
          }
          if (isMorning) {
            modalMorningTime = val;
          } else {
            modalEveningTime = val;
          }
          if (btnEl) btnEl.disabled = true;
          const ok = await saveDefaultScheduleTimes(isMorning ? { morning: val } : { evening: val });
          if (btnEl) btnEl.disabled = false;
          syncTimeTriggerUI();
          refreshRenderedText();
          closeTimePopovers();
          const label = isMorning ? 'დილის' : 'საღამოს';
          if (ok) {
            const msg = `${label} სტანდარტული დრო (${val}) შეინახა ყველა შემდეგი განცხადებისთვის და აისახა ამ განცხადებაზეც.`;
            setModalStatus(msg, false);
            showToast(`${label} სტანდარტული დრო (${val}) შეინახა`);
          } else {
            setModalStatus(`${label} სტანდარტული დროის სერვერზე შენახვა ვერ მოხერხდა.`, true);
            showToast('სტანდარტული დროის შენახვა ვერ მოხერხდა', 'error');
          }
        };

        overlay.querySelector('[data-time-default="morning"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          void applyAndSaveStandardTime('morning', e.currentTarget);
        });

        overlay.querySelector('[data-time-default="evening"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          void applyAndSaveStandardTime('evening', e.currentTarget);
        });

        textEditBtn?.addEventListener('click', () => {
          setTextEditable(!textEditable);
          if (textEditable) bodyInput.focus();
        });

        subjectInput.addEventListener('input', () => {
          textCustomized = true;
          if (resetTextBtn) resetTextBtn.hidden = false;
        });

        bodyInput.addEventListener('input', () => {
          textCustomized = true;
          if (resetTextBtn) resetTextBtn.hidden = false;
        });

        resetTextBtn?.addEventListener('click', () => {
          textCustomized = false;
          refreshRenderedText({ forceTemplate: true });
          setTextEditable(false);
          setModalStatus('დაბრუნდა სტანდარტული ტექსტი.');
        });

        saveTemplateBtn?.addEventListener('click', async () => {
          if (modalBusy || !hasTemplate) return;
          const currentTokens = candidateTokens(
            user,
            dateInput.value,
            currentTimeValue(),
            currentPeriod(),
            resolvedMode === 'certificate' ? currentSelectedCategory() : ''
          );
          const templateSubject = convertRenderedToTemplate(subjectInput.value.trim(), currentTokens);
          const templateBody = convertRenderedToTemplate(bodyInput.value.trim(), currentTokens);
          if (!templateSubject || !templateBody) {
            setModalStatus('შაბლონის სათაური და ტექსტი არ უნდა იყოს ცარიელი.', true);
            return;
          }
          modalBusy = true;
          saveTemplateBtn.disabled = true;
          setModalStatus('სტანდარტული ტექსტი ინახება...');
          try {
            const tmpl = getActiveTemplate();
            const formData = new FormData();
            formData.append('subject', templateSubject);
            formData.append('body', templateBody);
            if (selectedFile) {
              formData.append('attachment', selectedFile);
            } else if (!useTemplateFile && tmpl.attachment_filename) {
              formData.append('remove_attachment', 'true');
            }
            const response = await fetch(`${templatesEndpoint}/${meta.templateKind}`, {
              method: 'PUT',
              headers: { ...getAdminHeaders(), ...getActorHeaders() },
              body: formData,
            });
            if (!response.ok) {
              await handleAdminErrorResponse(response, 'სტანდარტული ტექსტი ვერ შეინახა.', showToast);
              setModalStatus('სტანდარტული ტექსტი ვერ შეინახა.', true);
              return;
            }
            const saved = await response.json();
            sharedTemplates[resolvedMode] = { ...sharedTemplates[resolvedMode], ...saved };
            sharedTemplatesLoaded = true;
            textCustomized = false;
            refreshRenderedText({ forceTemplate: true });
            setTextEditable(false);
            setModalStatus('სტანდარტული ტექსტი წარმატებით შეინახა.');
            showToast('სტანდარტული წერილის შაბლონი განახლდა');
          } catch {
            setModalStatus('სტანდარტული ტექსტის შენახვა ვერ მოხერხდა.', true);
          } finally {
            modalBusy = false;
            saveTemplateBtn.disabled = false;
          }
        });

        fileInput.addEventListener('change', (e) => {
          const file = e.target.files?.[0] || null;
          selectedFile = file;
          if (file) {
            keepExistingFile = false;
          }
          updateAttachmentUI();
        });

        fileClearBtn.addEventListener('click', () => {
          selectedFile = null;
          fileInput.value = '';
          keepExistingFile = false;
          useTemplateFile = false;
          updateAttachmentUI();
        });

        const radioInputs = overlay.querySelectorAll('input[name="examScheduleActionMode"]');
        radioInputs.forEach((radio) => {
          radio.addEventListener('change', () => {
            overlay.querySelectorAll('.exam-schedule-mode-option').forEach((opt) => {
              const input = opt.querySelector('input[type="radio"]');
              opt.classList.toggle('is-selected', !!input?.checked);
            });
          });
        });

        // Step 1 -> Step 2 ("შემდეგი")
        nextBtn.addEventListener('click', () => {
          if (modalBusy) return;
          closeTimePopovers();
          if (!hasTimeAndPeriod && !isValidDate(dateInput.value)) {
            dateInput.value = todayIsoDate();
          }
          const examDate = dateInput.value;
          if (!isValidDate(examDate)) {
            setModalStatus('ჯერ აირჩიეთ თარიღი.', true);
            dateInput.focus();
            return;
          }
          const period = currentPeriod();
          if (hasTimeAndPeriod) {
            if (!period) {
              setModalStatus('აირჩიეთ „დილით“ ან „საღამოს“.', true);
              morning?.focus();
              return;
            }
            const examTime = currentTimeValue();
            if (!isValidTime(examTime)) {
              setModalStatus('გთხოვთ მიუთითოთ საათი (მაგ.: 10:00 ან 14:00).', true);
              toggleTimePopover(period);
              return;
            }
          }

          refreshRenderedText();
          if (!hasTemplate && !subjectInput.value.trim()) {
            subjectInput.value = meta.defaultSubject;
          }
          const finalSubject = subjectInput.value.trim();
          const finalBody = bodyInput.value.trim();
          if (!finalBody) {
            setModalStatus('გთხოვთ ჩაწეროთ წერილის ტექსტი.', true);
            bodyInput.focus();
            return;
          }
          if (!finalSubject) {
            setModalStatus('წერილის სათაური და ტექსტი აუცილებელია.', true);
            subjectInput.focus();
            return;
          }

          const dateLabel = formatDisplayDate(examDate);
          const periodLabel = periodLabelText(period);
          const examTime = currentTimeValue();
          const tmpl = getActiveTemplate();
          const attachmentLabel = selectedFile
            ? selectedFile.name
            : (keepExistingFile && editingItem?.attachmentFilename)
              ? editingItem.attachmentFilename
              : (hasTemplate && useTemplateFile && tmpl.attachment_filename)
                ? tmpl.attachment_filename
                : 'ფაილის გარეშე';

          const summaryEl = overlay.querySelector('.exam-schedule-confirm-summary');
          const catText = hasCategorySelect ? (categorySelect?.selectedOptions?.[0]?.textContent || currentSelectedCategory()) : '';
          summaryEl.innerHTML = `
            <div><strong>კანდიდატი:</strong> ${escapeHtml(candidateName)} (${escapeHtml(user.personal_id || '—')}, კოდი: ${escapeHtml(user.code || '—')})</div>
            <div><strong>მიმღების მეილი:</strong> ${safeEmail}</div>
            ${hasTimeAndPeriod
              ? `<div><strong>${escapeHtml(meta.historyTypeLabel)}:</strong> ${escapeHtml(dateLabel)} — ${escapeHtml(periodLabel)}, ${escapeHtml(examTime)} სთ</div>`
              : `<div><strong>წერილის ტიპი:</strong> ${escapeHtml(meta.historyTypeLabel)} (${escapeHtml(dateLabel)})</div>`}
            ${hasCategorySelect ? `<div><strong>კატეგორია:</strong> ${escapeHtml(catText)}</div>` : ''}
            <div><strong>მიმაგრებული ფაილი:</strong> ${escapeHtml(attachmentLabel)}</div>
          `;
          overlay.querySelector('.exam-schedule-confirm-preview-subject').innerHTML = `<strong>სათაური:</strong> ${escapeHtml(finalSubject)}`;
          overlay.querySelector('.exam-schedule-confirm-preview-text').textContent = finalBody;

          setModalStatus('');
          stepForm.hidden = true;
          stepConfirm.hidden = false;
          footerStep1.hidden = true;
          footerStep2.hidden = false;
        });

        // Step 2 -> Step 1 ("უკან / რედაქტირება")
        backBtn.addEventListener('click', () => {
          if (modalBusy) return;
          setModalStatus('');
          stepConfirm.hidden = true;
          stepForm.hidden = false;
          footerStep2.hidden = true;
          footerStep1.hidden = false;
        });

        // Confirm & Execute ("დადასტურება")
        confirmSubmitBtn.addEventListener('click', async () => {
          if (modalBusy) return;
          const selectedRadio = overlay.querySelector('input[name="examScheduleActionMode"]:checked');
          const actionMode = selectedRadio?.value || 'save_and_send';
          const examDate = dateInput.value || todayIsoDate();
          const period = currentPeriod();
          const examTime = currentTimeValue();
          const finalSubject = subjectInput.value.trim() || meta.defaultSubject;
          const finalBody = bodyInput.value.trim();

          modalBusy = true;
          confirmSubmitBtn.disabled = true;
          backBtn.disabled = true;
          confirmSubmitBtn.textContent = 'სრულდება...';
          setModalStatus(
            actionMode === 'save_only'
              ? 'მონაცემები ინახება...'
              : actionMode === 'send_only'
                ? 'წერილი იგზავნება...'
                : 'მონაცემები ინახება და წერილი იგზავნება...'
          );

          try {
            const formData = new FormData();
            formData.append('kind', meta.backendKind);
            formData.append('action_mode', actionMode);
            formData.append('event_date', examDate);
            formData.append('event_time', examTime);
            formData.append('period', period);
            formData.append('subject', finalSubject);
            formData.append('body', finalBody);
            formData.append('request_id', generateUuid());
            formData.append('confirmed', 'true');
            formData.append('expected_to_email', String(user.email || '').trim());
            if (hasCategorySelect) {
              formData.append('candidate_category', currentSelectedCategory());
            }
            if (replyToStatement?.statementId != null) {
              formData.append('statement_id', String(replyToStatement.statementId));
            }

            if (editingItem) {
              if (resolvedMode === 'exam' && editingItem.scheduleId != null && actionMode !== 'send_only') {
                formData.append('schedule_id', String(editingItem.scheduleId));
              }
              if (editingItem.letterId != null) {
                formData.append('edit_letter_id', String(editingItem.letterId));
              }
            }

            if (selectedFile) {
              formData.append('attachment', selectedFile);
              formData.append('use_template_attachment', 'false');
            } else if (keepExistingFile && editingItem?.letterId != null) {
              formData.append('keep_existing_attachment', 'true');
              formData.append('use_template_attachment', 'false');
            } else {
              formData.append('use_template_attachment', (hasTemplate && useTemplateFile) ? 'true' : 'false');
            }

            const response = await fetch(lettersEndpoint, {
              method: 'POST',
              headers: { ...getAdminHeaders(), ...getActorHeaders() },
              body: formData,
            });

            if (!response.ok) {
              let errText = '';
              try {
                const errPayload = await response.clone().json();
                errText = typeof errPayload?.detail === 'string' ? errPayload.detail : '';
              } catch {}
              const fallback = errText || (
                response.status === 409
                  ? 'მოქმედება ვერ შესრულდა (კონფლიქტი).'
                  : 'მოქმედება ვერ შესრულდა.'
              );
              setModalStatus(fallback, true);
              await handleAdminErrorResponse(response, fallback, showToast);
              return;
            }

            const letterResult = await response.json();
            if (letterResult && 'user_candidate_status' in letterResult) {
              user.candidate_status = letterResult.user_candidate_status || null;
              user.candidate_category = letterResult.user_candidate_category || null;
            }
            await load();
            await notifyChanged();

            if (actionMode === 'save_only') {
              showToast(meta.toastSaved);
            } else if (actionMode === 'send_only') {
              if (letterResult.status === 'failed') {
                showToast(letterResult.error || 'წერილის გაგზავნა ვერ მოხერხდა', 'error');
              } else {
                showToast('წერილი გაიგზავნა კანდიდატის მეილზე');
              }
            } else if (letterResult.status === 'failed') {
              showToast(`ჩანაწერი შეინახა, თუმცა მეილი ვერ გაიგზავნა: ${letterResult.error || ''}`, 'error');
            } else {
              showToast(meta.toastSavedAndSent);
            }

            closeAnyExamModal();
            if (returnToHistory) {
              await openScheduledExamsListModal();
            }
          } catch {
            setModalStatus('კავშირის შეცდომა. სცადეთ ხელახლა.', true);
          } finally {
            modalBusy = false;
            confirmSubmitBtn.disabled = false;
            backBtn.disabled = false;
            confirmSubmitBtn.textContent = 'დადასტურება';
          }
        });

        const handleClose = () => {
          if (modalBusy) return;
          closeAnyExamModal();
          if (returnToHistory) {
            void openScheduledExamsListModal();
          }
        };

        overlay.querySelector('.exam-modal-close-btn')?.addEventListener('click', handleClose);
        overlay.querySelector('.exam-modal-cancel-btn')?.addEventListener('click', handleClose);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) handleClose();
        });
      }

      // =========================================================================
      // MODAL 2: "განცხადებები / წერილები" (Unified Incoming Statements & Outgoing Letters)
      // =========================================================================
      async function openScheduledExamsListModal() {
        await load();
        closeAnyExamModal();

        const candidateName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '(უსახელო)';
        const safeCode = escapeHtml(user.code || '—');
        const safePersonalId = escapeHtml(user.personal_id || '—');
        const safeEmail = escapeHtml(user.email || '—');

        const selectedTypes = new Set();
        let sortOrder = 'desc'; // 'desc' (ახლიდან ძველისკენ) | 'asc' (ძველიდან ახლისკენ)
        let selectedDate = '';
        let searchQuery = '';
        let expandAllTexts = false;

        const checkboxesHtml = HISTORY_FILTER_TYPES.map((t) => `
          <label class="exam-list-type-filter-chip ${t.pillClass}" data-filter-type="${t.key}">
            <input type="checkbox" class="exam-list-type-checkbox" value="${t.key}">
            <span class="exam-list-type-chip-label">${escapeHtml(t.label)}</span>
            <span class="exam-list-type-chip-count" data-count-for="${t.key}">0</span>
          </label>
        `).join('');

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay exam-schedule-modal-overlay open';
        overlay.setAttribute('aria-hidden', 'false');
        overlay.innerHTML = `
          <div class="modal exam-scheduled-list-modal" role="dialog" aria-modal="true" aria-labelledby="examScheduledListTitle">
            <div class="modal-header">
              <div class="exam-list-header-titles">
                <h3 class="modal-title" id="examScheduledListTitle">განცხადებები, დაგეგმილი შეხვედრები და წერილები — ${escapeHtml(candidateName)}</h3>
                <div class="exam-list-candidate-meta">
                  <span><strong>კოდი:</strong> ${safeCode}</span>
                  <span><strong>პ/ნ:</strong> ${safePersonalId}</span>
                  <span><strong>ელფოსტა:</strong> ${safeEmail}</span>
                  <span class="exam-list-results-counter">სულ: 0</span>
                </div>
              </div>
              <button class="modal-close exam-list-close-btn" type="button" aria-label="დახურვა" title="დახურვა (Esc)">×</button>
            </div>

            <div class="modal-body exam-scheduled-list-body">
              <div class="exam-list-toolbar" role="region" aria-label="წერილებისა და განცხადებების ფილტრაცია და დახარისხება">
                <div class="exam-list-toolbar-top">
                  <div class="exam-list-search-wrap">
                    <span class="exam-list-search-icon" aria-hidden="true">🔍</span>
                    <input
                      type="search"
                      class="exam-list-search-input"
                      placeholder="ძებნა ნებისმიერი სიმბოლოთი (დოკუმენტის №, სათაური, ტექსტი, თარიღი, ფაილი, სტატუსი)..."
                      autocomplete="off"
                      aria-label="ძებნა განცხადებებსა და წერილებში"
                    >
                    <button type="button" class="exam-list-input-clear exam-list-search-clear" title="ძებნის გასუფთავება" hidden>×</button>
                  </div>

                  <div class="exam-list-date-wrap">
                    <label class="exam-list-control-label" for="examListDateFilter">თარიღი:</label>
                    <input
                      type="date"
                      id="examListDateFilter"
                      class="exam-list-date-input"
                      aria-label="თარიღით გაფილტვრა"
                    >
                    <button type="button" class="exam-list-input-clear exam-list-date-clear" title="თარიღის გასუფთავება" hidden>×</button>
                  </div>

                  <div class="exam-list-sort-wrap">
                    <label class="exam-list-control-label" for="examListSortSelect">დალაგება:</label>
                    <select id="examListSortSelect" class="exam-list-sort-select" aria-label="დალაგება ძველით და ახლით">
                      <option value="desc">ახლიდან ძველისკენ ↓</option>
                      <option value="asc">ძველიდან ახლისკენ ↑</option>
                    </select>
                  </div>
                </div>

                <div class="exam-list-toolbar-bottom">
                  <div class="exam-list-type-filters" role="group" aria-label="ტიპის ფილტრი">
                    ${checkboxesHtml}
                  </div>
                  <div class="exam-list-utility-actions">
                    <button type="button" class="exam-list-utility-btn exam-list-expand-all-btn">ყველა ბარათის გაშლა</button>
                    <button type="button" class="exam-list-utility-btn exam-list-reset-filters-btn" hidden>ფილტრის გასუფთავება</button>
                  </div>
                </div>
              </div>

              <p class="exam-schedule-status" role="status" aria-live="polite"></p>
              <div class="exam-schedule-history"></div>
            </div>
          </div>
        `;

        document.body.appendChild(overlay);

        const historyContainer = overlay.querySelector('.exam-schedule-history');
        const statusEl = overlay.querySelector('.exam-schedule-status');
        const resultsCounterEl = overlay.querySelector('.exam-list-results-counter');
        const searchInput = overlay.querySelector('.exam-list-search-input');
        const searchClearBtn = overlay.querySelector('.exam-list-search-clear');
        const dateInput = overlay.querySelector('.exam-list-date-input');
        const dateClearBtn = overlay.querySelector('.exam-list-date-clear');
        const sortSelect = overlay.querySelector('.exam-list-sort-select');
        const expandAllBtn = overlay.querySelector('.exam-list-expand-all-btn');
        const resetFiltersBtn = overlay.querySelector('.exam-list-reset-filters-btn');
        const typeCheckboxes = Array.from(overlay.querySelectorAll('.exam-list-type-checkbox'));
        let listBusy = false;

        function setListStatus(msg = '', isError = false) {
          statusEl.textContent = msg;
          statusEl.classList.toggle('is-error', !!isError);
        }

        function hasActiveFilters() {
          return selectedTypes.size > 0 || Boolean(selectedDate) || Boolean(searchQuery.trim());
        }

        function resetAllFilters() {
          selectedTypes.clear();
          typeCheckboxes.forEach((cb) => {
            cb.checked = false;
            cb.closest('.exam-list-type-filter-chip')?.classList.remove('is-checked');
          });
          selectedDate = '';
          if (dateInput) dateInput.value = '';
          if (dateClearBtn) dateClearBtn.hidden = true;
          searchQuery = '';
          if (searchInput) searchInput.value = '';
          if (searchClearBtn) searchClearBtn.hidden = true;
          renderModalList();
        }

        async function markStatementSeenInModal(statementId, itemRef, rowEl, badgeEl) {
          if (!statementId || seenInFlight.has(statementId)) return;
          const targetStmt = statementItems.find((s) => s.id === statementId);
          if (!targetStmt || targetStmt.seen_at != null) return;
          seenInFlight.add(statementId);
          try {
            const response = await fetch(`${API_BASE}/admin/statements/mark-seen`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getAdminHeaders(),
                ...getActorHeaders(),
              },
              body: JSON.stringify({ statement_ids: [statementId] }),
            });
            if (!response.ok) return;
            const nowIso = new Date().toISOString();
            statementItems = statementItems.map((s) => (
              s.id === statementId && s.seen_at == null
                ? { ...s, seen_at: nowIso }
                : s
            ));
            if (itemRef) {
              itemRef.seenAt = nowIso;
              itemRef.status = itemRef.answeredAt != null ? 'stmt_answered' : 'stmt_pending';
            }
            if (rowEl) {
              rowEl.classList.remove('is-stmt-unseen-row');
              rowEl.classList.add(itemRef?.answeredAt != null ? 'is-stmt-answered-row' : 'is-stmt-pending-row');
            }
            if (badgeEl && itemRef) {
              const nextBadge = statusBadgeMeta(itemRef);
              badgeEl.className = `exam-schedule-badge ${nextBadge.cls}`;
              badgeEl.textContent = nextBadge.label;
            }
            notifyStatementState();
          } catch {
            // ignore transient mark-seen error
          } finally {
            seenInFlight.delete(statementId);
          }
        }

        async function toggleStatementAnsweredInModal(statementId, answered, itemRef, rowEl, badgeEl, checkboxEl) {
          if (!statementId) return;
          if (checkboxEl) checkboxEl.disabled = true;
          try {
            const response = await fetch(`${API_BASE}/admin/statements/${encodeURIComponent(statementId)}/answered`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...getAdminHeaders(),
                ...getActorHeaders(),
              },
              body: JSON.stringify({ answered }),
            });
            if (!response.ok) {
              if (checkboxEl) checkboxEl.checked = !answered;
              await handleAdminErrorResponse(response, 'პასუხის სტატუსი ვერ შეინახა', showToast);
              return;
            }
            const data = await response.json();
            const updatedStmt = data?.statement;
            if (updatedStmt) {
              statementItems = statementItems.map((s) => (
                s.id === statementId ? { ...s, ...updatedStmt } : s
              ));
              if (itemRef) {
                itemRef.seenAt = updatedStmt.seen_at;
                itemRef.answeredAt = updatedStmt.answered_at;
                itemRef.statementRaw = { ...itemRef.statementRaw, ...updatedStmt };
                itemRef.status = updatedStmt.seen_at == null
                  ? 'stmt_unseen'
                  : updatedStmt.answered_at == null
                    ? 'stmt_pending'
                    : 'stmt_answered';
              }
              if (rowEl) {
                rowEl.classList.remove('is-stmt-unseen-row', 'is-stmt-pending-row', 'is-stmt-answered-row');
                rowEl.classList.add(
                  updatedStmt.seen_at == null
                    ? 'is-stmt-unseen-row'
                    : updatedStmt.answered_at == null
                      ? 'is-stmt-pending-row'
                      : 'is-stmt-answered-row'
                );
              }
              if (badgeEl && itemRef) {
                const nextBadge = statusBadgeMeta(itemRef);
                badgeEl.className = `exam-schedule-badge ${nextBadge.cls}`;
                badgeEl.textContent = nextBadge.label;
              }
            }
            notifyStatementState(data);
          } catch {
            if (checkboxEl) checkboxEl.checked = !answered;
            showToast('პასუხის სტატუსი ვერ შეინახა', 'error');
          } finally {
            if (checkboxEl) checkboxEl.disabled = false;
          }
        }

        async function retryLetterItem(item) {
          if (listBusy || !item.letterId) return;
          listBusy = true;
          setListStatus('წერილი თავიდან იგზავნება...');
          try {
            const response = await fetch(`${lettersEndpoint}/${encodeURIComponent(item.letterId)}/retry`, {
              method: 'POST',
              headers: { ...getAdminHeaders(), ...getActorHeaders() },
            });
            if (!response.ok) {
              setListStatus('წერილის თავიდან გაგზავნა ვერ მოხერხდა.', true);
              await handleAdminErrorResponse(response, 'წერილის თავიდან გაგზავნა ვერ მოხერხდა.', showToast);
              return;
            }
            await load();
            await notifyChanged();
            renderModalList();
            setListStatus('წერილი წარმატებით გაიგზავნა.');
            showToast('წერილი თავიდან გაიგზავნა');
          } catch {
            setListStatus('წერილის თავიდან გაგზავნა ვერ მოხერხდა.', true);
          } finally {
            listBusy = false;
          }
        }

        async function deleteItem(item) {
          if (listBusy) return;
          const dateLabel = formatDisplayDate(item.examDate);
          const confirmMsg = item.isIncomingStatement
            ? `ნამდვილად გსურთ შემოსული განცხადების წაშლა (${dateLabel})?`
            : `დარწმუნებული ხართ, რომ გსურთ ჩანაწერის წაშლა (${item.typeLabel} — ${dateLabel})?`;
          if (!global.confirm?.(confirmMsg)) {
            return;
          }
          listBusy = true;
          setListStatus('იშლება...');
          try {
            let response;
            if (item.isIncomingStatement && item.statementId != null) {
              response = await fetch(`${API_BASE}/admin/statements/${encodeURIComponent(item.statementId)}`, {
                method: 'DELETE',
                headers: { ...getAdminHeaders(), ...getActorHeaders() },
              });
            } else if (item.scheduleId != null) {
              response = await fetch(`${schedulesEndpoint}/${encodeURIComponent(item.scheduleId)}`, {
                method: 'DELETE',
                headers: { ...getAdminHeaders(), ...getActorHeaders() },
              });
            } else if (item.letterId != null) {
              response = await fetch(`${lettersEndpoint}/${encodeURIComponent(item.letterId)}`, {
                method: 'DELETE',
                headers: { ...getAdminHeaders(), ...getActorHeaders() },
              });
            }
            if (response && !response.ok) {
              setListStatus('ჩანაწერი ვერ წაიშალა.', true);
              await handleAdminErrorResponse(response, 'ჩანაწერი ვერ წაიშალა.', showToast);
              return;
            }
            await load();
            if (item.isIncomingStatement) {
              notifyStatementState();
            }
            await notifyChanged();
            renderModalList();
            setListStatus('ჩანაწერი წაიშალა.');
            showToast(item.isIncomingStatement ? 'განცხადება წაიშალა' : 'ჩანაწერი წაიშალა');
          } catch {
            setListStatus('ჩანაწერის წაშლა ვერ მოხერხდა.', true);
          } finally {
            listBusy = false;
          }
        }

        function updateTypeCounts(allItems) {
          const counts = new Map();
          HISTORY_FILTER_TYPES.forEach((t) => counts.set(t.key, 0));
          for (const item of allItems) {
            counts.set(item.filterType, (counts.get(item.filterType) || 0) + 1);
          }
          HISTORY_FILTER_TYPES.forEach((t) => {
            const countEl = overlay.querySelector(`[data-count-for="${t.key}"]`);
            const chipEl = overlay.querySelector(`[data-filter-type="${t.key}"]`);
            const c = counts.get(t.key) || 0;
            if (countEl) countEl.textContent = String(c);
            if (chipEl) chipEl.classList.toggle('is-zero', c === 0 && !selectedTypes.has(t.key));
          });
        }

        function filterAndSortItems(allItems) {
          const needle = searchQuery.trim().toLowerCase();

          const filtered = allItems.filter((item) => {
            if (selectedTypes.size > 0 && !selectedTypes.has(item.filterType)) {
              return false;
            }
            if (selectedDate) {
              const matchesEventDate = String(item.examDate || '') === selectedDate;
              const matchesSentDate = String(item.sentDateIso || '') === selectedDate;
              if (!matchesEventDate && !matchesSentDate) return false;
            }
            if (needle) {
              const badgeInfo = statusBadgeMeta(item);
              const dateLabel = formatDisplayDate(item.examDate);
              const periodLabel = periodLabelText(item.period);
              const searchable = [
                item.docNumber,
                item.typeLabel,
                item.examDate,
                dateLabel,
                periodLabel,
                item.eventTime,
                badgeInfo.label,
                item.subject,
                item.body,
                item.attachmentFilename,
                item.toEmail,
                item.sentAtDisplay,
                item.error,
              ].filter(Boolean).join(' ').toLowerCase();
              if (!searchable.includes(needle)) return false;
            }
            return true;
          });

          filtered.sort((a, b) => {
            const cmp = compareHistoryItemsChronologically(a, b);
            return sortOrder === 'asc' ? -cmp : cmp;
          });

          return filtered;
        }

        function renderModalList() {
          historyContainer.innerHTML = '';
          const allItems = buildCombinedHistory();
          updateTypeCounts(allItems);

          const filtered = filterAndSortItems(allItems);
          const activeFilter = hasActiveFilters();

          if (resetFiltersBtn) {
            resetFiltersBtn.hidden = !activeFilter;
          }
          if (resultsCounterEl) {
            resultsCounterEl.textContent = activeFilter
              ? `ნაჩვენებია: ${filtered.length} / ${allItems.length}`
              : `სულ: ${allItems.length} ჩანაწერი`;
          }
          if (expandAllBtn) {
            expandAllBtn.textContent = expandAllTexts ? 'ყველა ბარათის დაკეცვა' : 'ყველა ბარათის გაშლა';
            expandAllBtn.classList.toggle('is-active', expandAllTexts);
            expandAllBtn.disabled = filtered.length === 0;
          }

          if (!allItems.length) {
            const empty = document.createElement('p');
            empty.className = 'exam-schedule-empty';
            empty.textContent = 'ამ პირისთვის შემოსული განცხადება, დაგეგმილი შეხვედრა ან გაგზავნილი წერილი ჯერ არ არის.';
            historyContainer.appendChild(empty);
            return;
          }

          if (!filtered.length) {
            const emptyBox = document.createElement('div');
            emptyBox.className = 'exam-list-empty-filter';
            const emptyMsg = document.createElement('p');
            emptyMsg.className = 'exam-schedule-empty';
            emptyMsg.textContent = 'მითითებული ფილტრით ან საძიებო სიტყვით ჩანაწერი ვერ მოიძებნა.';
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'exam-list-utility-btn';
            clearBtn.textContent = 'ფილტრის გასუფთავება';
            clearBtn.addEventListener('click', resetAllFilters);
            emptyBox.appendChild(emptyMsg);
            emptyBox.appendChild(clearBtn);
            historyContainer.appendChild(emptyBox);
            return;
          }

          const needle = searchQuery.trim().toLowerCase();

          filtered.forEach((item) => {
            const meta = MODE_META[item.mode] || MODE_META.exam;
            const row = document.createElement('div');
            row.className = `exam-schedule-row ${item.rowClass || meta.rowClass}`;

            const summary = document.createElement('div');
            summary.className = 'exam-schedule-row-head';
            summary.setAttribute('role', 'button');
            summary.setAttribute('tabindex', '0');
            summary.setAttribute('aria-expanded', 'false');

            const headLeft = document.createElement('div');
            headLeft.className = 'exam-schedule-head-left';

            const typePill = document.createElement('span');
            typePill.className = `exam-schedule-type-pill type-${item.filterType}`;
            typePill.textContent = item.isIncomingStatement ? item.typeLabel : `↗ ${item.typeLabel}`;
            headLeft.appendChild(typePill);

            if (item.docNumber) {
              const docNumPill = document.createElement('span');
              docNumPill.className = 'exam-schedule-doc-num';
              docNumPill.textContent = item.docNumber;
              docNumPill.title = `დოკუმენტის უნიკალური ნომერი: ${item.docNumber}`;
              headLeft.appendChild(docNumPill);
            }

            const badgeInfo = statusBadgeMeta(item);
            const badge = document.createElement('span');
            badge.className = `exam-schedule-badge ${badgeInfo.cls}`;
            badge.textContent = badgeInfo.label;
            if (item.error) badge.title = item.error;
            headLeft.appendChild(badge);

            const headRight = document.createElement('div');
            headRight.className = 'exam-schedule-head-right';

            const triggerReplyForStatement = (ev) => {
              ev?.stopPropagation?.();
              if (item.seenAt == null) {
                void markStatementSeenInModal(item.statementId, item, row, badge);
              }
              void openReplyTemplateChooserModal(item, { returnToHistory: true });
            };

            const dateLabel = formatDisplayDate(item.examDate);
            const timeDisplay = item.sentAtDisplay || dateLabel;
            if (timeDisplay) {
              const sentSpan = document.createElement('span');
              sentSpan.className = 'exam-schedule-sent-time';
              sentSpan.textContent = timeDisplay;
              sentSpan.title = item.isIncomingStatement
                ? `განცხადების შემოსვლის დრო: ${timeDisplay}`
                : `გაგზავნის / შექმნის დრო: ${timeDisplay}`;
              headRight.appendChild(sentSpan);
            }

            const chevron = document.createElement('span');
            chevron.className = 'exam-schedule-chevron';
            chevron.setAttribute('aria-hidden', 'true');
            chevron.textContent = '▾';
            headRight.appendChild(chevron);

            summary.appendChild(headLeft);
            summary.appendChild(headRight);
            row.appendChild(summary);

            const bodyWrap = document.createElement('div');
            bodyWrap.className = 'exam-schedule-row-body';
            bodyWrap.hidden = true;

            const bodyBar = document.createElement('div');
            bodyBar.className = 'exam-schedule-body-bar';

            const bodyMeta = document.createElement('div');
            bodyMeta.className = 'exam-schedule-body-meta';

            if (item.docNumber) {
              const docMeta = document.createElement('span');
              docMeta.className = 'exam-schedule-meeting-pill exam-schedule-doc-meta';
              docMeta.textContent = `№ ${item.docNumber}`;
              bodyMeta.appendChild(docMeta);
            }

            const showTimeAndPeriod = !item.isIncomingStatement && meta.hasTimeAndPeriod && item.filterType !== 'cert_issued';
            if (showTimeAndPeriod) {
              const periodLabel = periodLabelText(item.period);
              const timePart = item.eventTime ? ` — ${item.eventTime} სთ` : '';
              const meetingBadge = document.createElement('span');
              meetingBadge.className = 'exam-schedule-meeting-pill';
              meetingBadge.textContent = `📅 შეხვედრა: ${dateLabel} — ${periodLabel}${timePart}`;
              bodyMeta.appendChild(meetingBadge);
            } else if (!item.isIncomingStatement && dateLabel) {
              const dateMeta = document.createElement('span');
              dateMeta.className = 'exam-schedule-meeting-pill';
              dateMeta.textContent = `📅 თარიღი: ${dateLabel}`;
              bodyMeta.appendChild(dateMeta);
            }

            const recipientEl = document.createElement('span');
            recipientEl.className = 'exam-schedule-details-recipient';
            recipientEl.textContent = item.isIncomingStatement
              ? `გამომგზავნი: ${candidateName} (${item.toEmail || user.email || '—'})`
              : `მიმღები: ${item.toEmail || user.email || '—'}`;
            bodyMeta.appendChild(recipientEl);

            if (item.attachmentFilename) {
              const fileBtn = document.createElement('button');
              fileBtn.type = 'button';
              fileBtn.className = 'exam-schedule-attachment-link';
              fileBtn.textContent = `📎 ${item.attachmentFilename}`;
              if (item.isIncomingStatement && item.statementId != null) {
                fileBtn.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  if (item.seenAt == null) {
                    void markStatementSeenInModal(item.statementId, item, row, badge);
                  }
                  void downloadStatementAttachment(item.statementId, item.attachmentFilename);
                });
              } else if (item.letterId != null) {
                fileBtn.addEventListener('click', (ev) => {
                  ev.stopPropagation();
                  void downloadLetterAttachment(item.letterId, item.attachmentFilename);
                });
              }
              bodyMeta.appendChild(fileBtn);
            }

            const actionsWrap = document.createElement('div');
            actionsWrap.className = 'exam-schedule-row-actions';

            const docHeaderLine = item.docNumber ? `დოკუმენტის №: ${item.docNumber}\n\n` : '';
            const fullText = item.isIncomingStatement
              ? `${docHeaderLine}${item.body || '(ტექსტის გარეშე)'}`
              : `${docHeaderLine}${item.subject ? `სათაური: ${item.subject}\n\n` : ''}${item.body || ''}`;

            if (item.isIncomingStatement) {
              const replyBtn = document.createElement('button');
              replyBtn.type = 'button';
              replyBtn.className = 'exam-stmt-reply-btn';
              replyBtn.textContent = '↩ პასუხის გაცემა';
              replyBtn.title = 'პასუხის გაცემა სტანდარტული შაბლონის არჩევით';
              replyBtn.addEventListener('click', triggerReplyForStatement);
              actionsWrap.appendChild(replyBtn);

              const aiBtn = document.createElement('button');
              aiBtn.type = 'button';
              aiBtn.className = 'exam-stmt-ai-btn';
              aiBtn.textContent = '✨ AI ანალიზი';
              aiBtn.title = 'განცხადებისა და მიბმული დოკუმენტის შეფასება Gemini AI-ით';
              aiBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (item.seenAt == null && item.statementId != null) {
                  void markStatementSeenInModal(item.statementId, item, row, badge);
                }
                global.dispatchEvent(
                  new CustomEvent('admin:aiAnalyzeStatement', {
                    detail: {
                      statementId: item.statementId,
                      docNumber: item.docNumber,
                      userId: user.id,
                      userName: candidateName,
                      hasAttachment: Boolean(item.attachmentFilename),
                      attachmentFilename: item.attachmentFilename || null,
                    },
                  })
                );
              });
              actionsWrap.appendChild(aiBtn);

              const answeredLabel = document.createElement('label');
              answeredLabel.className = 'exam-stmt-answered-label';
              const answeredChk = document.createElement('input');
              answeredChk.type = 'checkbox';
              answeredChk.className = 'exam-stmt-answered-checkbox';
              answeredChk.checked = item.answeredAt != null;
              answeredChk.addEventListener('change', () => {
                void toggleStatementAnsweredInModal(item.statementId, answeredChk.checked, item, row, badge, answeredChk);
              });
              const answeredTxt = document.createElement('span');
              answeredTxt.textContent = 'პასუხი გაცემულია';
              answeredLabel.appendChild(answeredChk);
              answeredLabel.appendChild(answeredTxt);
              actionsWrap.appendChild(answeredLabel);

              if (typeof downloadStatementPdf === 'function' && item.statementRaw) {
                const pdfBtn = document.createElement('button');
                pdfBtn.type = 'button';
                pdfBtn.className = 'exam-schedule-edit exam-stmt-pdf-btn';
                pdfBtn.textContent = 'PDF ჩამოტვირთვა';
                pdfBtn.addEventListener('click', async () => {
                  if (item.seenAt == null) {
                    void markStatementSeenInModal(item.statementId, item, row, badge);
                  }
                  try {
                    await downloadStatementPdf(item.statementRaw, { user });
                  } catch {
                    showToast('PDF ფაილის შექმნა ვერ მოხერხდა', 'error');
                  }
                });
                actionsWrap.appendChild(pdfBtn);
              }
            } else {
              if (item.letterId && item.status === 'failed') {
                const retryBtn = document.createElement('button');
                retryBtn.type = 'button';
                retryBtn.className = 'exam-schedule-retry';
                retryBtn.textContent = '↻ თავიდან გაგზავნა';
                retryBtn.addEventListener('click', () => retryLetterItem(item));
                actionsWrap.appendChild(retryBtn);
              }

              if (item.filterType !== 'cert_issued') {
                const editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'exam-schedule-edit';
                editBtn.textContent = 'რედაქტირება';
                editBtn.addEventListener('click', () => {
                  void openScheduleFormModal(item, { mode: item.mode, returnToHistory: true });
                });
                actionsWrap.appendChild(editBtn);
              }
            }

            if (item.isIncomingStatement || item.subject || item.body) {
              const copyBtn = document.createElement('button');
              copyBtn.type = 'button';
              copyBtn.className = 'exam-schedule-copy-btn';
              copyBtn.textContent = '📋 კოპირება';
              copyBtn.addEventListener('click', async () => {
                try {
                  await navigator.clipboard.writeText(fullText);
                  showToast('ტექსტი დაკოპირდა');
                } catch {
                  showToast('კოპირება ვერ მოხერხდა', 'error');
                }
              });
              actionsWrap.appendChild(copyBtn);
            }

            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'exam-schedule-delete';
            removeBtn.textContent = 'წაშლა';
            removeBtn.addEventListener('click', () => deleteItem(item));
            actionsWrap.appendChild(removeBtn);

            bodyBar.appendChild(bodyMeta);
            bodyBar.appendChild(actionsWrap);
            bodyWrap.appendChild(bodyBar);

            if (!item.isIncomingStatement && item.subject) {
              const subjectBar = document.createElement('div');
              subjectBar.className = 'exam-schedule-body-subject';
              const subjectStrong = document.createElement('strong');
              subjectStrong.textContent = 'თემა: ';
              const subjectSpan = document.createElement('span');
              subjectSpan.textContent = item.subject;
              subjectBar.appendChild(subjectStrong);
              subjectBar.appendChild(subjectSpan);
              bodyWrap.appendChild(subjectBar);
            }

            if (item.isIncomingStatement || item.body) {
              const pre = document.createElement('pre');
              pre.className = 'exam-schedule-confirm-preview-text';
              pre.textContent = item.docNumber
                ? `დოკუმენტის №: ${item.docNumber}\n\n${item.body || '(ტექსტის გარეშე)'}`
                : (item.body || '(ტექსტის გარეშე)');
              bodyWrap.appendChild(pre);
            }

            row.appendChild(bodyWrap);

            const setRowOpen = (openState) => {
              row.classList.toggle('is-open', openState);
              bodyWrap.hidden = !openState;
              summary.setAttribute('aria-expanded', openState ? 'true' : 'false');
              if (openState && item.isIncomingStatement && item.seenAt == null) {
                void markStatementSeenInModal(item.statementId, item, row, badge);
              }
            };

            summary.addEventListener('click', () => {
              setRowOpen(!row.classList.contains('is-open'));
            });

            summary.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                setRowOpen(!row.classList.contains('is-open'));
              }
            });

            const matchesInsideText = needle && (
              String(item.docNumber || '').toLowerCase().includes(needle)
              || String(item.subject || '').toLowerCase().includes(needle)
              || String(item.body || '').toLowerCase().includes(needle)
            );
            if (expandAllTexts || matchesInsideText) {
              setRowOpen(true);
            }

            historyContainer.appendChild(row);
          });
        }

        typeCheckboxes.forEach((cb) => {
          cb.addEventListener('change', () => {
            const val = cb.value;
            if (cb.checked) {
              selectedTypes.add(val);
            } else {
              selectedTypes.delete(val);
            }
            cb.closest('.exam-list-type-filter-chip')?.classList.toggle('is-checked', cb.checked);
            renderModalList();
          });
        });

        searchInput?.addEventListener('input', () => {
          searchQuery = searchInput.value || '';
          if (searchClearBtn) searchClearBtn.hidden = !searchQuery;
          renderModalList();
        });

        searchClearBtn?.addEventListener('click', () => {
          searchQuery = '';
          if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
          }
          searchClearBtn.hidden = true;
          renderModalList();
        });

        dateInput?.addEventListener('change', () => {
          selectedDate = dateInput.value || '';
          if (dateClearBtn) dateClearBtn.hidden = !selectedDate;
          renderModalList();
        });

        dateClearBtn?.addEventListener('click', () => {
          selectedDate = '';
          if (dateInput) dateInput.value = '';
          dateClearBtn.hidden = true;
          renderModalList();
        });

        sortSelect?.addEventListener('change', () => {
          sortOrder = sortSelect.value === 'asc' ? 'asc' : 'desc';
          renderModalList();
        });

        expandAllBtn?.addEventListener('click', () => {
          expandAllTexts = !expandAllTexts;
          renderModalList();
        });

        resetFiltersBtn?.addEventListener('click', resetAllFilters);

        renderModalList();

        const onKeyDown = (e) => {
          if (e.key === 'Escape' && !listBusy) {
            closeListModal();
          }
        };
        document.addEventListener('keydown', onKeyDown);

        const closeListModal = () => {
          if (listBusy) return;
          document.removeEventListener('keydown', onKeyDown);
          closeAnyExamModal();
        };

        overlay.querySelector('.exam-list-close-btn')?.addEventListener('click', closeListModal);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeListModal();
        });
      }

      openScheduleModalBtn?.addEventListener('click', () => {
        void openScheduleFormModal(null, { mode: 'exam', returnToHistory: false });
      });

      openRejectionModalBtn?.addEventListener('click', () => {
        void openScheduleFormModal(null, { mode: 'rejection', returnToHistory: false });
      });

      openCertificateModalBtn?.addEventListener('click', () => {
        void openScheduleFormModal(null, { mode: 'certificate', returnToHistory: false });
      });

      openExamFailModalBtn?.addEventListener('click', () => {
        void openScheduleFormModal(null, { mode: 'exam_fail', returnToHistory: false });
      });

      openCustomModalBtn?.addEventListener('click', () => {
        void openScheduleFormModal(null, { mode: 'custom', returnToHistory: false });
      });

      global.addEventListener('admin:certificateNotified', (ev) => {
        if (ev?.detail?.userId === user.id && isCurrent()) {
          void load();
        }
      });

      global.addEventListener('admin:examResultsChanged', (ev) => {
        if ((!ev?.detail?.userId || Number(ev.detail.userId) === Number(user.id)) && isCurrent()) {
          void load();
        }
      });

      global.addEventListener('admin:openStatementReply', (ev) => {
        if (Number(ev?.detail?.userId) === Number(user.id) && isCurrent()) {
          void openReplyTemplateChooserModal(ev.detail.statementItem || null, {
            returnToHistory: Boolean(ev.detail.returnToHistory),
          });
        }
      });

      updateCardButtonBadge();

      return {
        load,
        openHistoryModal: openScheduledExamsListModal,
        openReplyModal: openReplyTemplateChooserModal,
      };
    }

    return { mount };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createExamSchedulesModule = createExamSchedulesModule;
})(window);
