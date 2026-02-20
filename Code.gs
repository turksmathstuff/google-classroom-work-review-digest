function generateGradingDigest() {
  const CONFIG = {
    lookbackDays: 5,
    includeMissing: true,
    includeUndated: false,
    maxItemsInEmail: 100,
    onlyPastDue: true,

    // Past-due uses dueDate+dueTime; if no dueTime, assume end of day.
    assumeDueTimeHHMM: { hour: 23, minute: 59 },

    // New: include a ready-to-return signal when all are graded but not all returned
    includeReadyToReturn: true,

    // New: treat "uploaded but not turned in" as counting toward "has work"
    countDraftUploadsAsSubmitted: true
  };

  const myEmail = Session.getActiveUser().getEmail();
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const isoDay = Number(Utilities.formatDate(now, tz, "u")); // 1=Mon ... 7=Sun
  if (isoDay >= 6) return; // skip Saturday/Sunday

  const courses = listAllCourses_({ courseStates: "ACTIVE", teacherId: "me" });
  if (!courses.length) return;

  // Cache roster size per course to avoid repeated API calls
  const rosterCountByCourseId = new Map();

  const items = [];

  for (const course of courses) {
    const courseWork = listAllCourseWork_(course.id);
    if (!courseWork.length) continue;

    // Roster count (true student count)
    let totalStudents = rosterCountByCourseId.get(course.id);
    if (totalStudents === undefined) {
      totalStudents = listAllStudents_(course.id).length; // true roster size
      rosterCountByCourseId.set(course.id, totalStudents);
    }

    for (const work of courseWork) {
      const dueAt = getDueDateTime_(work, CONFIG);
      if (!dueAt && !CONFIG.includeUndated) continue;

      if (dueAt && CONFIG.lookbackDays != null) {
        const cutoff = new Date(now.getTime() - CONFIG.lookbackDays * 24 * 60 * 60 * 1000);
        if (dueAt < cutoff) continue;
      }

      const submissions = listAllStudentSubmissions_(course.id, work.id);
      if (!submissions.length) continue;

      // Counts
      let turnedInUngraded = 0;
      let gradedNotReturned = 0;
      let gradedCount = 0;
      let returnedCount = 0;

      let submittedCount = 0;         // TURNED_IN or RETURNED
      let uploadedNotSubmitted = 0;   // CREATED/NEW but has evidence of work
      let missing = 0;

      for (const sub of submissions) {
        const state = sub.state;
        const hasAssignedGrade = sub.assignedGrade !== undefined && sub.assignedGrade !== null;
        const hasDraftGrade = sub.draftGrade !== undefined && sub.draftGrade !== null;
        const hasAnyGrade = hasAssignedGrade || hasDraftGrade;

        // Submitted/Returned
        const isSubmitted = (state === "TURNED_IN" || state === "RETURNED");
        if (isSubmitted) submittedCount++;

        if (state === "RETURNED") returnedCount++;

        // Uploaded but not turned in (draft work present)
        if (CONFIG.countDraftUploadsAsSubmitted) {
          if ((state === "CREATED" || state === "NEW") && hasWorkEvidence_(sub)) {
            uploadedNotSubmitted++;
          }
        }

        // Turned in and needs grading
        if (state === "TURNED_IN" && !hasAnyGrade) {
          turnedInUngraded++;
        }

        // Graded
        if (hasAnyGrade) gradedCount++;

        // Graded but not returned
        if (hasAnyGrade && state !== "RETURNED") {
          gradedNotReturned++;
        }

        // Missing after due
        if (CONFIG.includeMissing && dueAt && now > dueAt) {
          if (state === "NEW" || state === "CREATED") {
            // If they have work evidence, we typically don't want to call it "missing"
            if (!hasWorkEvidence_(sub)) missing++;
          }
        }
      }

      const isPastDue = !!(dueAt && now > dueAt);

      // "Has work" = submitted + (optionally) uploaded-not-submitted
      const hasWorkCount = submittedCount + (CONFIG.countDraftUploadsAsSubmitted ? uploadedNotSubmitted : 0);

      // Ready to return signal: everyone graded, not everyone returned
      const readyToReturn =
        CONFIG.includeReadyToReturn &&
        totalStudents > 0 &&
        gradedCount === totalStudents &&
        returnedCount < totalStudents;

      // 100% "work present" (submitted OR uploaded draft)
      const is100PercentHasWork = totalStudents > 0 && hasWorkCount === totalStudents;

      // Pre-due exception: if everyone has work in, include when grading is still incomplete.
      const preDueAllWorkNeedsGrading =
        !isPastDue &&
        totalStudents > 0 &&
        is100PercentHasWork &&
        gradedCount < totalStudents;

      // Base actionable set (normally constrained to past-due when onlyPastDue is true).
      const baseActionable =
        (!CONFIG.onlyPastDue || isPastDue) && (
          turnedInUngraded > 0 ||
          gradedNotReturned > 0 ||
          (CONFIG.includeMissing && isPastDue && missing > 0)
        );

      // Include if base actionable, or one of the explicit all-class exceptions.
      const include =
        baseActionable ||
        preDueAllWorkNeedsGrading ||
        readyToReturn;

      if (!include) continue;

      items.push({
        courseName: course.name,
        title: work.title || "(Untitled)",
        link: work.alternateLink || "",
        dueAt,
        isPastDue,
        totalStudents,

        turnedInUngraded,
        gradedNotReturned,
        gradedCount,
        returnedCount,

        submittedCount,
        uploadedNotSubmitted,
        hasWorkCount,
        is100PercentHasWork,

        readyToReturn,
        missing
      });

      if (items.length >= CONFIG.maxItemsInEmail) break;
    }

    if (items.length >= CONFIG.maxItemsInEmail) break;
  }

  if (!items.length) return;

  // Sort: ready-to-return first, then past due, then most recent due date
  items.sort((a, b) => {
    if (a.readyToReturn !== b.readyToReturn) return a.readyToReturn ? -1 : 1;
    if (a.isPastDue !== b.isPastDue) return a.isPastDue ? -1 : 1;
    const at = a.dueAt ? a.dueAt.getTime() : 0;
    const bt = b.dueAt ? b.dueAt.getTime() : 0;
    return bt - at;
  });

  const htmlBody = buildDigestHtmlV2_(items, now);

  MailApp.sendEmail({
    to: myEmail,
    subject: `Grading Digest: ${items.length} item${items.length === 1 ? "" : "s"} need attention`,
    htmlBody
  });
}

