# Security operations

## Configure review administrators

The payment review summary is restricted by the backend, not by whether its button is visible.

1. In the Apps Script project, open **Project Settings → Script Properties**.
2. Set `ADMIN_EMAILS` to a comma-separated list of lowercase administrator email addresses.
3. Keep the Apps Script project and backing spreadsheet limited to trusted operators. Payment status edits are accepted only from an editor whose identity is available to the trigger and appears in this allowlist; unverified edits are reverted to `Pending`.
4. Deploy a new version of the Apps Script web app after backend changes.

If `ADMIN_EMAILS` is missing or empty, no account is an administrator: audit summary requests are denied and payment status edits fail closed.

## Authentication and sessions

OTP send and verification requests use POST bodies so email addresses and OTPs are not added to URLs. The Apps Script deployment must use the updated backend for these requests. OTP rate limits and failed-attempt lockouts are coordinated with a script lock; cache expiration is still an Apps Script platform dependency.

Signing out removes the current token on the server. If revocation cannot reach the backend, the browser clears its local session and displays a warning; the server-side token then remains valid until expiry or manual removal.

Old sessions without an expiry timestamp are rejected when next validated. Users with such legacy sessions must verify their email again.

## Payment and audit data

Payment capacity is rechecked by the backend at submission time, payment references are checked for reuse, and approval rejects a reference already present on another payment row. Payment submissions stay available for review while pending. Non-pending payment rows are removed after 30 days; audit rows are removed after 365 days. The payer name is not copied into new audit records.

Limit spreadsheet editor access to the people responsible for payment review. Google may not expose an editor identity to the installable trigger in every account configuration; in that case, review changes fail closed and the audit entry records that the editor identity was unavailable. The payment review trigger must be installed by running `installBackendTriggers` in Apps Script.

## Monitoring, backup, and recovery

- Enable Apps Script failure-notification emails for the account that owns the deployment. Check Apps Script execution logs for the privacy-safe OTP lockout warnings, and keep the GitHub ingestion workflow notification credentials configured.
- Keep periodic copies of the backing spreadsheet in a Drive folder with access limited to administrators. Test restoring a copy periodically; do not broaden access to the backup while recovering.
- If an account is compromised, remove its entry from `ADMIN_EMAILS` if applicable, clear the matching session-token value in column H of the `Users` sheet to revoke all its sessions, and review recent payment audit entries.
- If the spreadsheet or Apps Script project is compromised, disable the web-app deployment, rotate service-account and mail credentials, inspect workflow runs and Drive sharing, then redeploy only after reviewing access and restoring trusted data.

## Hosting and CI

The Netlify `_headers` file adds browser security headers and a response-level CSP. The policy currently permits inline scripts/styles because the single-page app uses inline code and event handlers. For a strict CSP, move scripts/styles into files and replace inline event handlers before removing `unsafe-inline`.

GitHub workflows use read-only repository permissions and pin third-party actions to immutable commit hashes. Keep these pins updated through reviewed dependency changes.
