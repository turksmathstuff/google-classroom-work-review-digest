# Google Classroom Work Review Digest

Google Apps Script that scans your active Google Classroom courses and emails a grading digest with assignments that need attention.

## What It Does

The main function is `generateGradingDigest()` in `Code.gs`.  
When it runs, it:

1. Loads active courses where you are the teacher.
2. Checks coursework and student submissions.
3. Builds an "actionable items" list.
4. Emails an HTML digest to your own account.

Email subject format:

`Grading Digest: <N> item(s) need attention`

## What Counts as "Needs Attention"

An assignment is included if one or more of these are true:

- Turned in but ungraded (`TURNED_IN` and no grade).
- Graded but not returned.
- Missing work (past due only, and no draft work evidence).
- Ready to return: all students graded, but not all returned.
- Pre-due exception: everyone has work submitted/uploaded, but grading is incomplete.

## Current Default Behavior

From `CONFIG` in `generateGradingDigest()`:

- `lookbackDays: 5` (ignore older due dates).
- `onlyPastDue: true` (focus on past-due items).
- `includeMissing: true`.
- `includeUndated: false`.
- `includeReadyToReturn: true`.
- `countDraftUploadsAsSubmitted: true`.
- `maxItemsInEmail: 100`.
- Weekends are skipped (Saturday/Sunday).

## Setup

1. Open a Google Apps Script project and paste `Code.gs`.
2. In Apps Script, enable Advanced Google service `Classroom API`.
3. In Google Cloud for the linked project, enable `Google Classroom API`.
4. Run `generateGradingDigest()` once manually and approve permissions.
5. Add a time-driven trigger for `generateGradingDigest()` (for example, weekdays each morning).

## Notes

- Digest is sent to `Session.getActiveUser().getEmail()`.
- Due dates without a due time are treated as due at `23:59`.
- Assignments without due dates are excluded by default.
- The email includes a hard-coded sync link:
`chrome-extension://glimpkgmjbhcfgihnjlmiapadhjbbmej/dashboard.html`
Update or remove this in `buildDigestHtmlV2_()` if needed.

## File

- `Code.gs`: full script implementation.