/* -----------------------------
 * Evidence of draft work
 * ----------------------------- */

function hasWorkEvidence_(sub) {
  if (!sub) return false;

  // Assignment attachments
  const as = sub.assignmentSubmission;
  if (as && Array.isArray(as.attachments) && as.attachments.length > 0) return true;

  // Short answer
  const sa = sub.shortAnswerSubmission;
  if (sa && typeof sa.answer === "string" && sa.answer.trim().length > 0) return true;

  // Multiple choice
  const mc = sub.multipleChoiceSubmission;
  if (mc && mc.answer !== undefined && mc.answer !== null && String(mc.answer).trim() !== "") return true;

  return false;
}

/* -----------------------------
 * Pagination wrappers
 * ----------------------------- */

function listAllCourses_(params) {
  const out = [];
  let pageToken;
  do {
    const resp = Classroom.Courses.list(Object.assign({}, params, { pageToken }));
    if (resp && resp.courses) out.push(...resp.courses);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

function listAllCourseWork_(courseId) {
  const out = [];
  let pageToken;
  do {
    const resp = Classroom.Courses.CourseWork.list(courseId, { pageToken });
    if (resp && resp.courseWork) out.push(...resp.courseWork);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

function listAllStudentSubmissions_(courseId, courseWorkId) {
  const out = [];
  let pageToken;
  do {
    const resp = Classroom.Courses.CourseWork.StudentSubmissions.list(courseId, courseWorkId, { pageToken });
    if (resp && resp.studentSubmissions) out.push(...resp.studentSubmissions);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

// New: true roster size
function listAllStudents_(courseId) {
  const out = [];
  let pageToken;
  do {
    const resp = Classroom.Courses.Students.list(courseId, { pageToken });
    if (resp && resp.students) out.push(...resp.students);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return out;
}

/* -----------------------------
 * Due date/time handling
 * ----------------------------- */

function getDueDateTime_(work, config) {
  if (!work || !work.dueDate) return null;

  const y = work.dueDate.year;
  const m = (work.dueDate.month || 1) - 1;
  const d = work.dueDate.day || 1;

  const hh = (work.dueTime && typeof work.dueTime.hours === "number")
    ? work.dueTime.hours
    : config.assumeDueTimeHHMM.hour;

  const mm = (work.dueTime && typeof work.dueTime.minutes === "number")
    ? work.dueTime.minutes
    : config.assumeDueTimeHHMM.minute;

  return new Date(y, m, d, hh, mm, 0, 0);
}

/* -----------------------------
 * Email HTML (V2)
 * ----------------------------- */

function buildDigestHtmlV2_(items, now) {
  const tz = Session.getScriptTimeZone();
  const nowStr = Utilities.formatDate(now, tz, "EEE MMM d, yyyy h:mm a");
  const syncUrl = "chrome-extension://glimpkgmjbhcfgihnjlmiapadhjbbmej/dashboard.html";

  const rows = items.map(it => {
    const dueStr = it.dueAt ? Utilities.formatDate(it.dueAt, tz, "EEE MMM d, yyyy h:mm a") : "No due date";

    const badges = [];
    if (it.readyToReturn) badges.push(`<span style="padding:2px 6px;border:1px solid #222;border-radius:10px;font-size:11px;">READY TO RETURN</span>`);
    if (it.is100PercentHasWork) badges.push(`<span style="padding:2px 6px;border:1px solid #222;border-radius:10px;font-size:11px;">100% HAS WORK</span>`);
    if (it.isPastDue) badges.push(`<span style="padding:2px 6px;border:1px solid #666;border-radius:10px;font-size:11px;color:#666;">PAST DUE</span>`);

    const lines = [];
    if (it.turnedInUngraded > 0) lines.push(`<b>${it.turnedInUngraded}</b> turned in, ungraded`);
    if (it.gradedNotReturned > 0) lines.push(`<b>${it.gradedNotReturned}</b> graded, not returned`);
    lines.push(`<b>${it.gradedCount}</b> graded • <b>${it.returnedCount}</b> returned • <b>${it.totalStudents}</b> students`);

    if (it.uploadedNotSubmitted > 0) {
      lines.push(`<b>${it.uploadedNotSubmitted}</b> uploaded but not turned in`);
    }

    if (it.missing > 0) lines.push(`<b>${it.missing}</b> missing`);

    const status = lines.join(" • ");
    const linkHtml = it.link ? `<a href="${it.link}">Open</a>` : "";

    return `
      <tr>
        <td style="padding:10px; border-bottom:1px solid #ddd;">
          <div style="font-weight:700;">${escapeHtml_(it.courseName)}</div>
          <div>${escapeHtml_(it.title)} ${badges.length ? "&nbsp;&nbsp;" + badges.join("&nbsp;") : ""}</div>
          <div style="color:#555; font-size:12px; margin-top:2px;">Due: ${escapeHtml_(dueStr)}</div>
          <div style="margin-top:6px;">${status}</div>
          <div style="margin-top:8px;">${linkHtml}</div>
        </td>
      </tr>
    `;
  }).join("");

  return `
    <div style="font-family:Arial, sans-serif;">
      <h3 style="margin:0 0 8px 0;">Grading Digest</h3>
      <div style="color:#555; font-size:12px; margin-bottom:12px;">Generated: ${escapeHtml_(nowStr)}</div>
      <table style="border-collapse:collapse; width:100%;">${rows}</table>
      <div style="margin-top:14px;">Use Classroom SIS Export extension to synch to SIS.</div>
      <div style="color:#555; font-size:12px; margin-top:8px;">
        This email was generated by GC Work Review Digest script.
      </div>
    </div>
  `;
}

function escapeHtml_(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
