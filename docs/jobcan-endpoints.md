# Jobcan internal endpoints (employee side)

Discovered by mining Jobcan's **public, unauthenticated** static JS under
`https://ssl.jobcan.jp/st/` — no login, no scraping of authenticated pages.
Asset naming follows the controller/action of the page:

| Page | Bundle |
| --- | --- |
| `/employee` (top / 打刻) | `/st/js/employee/top.js` |
| `/employee/adit/*` (打刻修正) | `/st/js/employee/adit.js` |
| `/employee/attendance` | `/st/js/employee/attendance.js` |
| man-hour (legacy UI) | `/st/js/employee/man-hour-manage.js` |
| `/employee/man-hour-manage/achievement-list` | `/st/new/js/employee/man-hour-manage/achievement-list.js` |
| `/employee/man-hour-manage/edit-achievement` | `/st/new/js/employee/man-hour-manage/edit-achievement.js` |
| list data loader (Web Worker) | `/st/new/js/common/man-hour-manage/workers/achievements.worker.js` |
| unit loader (Web Worker) | `/st/new/js/common/man-hour-manage/workers/units.worker.js` |

**Everything below is read out of shipped source, not exercised against a live
session.** Treat method/params as strong hypotheses until confirmed in DevTools.
`/st/` is public but rate-limited — probe gently.

## 打刻 (top page) — `/st/js/employee/top.js`

### `POST /employee/index/adit`
The actual punch endpoint. Params, all form-encoded:

- `adit_item` — `work_start` | `work_end` | `rest_start` | `rest_end` | `two-days-adits`
- `is_yakin` — `0` / `1` (夜勤モード)
- `notice` — free-text 備考
- `remarks[N]` — selected 備考 values
- `usedSelections[N]` / `approvedSelections[N]` — 選択備考 (new vs approved)
- `applyComments[N][0]` = element id, `applyComments[N][1]` = comment
- `adit_group_id` — from `#adit_group_id`
- `token` — CSRF, from `input[name=token]`

The page arms a 30s timeout and swaps the button into a wait state; response is
handled by `aditFinish`.

### `GET /employee/index/noop`
Session keep-alive. Plain `fetch()`, no params. Cheaper than re-fetching a page
if the extension ever needs to keep a session warm.

## 打刻修正 (adit) — `/st/js/employee/adit.js`

### `GET /employee/adit/get-summary/?year=&month=&day=`
**Confirmed live 2026-08-19.** Returns JSON
`{ time_table: "<table>…</table>", late_apply_link: "" }` for one day. No CSRF
token needed on a GET; the session cookie is enough. Wrapped by
`scripts/aditApi.js`.

`time_table` is a complete `<table class="table jbc-table">` of `th`/`td` pairs:

| Label | Example value |
| --- | --- |
| 労働時間 | `" 9時間15分"` |
| 休憩時間 | `" 2時間52分"` |
| シフト外労働時間 | `" 5時間15分"` |
| 残業時間 | `" 0時間 0分"` |
| 深夜労働時間 | `" 0時間 0分"` |
| 状態 | `"-"` |

Values are `H時間M分`, **not** `H:MM`, and single digits are space-padded
(`" 0時間 0分"`). The label set depends on the employer's 勤務形態, so treat this
list as one account's shape rather than the schema.

Note this is the *worked-time summary*, not the punch list — it does not replace
`loadPunchListData()`, which scrapes 打刻一覧 from `/employee/adit/modify/`. It is
per-day data the extension previously had no source for at all.

### `POST /employee/adit/delete/`
Form fields of the row's form + `token`. Response JSON:
`{ result, log_table: <html>, error?, adit? }`.

### `POST /employee/adit/reject/`
Same response shape; no explicit `token` set by the page (it rides in the form).

### `POST /employee/adit/update-reason`
Row form + `token`; edits the 修正理由. Same `{ result, log_table }` response.

### Insert / modify
Both go through the page's own `<form>` action (not a literal in the JS), and
respond with the same JSON envelope, validated per-field:
`employee_id`, `date` (`format` | `closed`), `time` (`empty` | `invalid` |
`format` | `auto_leave` | `early` | `duplicate`), `notice`, `group_id`.
A `refresh: true` in the response means Jobcan wants a full reload.

## 勤怠 (attendance) — `/st/js/employee/attendance.js`

The Excel/CSV export is a three-step async job — this is the ProcessId flow
`CLAUDE.md` notes as unresolved:

1. `POST /employee/attendance/download` (the search form, serialized) →
   `{ result, processId, downloadId, error? }`
