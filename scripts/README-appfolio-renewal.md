# AppFolio Lease Renewal Offer Automation

This automation reads a specific row from `Lease_renewals_owner` / `Coco_XR`, logs into AppFolio with environment variables, prepares the renewal offer, and stops after configuring the renewal preview. It does not submit or send the renewal letter.

## Required environment variables

```powershell
$env:APPFOLIO_USERNAME="your-appfolio-username"
$env:APPFOLIO_PASSWORD="your-appfolio-password"
```

Optional AppFolio override:

```powershell
$env:APPFOLIO_URL="https://thetgpm.appfolio.com"
```

## AppFolio session reuse

The bot uses a Playwright persistent browser context so AppFolio cookies, localStorage, and session data survive across runs.

```powershell
$env:PLAYWRIGHT_USER_DATA_DIR=".playwright-appfolio-profile"
```

On a server, keep this path stable and writable by the user running Node/n8n. Before trying to log in, the bot opens AppFolio and checks whether the existing profile is already authenticated:

- `SESSION_REUSED` - existing AppFolio session is valid; login and 2FA are skipped.
- `LOGIN_REQUIRED` - session is missing or expired; the bot starts login.
- `MFA_REQUIRED` - AppFolio requested 2FA. The bot selects SMS, clicks `Send Verification Code`, opens GetMyMFA, reads the latest code, enters it in AppFolio, and continues.
- `LOGIN_SUCCESS` - login completed and the persistent profile has been refreshed.

Expected MFA logs:

```text
LOGIN_CREDENTIALS_FILLED
MFA_REQUIRED
MFA_SMS_SELECTED
MFA_CODE_REQUESTED
GETMYMFA_DASHBOARD_LOGIN_STARTED
GETMYMFA_DASHBOARD_LOGIN_SUCCESS
GETMYMFA_ACCESS_LAST_CODE_CLICKED
GETMYMFA_DASHBOARD_CODE_FOUND
MFA_CODE_TYPED
MFA_SUBMIT_CLICKED
LOGIN_SUCCESS
```

GetMyMFA dashboard settings:

```powershell
$env:GETMYMFA_URL="https://client.get.mymfa.io/"
$env:GETMYMFA_USERNAME="your-getmymfa-username"
$env:GETMYMFA_PASSWORD="your-getmymfa-password"
$env:GETMYMFA_PHONE_NUMBER="+16266104061"
```

Optional one-time recovery setting if GetMyMFA is unavailable:

```powershell
$env:APPFOLIO_MFA_CODE="123456"
$env:APPFOLIO_LOGIN_TIMEOUT_MS="60000"
$env:APPFOLIO_ACTION_TIMEOUT_MS="30000"
$env:APPFOLIO_DIAGNOSTIC_MODE="true"
```

When AppFolio selectors fail, diagnostic mode logs the current URL, title, page text preview, visible inputs/actions, and writes a screenshot such as `appfolio-global-search-not-found-*.png`.

## Google Sheet authentication

This bot uses a local Google OAuth client. On the first run it opens a browser so you can approve Google Sheets access. It saves the refresh token locally at `.appfolio-google-token.json`, so future runs do not require another Google login.

```powershell
$env:GOOGLE_OAUTH_CLIENT_JSON="C:\Users\Inqui\Downloads\client_secret_172984887894-fao8ei9m253ll9eoi4i3k45q4i54m9s4.apps.googleusercontent.com.json"
```

Optional token cache override:

```powershell
$env:GOOGLE_OAUTH_TOKEN_PATH=".appfolio-google-token.json"
```

The Google account you approve must have read access to the source spreadsheet. If lookup by spreadsheet name is ambiguous or unavailable, set:

```powershell
$env:LEASE_RENEWAL_SPREADSHEET_ID="spreadsheet-id"
```

For this sheet:

```powershell
$env:LEASE_RENEWAL_SPREADSHEET_ID="1dJBcNkXn2fVwgK1kETR5Sp4QuwyAIyhwjyAQ9BL5MBM"
```

## Run

```powershell
npm run appfolio:renewal
```

## Row selection for n8n/server runs

The bot no longer defaults to row 2. A row must be provided by n8n payload or an environment variable.

Supported n8n payload environment variables:

```powershell
$env:N8N_PAYLOAD='{"rowNumber":2}'
$env:N8N_INPUT='{"row":2}'
$env:N8N_JSON='{"sheetRow":2}'
$env:LEASE_RENEWAL_PAYLOAD='{"leaseRenewalRow":2}'
```

Supported payload keys:

- `rowNumber`
- `row`
- `sheetRow`
- `leaseRenewalRow`
- `row_number`
- `sheet_row`
- `lease_renewal_row`

Fallback environment variable:

```powershell
$env:LEASE_RENEWAL_ROW="2"
```

The bot checks the row color before opening AppFolio. If any cell in the row is green, it logs `SKIPPED` and exits successfully without launching Playwright.

## Addenda

The bot always includes the standard renewal addenda list. The Sheet override columns are only for one-off cases:

- Leave blank to use the standard addenda list.
- Put addenda to add in `Addendums Added`.
- Put addenda to remove in `Addendums Removed`.

Multiple addenda can be separated by commas, semicolons, or new lines.

The Month To Month section is also configured automatically:

- Clears any pre-existing Month To Month addenda.
- Adds `Month to Month Unavailable`.
- Sets Month To Month `New Rent` to `Renewal Rate * 1.12`.

Before reviewing, the bot checks `Renew by Default` and selects `Option 2` in `Default Option`.

After the renewal letter prompt, the bot selects the `Renewal Letter Option` from the Sheet:

- `Main` selects `Renewal Notice Letter`.
- `Copy` selects `Copy of Renewal Notice Letter`.

It then opens the lease preview, checks the required boxes in the lead paint, electronic notices, lawn maintenance, and pest control addenda, closes the browser without clicking `Cancel All`, and colors the processed Sheet row green.

## Exit/log states

The command logs one of these final states:

- `SUCCESS` - row processed and marked green.
- `SKIPPED` - row was already green/completed, or AppFolio showed the renewal was already sent/completed.
- `ERROR` - failed safely; screenshot is saved if a browser page was open.

Useful optional settings:

```powershell
$env:LEASE_RENEWAL_ROW="2"
$env:LEASE_RENEWAL_TAB="Coco_XR"
$env:HEADLESS="false"
$env:PLAYWRIGHT_SLOW_MO="100"
```