2. `GET /employee/attendance/progress?processId=<id>` → polled every 1s →
   `{ progress: { current_progress, max_progress, status, errors } }`;
   `status == 1` means done, `errors == 1` means failed
3. `GET /employee/attendance/get-file?download_id=<id>` → the actual file.
   The id is also stashed in a cookie/session valid 10 minutes, path
   `/employee/attendance`.

Note the UI blocks 期間検索 over 31 days when `list_type == normal` — a client-side
limit only.

## 工数 (man-hour) — new REST API

`manHourApi.js` already wraps part of this. The base is built at runtime:

```
/${role}/man-hour-manage-api/${action}?<query>
```

where `role` is the first path segment — `employee`, `client`, or **`m`**
(mobile). Defaults to `client` off those pages. GETs carry a `token` query param
taken from `#token`'s text content; POST/PUT send `payload=<JSON>` plus `token`
in the body, and PUT is tunnelled as POST.

Actions found in the workers, beyond the four already in `manHourApi.js`:

| Action | Params | Notes |
| --- | --- | --- |
| `get-achievements-units-in-period` | `params=[...]`, `from`, `to` | units (not just kinds) for a period |
| `bulk-get-achievements-target-list` | — | target list, bulk |
| `bulk-get-managers` | — | approver lookup |
| `get-employees-count` | `group_id`, `group_where_type`, `group_descendant`, `work_kinds`, `eid`, `retirement` | admin-shaped |
| `get-units-list` | `params=[kindId]`, `limit`, `next` | cursor-paged unit list |
| `get-units-page` | `params=[kindId]`, `paginate=true`, `next`, `limit` | `pager.count` = total |
| `bulk-get-units-by-id` | `params=[kindId]`, `id` | resolve ids → units |
| `bulk-get-units-by-code` | `params=[kindId]`, `c` | resolve **codes** → units |
| `add-units-list` | `params=[kindId]`, payload | write; almost certainly admin-only |
| `bulk-update-units` | `params=[kindId]`, `data` | write; admin-only |
| `bulk-delete-units` | `params=[kindId]`, `id` | write; admin-only |
| `clear-units-cache` | — | returns `[n, n]` |

Responses are `{ status: true, data, pager?, next? }`; the worker treats HTTP
200–208/226 as success and retries on 504.

`bulk-get-units-by-code` is the interesting one for this extension — it maps a
human project/task **code** straight to a unit id without going through the
autocomplete.

## 工数テンプレート — `/employee/man-hour-template/*`

Jobcan ships a template feature. Legacy endpoints (from the old bundle):

- `GET /employee/man-hour-template/get-data-for-edit` — new template form
- `GET /employee/man-hour-template/get-data-for-edit/template_id/<id>`
- `GET /employee/man-hour-template/get-data-for-input/template_id/<id>` — the
  rows to apply, `[{ project_id, task_id, time }, ...]`
- `POST /employee/man-hour-template/remove/` — `{ id, token }`
- `/employee/man-hour-template/list` — list page

The **new** editor still uses templates: `edit-achievement.js` calls
`achievementsTemplates.GetList(...)` (populates `#template_list`) and
`achievementsTemplatesDefault.Get(...)` (populates `#add_default_manhour` with
`{ items, note, time, is_ratio }`). The endpoint URLs are injected from the page
HTML, so they are not in the bundle — capture them from the Network tab.

**This is the most promising lead for "copy a previous day".** `CLAUDE.md`
records that programmatic fill is unsolved because the unit id lives only in the
native autocomplete's opaque state. Templates sidestep that: Jobcan's own code
applies a saved set of rows to the editor. Verify on the live page whether the
apply path writes something the save accepts — and per `CLAUDE.md`, do not ship
it without a save-test on a throwaway day.

## Not employee-facing

- Admin AJAX seen in `/st/js/client/index.js`: `/client/index/load-top-informations`,
  `/client/index/request-async-refresh`, `/client/index/send-answer-to-salesforce`
- Official REST API for 勤怠 exists but is admin-issued (API連携 → 勤怠APIクライアント管理,
  client id + secret + scopes) and undocumented publicly. The only published
  Jobcan API is workflow/expenses at `https://ssl.wf.jobcan.jp/wf_api/`.

## Verifying the rest

The bundles only reveal endpoints whose URL is a literal. Anything the page
passes in via a data attribute stays hidden. To catch those, run this in the
DevTools console on an employee page before interacting:

```js
const log = [];
const of_ = window.fetch;
window.fetch = (...a) => (log.push(['fetch', String(a[0])]), of_(...a));
const oo = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u, ...r) { log.push([m, u]); return oo.call(this, m, u, ...r); };
window.__dump = () => console.table(log);
```

Then use the page and call `__dump()`.
