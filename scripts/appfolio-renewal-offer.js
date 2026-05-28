#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const process = require("node:process");
const readline = require("node:readline/promises");
const { execFile } = require("node:child_process");
const { chromium } = require("playwright");
const { google } = require("googleapis");
const dotenv = require("dotenv");

for (const envFile of [".env.local", ".env"]) {
  const envPath = path.resolve(process.cwd(), envFile);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

const CONFIG = {
  appfolioUrl: process.env.APPFOLIO_URL || "https://thetgpm.appfolio.com",
  spreadsheetName: process.env.LEASE_RENEWAL_SPREADSHEET || "Lease_renewals_owner",
  sheetName: process.env.LEASE_RENEWAL_TAB || "Coco_XR",
  rowNumber: null,
  spreadsheetId: process.env.LEASE_RENEWAL_SPREADSHEET_ID || "",
  googleOAuthClientPath: process.env.GOOGLE_OAUTH_CLIENT_JSON || "C:/Users/Inqui/Downloads/client_secret_172984887894-fao8ei9m253ll9eoi4i3k45q4i54m9s4.apps.googleusercontent.com.json",
  googleOAuthTokenPath: path.resolve(process.cwd(), process.env.GOOGLE_OAUTH_TOKEN_PATH || ".appfolio-google-token.json"),
  appfolioNoticeUrl: process.env.APPFOLIO_NOTICE_URL || "",
  headless: parseBoolean(process.env.HEADLESS, false),
  slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO || "0"),
  appfolioMfaCode: process.env.APPFOLIO_MFA_CODE || "",
  appfolioLoginTimeoutMs: Number(process.env.APPFOLIO_LOGIN_TIMEOUT_MS || "60000"),
  appfolioActionTimeoutMs: Number(process.env.APPFOLIO_ACTION_TIMEOUT_MS || "30000"),
  getMyMfaUrl: process.env.GETMYMFA_URL || "https://client.get.mymfa.io/",
  getMyMfaUsername: process.env.GETMYMFA_USERNAME || "",
  getMyMfaPassword: process.env.GETMYMFA_PASSWORD || "",
  getMyMfaPhoneNumber: process.env.GETMYMFA_PHONE_NUMBER || "+16266104061",
  diagnosticMode: parseBoolean(process.env.APPFOLIO_DIAGNOSTIC_MODE, true),
};

class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkipError";
  }
}

const COLUMNS = {
  unitId: "Unit ID",
  tenantName: "Tenant Name",
  renewalRate: "Renewal Rate",
  leaseFrom: "Lease From",
  leaseTo: "Lease To",
  earlyTerminationRate: "Early Termination Rate",
  addendumsAdded: "Addendums Added",
  addendumsRemoved: "Addendums Removed",
  renewalLetterOption: "Renewal Letter Option",
  lawn: "Lawn",
};

const DEFAULT_ADDENDUMS = [
  "ADDENDA 1-5",
  "CARPET AND CLEANING ADDENDUM",
  "Crime Free Addendum",
  "DISCLOSURE OF INFORMATION ON LEAD-BASED PAINT",
  "DRUG FREE /CRIME FREE ADDENDUM",
  "Early Termination of Lease Agreement",
  "Electronic Notices Addendum",
  "LAWN MAINTENANCE ADDENDUM",
  "MOLD ADDENDUM",
  "No Party/Noise Addendum",
  "PEST CONTROL ADDENDUM",
  "RESIDENT HANDBOOK",
  "Texting Addendum",
];

const ADDENDUM_SEARCH_QUERIES = new Map([
  [normalizeAddendumName("DISCLOSURE OF INFORMATION ON LEAD-BASED PAINT"), "lead"],
  [normalizeAddendumName("DRUG FREE /CRIME FREE ADDENDUM"), "drug free"],
  [normalizeAddendumName("No Party/Noise Addendum"), "noise"],
]);

function log(step, detail = "") {
  const suffix = detail ? ` - ${detail}` : "";
  console.log(`[${new Date().toISOString()}] ${step}${suffix}`);
}

function logState(state, detail = "") {
  log(state, detail);
}

function fail(message) {
  throw new Error(message);
}

function diagnosticLabel(value) {
  return String(value || "diagnostic").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

async function capturePageDiagnostics(page, label, detail = "") {
  if (!page || page.isClosed?.()) return "";
  const safeLabel = diagnosticLabel(label);
  const screenshotPath = path.resolve(process.cwd(), `appfolio-${safeLabel}-${Date.now()}.png`);
  const url = page.url();
  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  const summary = await page.evaluate(() => {
    function clean(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    const inputs = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true'], [role='searchbox'], [role='combobox']"))
      .filter(isVisible)
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName,
        type: element.getAttribute("type") || "",
        role: element.getAttribute("role") || "",
        name: element.getAttribute("name") || "",
        placeholder: element.getAttribute("placeholder") || "",
        aria: element.getAttribute("aria-label") || "",
        text: clean(element.textContent).slice(0, 80),
      }));

    const links = Array.from(document.querySelectorAll("a, button"))
      .filter(isVisible)
      .slice(0, 20)
      .map((element) => clean(element.textContent || element.getAttribute("aria-label")).slice(0, 80))
      .filter(Boolean);

    return { inputs, links };
  }).catch(() => ({ inputs: [], links: [] }));

  if (CONFIG.diagnosticMode) {
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  }

  log("DIAGNOSTIC", `${label}${detail ? ` - ${detail}` : ""}`);
  log("DIAGNOSTIC_URL", url);
  log("DIAGNOSTIC_TITLE", title || "(no title)");
  log("DIAGNOSTIC_BODY", bodyText.slice(0, 700).replace(/\s+/g, " "));
  log("DIAGNOSTIC_INPUTS", JSON.stringify(summary.inputs));
  log("DIAGNOSTIC_ACTIONS", JSON.stringify(summary.links));
  if (CONFIG.diagnosticMode) log("DIAGNOSTIC_SCREENSHOT", screenshotPath);
  return screenshotPath;
}

async function failWithDiagnostics(page, message, label = "failure") {
  await capturePageDiagnostics(page, label, message);
  fail(message);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`Missing required environment variable: ${name}`);
  return value;
}

async function askForInput(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function parsePositiveRowNumber(value, source) {
  if (value == null || value === "") return null;
  const rowNumber = Number(value);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    fail(`Invalid row number from ${source}: ${value}. Use a sheet row number of 2 or greater.`);
  }
  return rowNumber;
}

function findRowNumberInPayload(payload) {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const rowNumber = findRowNumberInPayload(item);
      if (rowNumber != null && rowNumber !== "") return rowNumber;
    }
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  const candidates = [
    payload.rowNumber,
    payload.row_number,
    payload.row,
    payload.sheetRow,
    payload.sheet_row,
    payload.leaseRenewalRow,
    payload.lease_renewal_row,
    payload.LEASE_RENEWAL_ROW,
    payload.body?.rowNumber,
    payload.body?.row_number,
    payload.body?.row,
    payload.body?.sheetRow,
    payload.body?.sheet_row,
    payload.body?.leaseRenewalRow,
    payload.body?.lease_renewal_row,
    payload.query?.rowNumber,
    payload.query?.row_number,
    payload.query?.row,
    payload.json?.rowNumber,
    payload.json?.row_number,
    payload.json?.row,
    payload.json?.sheetRow,
    payload.json?.sheet_row,
  ];

  for (const candidate of candidates) {
    if (candidate != null && candidate !== "") return candidate;
  }
  return null;
}

function parsePayloadJson(value, source) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Could not parse ${source} as JSON: ${error.message}`);
  }
}

function resolveRowNumber() {
  const payloadSources = [
    ["N8N_PAYLOAD", process.env.N8N_PAYLOAD],
    ["N8N_INPUT", process.env.N8N_INPUT],
    ["N8N_JSON", process.env.N8N_JSON],
    ["LEASE_RENEWAL_PAYLOAD", process.env.LEASE_RENEWAL_PAYLOAD],
  ];

  for (const [source, value] of payloadSources) {
    const payload = parsePayloadJson(value, source);
    const rowNumber = parsePositiveRowNumber(findRowNumberInPayload(payload), source);
    if (rowNumber) return rowNumber;
  }

  const argvPayload = process.argv.find((arg) => arg.trim().startsWith("{"));
  if (argvPayload) {
    const payload = parsePayloadJson(argvPayload, "CLI JSON argument");
    const rowNumber = parsePositiveRowNumber(findRowNumberInPayload(payload), "CLI JSON argument");
    if (rowNumber) return rowNumber;
  }

  const envRow = parsePositiveRowNumber(process.env.LEASE_RENEWAL_ROW, "LEASE_RENEWAL_ROW");
  if (envRow) return envRow;

  fail("No row selected. Set LEASE_RENEWAL_ROW or pass an n8n payload with rowNumber/row/sheetRow.");
}

function escapeSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

function normalizeCurrency(value) {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const number = Number(raw.replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number.toFixed(2) : raw;
}

function googleSerialToDate(serial) {
  const numericSerial = Number(serial);
  const wholeDays = Math.trunc(numericSerial);
  const fractionalDay = numericSerial - wholeDays;
  const date = new Date(1899, 11, 30);
  date.setDate(date.getDate() + wholeDays);
  if (fractionalDay) {
    date.setMilliseconds(date.getMilliseconds() + Math.round(fractionalDay * 24 * 60 * 60 * 1000));
  }
  return date;
}

function parseSheetDate(value, fieldName) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  const raw = String(value ?? "").trim();
  if (!raw) fail(`Sheet value missing for required date field: ${fieldName}`);

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const date = googleSerialToDate(raw);
    if (!Number.isNaN(date.valueOf())) return date;
  }

  const mdy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (mdy) {
    const year = Number(mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3]);
    const date = new Date(year, Number(mdy[1]) - 1, Number(mdy[2]));
    if (!Number.isNaN(date.valueOf())) return date;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.valueOf())) return parsed;

  fail(`Could not parse ${fieldName} as a date: "${raw}"`);
}

function formatDate(date) {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function subtractOneMonth(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const originalDay = result.getDate();
  result.setMonth(result.getMonth() - 1);
  if (result.getDate() !== originalDay) {
    result.setDate(0);
  }
  return result;
}

function splitAddendums(value) {
  return String(value ?? "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeAddendumName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function parseAddendumOverride(rawValue) {
  const raw = String(rawValue ?? "").trim();
  const removeMatch = raw.match(/^(?:-|remove:|remove\s+)(.+)$/i);
  const addMatch = raw.match(/^(?:\+|add:|add\s+)(.+)$/i);

  if (removeMatch) return { action: "remove", name: removeMatch[1].trim() };
  if (addMatch) return { action: "add", name: addMatch[1].trim() };
  return { action: "add", name: raw };
}

function resolveAddendums(addedValue, removedValue, legacyValue = "") {
  const addendumsByKey = new Map();
  for (const addendum of DEFAULT_ADDENDUMS) {
    addendumsByKey.set(normalizeAddendumName(addendum), addendum);
  }

  for (const addendum of splitAddendums(addedValue)) {
    addendumsByKey.set(normalizeAddendumName(addendum), addendum);
  }

  for (const addendum of splitAddendums(removedValue)) {
    addendumsByKey.delete(normalizeAddendumName(addendum));
  }

  for (const overrideValue of splitAddendums(legacyValue)) {
    const override = parseAddendumOverride(overrideValue);
    if (!override.name) continue;
    const key = normalizeAddendumName(override.name);
    if (override.action === "remove") addendumsByKey.delete(key);
    else addendumsByKey.set(key, override.name);
  }

  return Array.from(addendumsByKey.values());
}

function multiplyCurrency(value, multiplier) {
  const number = Number(String(value ?? "").replace(/[$,]/g, ""));
  if (!Number.isFinite(number)) fail(`Could not calculate rent from Renewal Rate: ${value}`);
  return (Math.round(number * multiplier * 100) / 100).toFixed(2);
}

function normalizeRenewalLetterOption(value) {
  const raw = String(value ?? "Main").trim().toLowerCase();
  if (!raw || raw === "main") return "Renewal Notice Letter";
  if (raw === "copy") return "Copy of Renewal Notice Letter";
  fail(`Renewal Letter Option must be "Main" or "Copy"; got "${value}"`);
}

function normalizeLawnOption(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["tenant", "landlord", "association"].includes(raw)) {
    return raw[0].toUpperCase() + raw.slice(1);
  }
  fail(`Lawn must be Tenant, Landlord, or Association; got "${value}"`);
}

async function getGoogleAuth() {
  const scopes = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/spreadsheets",
  ];

  if (!fs.existsSync(CONFIG.googleOAuthClientPath)) {
    fail(`Google OAuth client JSON not found: ${CONFIG.googleOAuthClientPath}`);
  }

  const clientConfig = JSON.parse(fs.readFileSync(CONFIG.googleOAuthClientPath, "utf8"));
  const installed = clientConfig.installed || clientConfig.web;
  if (!installed?.client_id || !installed?.client_secret) {
    fail("Google OAuth client JSON must contain installed.client_id and installed.client_secret");
  }

  const oauthClient = new google.auth.OAuth2(installed.client_id, installed.client_secret);
  if (fs.existsSync(CONFIG.googleOAuthTokenPath)) {
    const token = JSON.parse(fs.readFileSync(CONFIG.googleOAuthTokenPath, "utf8"));
    if (token.scope && !String(token.scope).includes("https://www.googleapis.com/auth/spreadsheets")) {
      log("Google OAuth", "Saved token is read-only; deleting it so you can approve Sheets write access");
      fs.unlinkSync(CONFIG.googleOAuthTokenPath);
    } else {
      oauthClient.setCredentials(token);
      log("Google OAuth", `Using saved refresh token at ${CONFIG.googleOAuthTokenPath}`);
      return oauthClient;
    }
  }

  return runGoogleOAuthFirstLogin(oauthClient, scopes);
}

async function runGoogleOAuthFirstLogin(oauthClient, scopes) {
  log("Google OAuth", "No saved token found; opening browser for first-time Google login");

  const server = http.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  oauthClient.redirectUri = redirectUri;

  const authUrl = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    redirect_uri: redirectUri,
  });

  const codePromise = waitForOAuthCode(server);
  await openUrl(authUrl);
  log("Google OAuth", "Complete the Google sign-in in the browser window");

  const code = await codePromise;
  const { tokens } = await oauthClient.getToken({ code, redirect_uri: redirectUri });
  oauthClient.setCredentials(tokens);
  fs.writeFileSync(CONFIG.googleOAuthTokenPath, JSON.stringify(tokens, null, 2));
  log("Google OAuth", `Saved token at ${CONFIG.googleOAuthTokenPath}`);
  return oauthClient;
}

function waitForOAuthCode(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for Google OAuth callback"));
    }, Number(process.env.GOOGLE_OAUTH_TIMEOUT_MS || "300000"));

    server.on("request", (req, res) => {
      const requestUrl = new URL(req.url, `http://${req.headers.host}`);
      if (requestUrl.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      if (error) {
        clearTimeout(timeout);
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end(`Google authorization failed: ${error}`);
        server.close();
        reject(new Error(`Google authorization failed: ${error}`));
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing OAuth code");
        return;
      }

      clearTimeout(timeout);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Google Sheets access connected.</h1><p>You can close this browser tab and return to the renewal bot.</p>");
      server.close();
      resolve(code);
    });
  });
}

function openUrl(url) {
  return new Promise((resolve) => {
    const command = process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-Command", "Start-Process -FilePath $args[0]", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];

    execFile(command[0], command[1], (error) => {
      if (error) {
        log("Google OAuth", `Could not open browser automatically. Open this URL manually: ${url}`);
      }
      resolve();
    });
  });
}

async function findSpreadsheetId(auth, spreadsheetName) {
  const drive = google.drive({ version: "v3", auth });
  const escapedName = spreadsheetName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = [
    "mimeType='application/vnd.google-apps.spreadsheet'",
    `name='${escapedName}'`,
    "trashed=false",
  ].join(" and ");

  const response = await drive.files.list({
    q: query,
    fields: "files(id,name,modifiedTime,webViewLink)",
    pageSize: 10,
    orderBy: "modifiedTime desc",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = response.data.files || [];
  if (!files.length) fail(`Google Sheet not found by name: ${spreadsheetName}`);
  if (files.length > 1) {
    log("Google Sheet lookup", `Found ${files.length} matches; using newest modified file ${files[0].id}`);
  }
  return files[0].id;
}

async function readLeaseRenewalRow() {
  const byColumn = await readLeaseRenewalRowFromSheet();
  const leaseFromDate = parseSheetDate(byColumn.leaseFrom, COLUMNS.leaseFrom);
  const leaseToDate = parseSheetDate(byColumn.leaseTo, COLUMNS.leaseTo);
  const data = {
    unitId: String(byColumn.unitId ?? "").trim(),
    tenantName: String(byColumn.tenantName ?? "").trim(),
    renewalRate: normalizeCurrency(byColumn.renewalRate),
    leaseFrom: formatDate(leaseFromDate),
    leaseTo: formatDate(leaseToDate),
    deadlineToRespond: formatDate(subtractOneMonth(leaseFromDate)),
    earlyTerminationRate: normalizeCurrency(byColumn.earlyTerminationRate),
    monthToMonthRent: multiplyCurrency(byColumn.renewalRate, 1.12),
    addendums: resolveAddendums(byColumn.addendumsAdded, byColumn.addendumsRemoved, byColumn.addendums),
    renewalLetterOption: normalizeRenewalLetterOption(byColumn.renewalLetterOption),
    lawn: normalizeLawnOption(byColumn.lawn),
  };

  if (!data.tenantName) fail("Tenant Name is blank in the source row");
  log("Loaded renewal row", `${data.tenantName}${data.unitId ? ` / ${data.unitId}` : ""}`);
  log("Resolved addenda", `${data.addendums.length} total`);
  return data;
}

async function readLeaseRenewalRowFromSheet() {
  log("Reading Google Sheet", `${CONFIG.spreadsheetName} / ${CONFIG.sheetName} row ${CONFIG.rowNumber}`);
  let response;
  try {
    const auth = await getGoogleAuth();
    const spreadsheetId = CONFIG.spreadsheetId || await findSpreadsheetId(auth, CONFIG.spreadsheetName);
    await skipIfRowAlreadyCompleted(auth, spreadsheetId);
    const sheets = google.sheets({ version: "v4", auth });
    const range = `${escapeSheetName(CONFIG.sheetName)}!A1:AZ${CONFIG.rowNumber}`;
    response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
  } catch (error) {
    if (error instanceof SkipError) throw error;
    fail(`Could not read the Google Sheet through OAuth. Original error: ${error.message}`);
  }

  const values = response.data.values || [];
  const header = values[0] || [];
  const row = values[CONFIG.rowNumber - 1] || [];
  if (!row.length) fail(`No data found at row ${CONFIG.rowNumber} in tab ${CONFIG.sheetName}`);

  const byColumn = {};
  const legacyIndex = header.findIndex((cell) => String(cell).trim() === "Addendums");
  for (const [key, columnName] of Object.entries(COLUMNS)) {
    const index = header.findIndex((cell) => String(cell).trim() === columnName);
    if (index === -1 && !["addendumsAdded", "addendumsRemoved"].includes(key)) {
      fail(`Missing required sheet column: ${columnName}`);
    }
    byColumn[key] = index === -1 ? "" : row[index] ?? "";
  }
  byColumn.addendums = legacyIndex === -1 ? "" : row[legacyIndex] ?? "";
  return byColumn;
}

async function skipIfRowAlreadyCompleted(auth, spreadsheetId) {
  const sheets = google.sheets({ version: "v4", auth });
  const range = `${escapeSheetName(CONFIG.sheetName)}!A${CONFIG.rowNumber}:AZ${CONFIG.rowNumber}`;
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [range],
    includeGridData: true,
    fields: "sheets(data(rowData(values(effectiveFormat/backgroundColor,userEnteredFormat/backgroundColor))))",
  });

  const cells = response.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values || [];
  const greenCellCount = cells.filter((cell) =>
    isCompletedGreen(cell.userEnteredFormat?.backgroundColor)
    || isCompletedGreen(cell.effectiveFormat?.backgroundColor)
  ).length;

  if (greenCellCount > 0) {
    throw new SkipError(`Row ${CONFIG.rowNumber} is already marked green/completed`);
  }
}

function isCompletedGreen(color) {
  if (!color) return false;
  const red = color.red || 0;
  const green = color.green || 0;
  const blue = color.blue || 0;
  return green >= 0.6 && green > red + 0.08 && green > blue + 0.08;
}

async function markProcessedRowGreen() {
  log("Marking Google Sheet row green", `row ${CONFIG.rowNumber}`);
  const auth = await getGoogleAuth();
  const spreadsheetId = CONFIG.spreadsheetId || await findSpreadsheetId(auth, CONFIG.spreadsheetName);
  const sheets = google.sheets({ version: "v4", auth });
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const sheet = (metadata.data.sheets || [])
    .find((entry) => entry.properties?.title === CONFIG.sheetName);
  if (!sheet) fail(`Could not find sheet tab for row coloring: ${CONFIG.sheetName}`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startRowIndex: CONFIG.rowNumber - 1,
              endRowIndex: CONFIG.rowNumber,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.72, green: 0.88, blue: 0.68 },
              },
            },
            fields: "userEnteredFormat.backgroundColor",
          },
        },
      ],
    },
  });
}

async function visibleFirst(locator, description, timeout = 10000) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  await locator.first().waitFor({ state: "visible", timeout }).catch(() => {
    fail(`Could not find ${description}`);
  });
  return locator.first();
}

async function clickByRoleOrText(page, name, description = name) {
  const matcher = name instanceof RegExp ? name : new RegExp(name, "i");
  const locators = [
    page.getByRole("button", { name: matcher }),
    page.getByRole("link", { name: matcher }),
    page.getByText(matcher).locator("visible=true"),
  ];

  for (const locator of locators) {
    const candidate = await visibleFirst(locator, description, 1500).catch(() => null);
    if (candidate) {
      await candidate.click();
      return;
    }
  }
  fail(`Could not find clickable control: ${description}`);
}

async function fillByLabel(page, labels, value) {
  if (await fillByLabelIfPresent(page, labels, value)) return;
  fail(`Could not find field for labels: ${labels.join(", ")}`);
}

async function fillByLabelIfPresent(page, labels, value) {
  for (const label of labels) {
    const regex = new RegExp(label, "i");
    const locators = [
      page.getByLabel(regex),
      page.getByPlaceholder(regex),
      page.locator(`input[aria-label*="${label}" i], textarea[aria-label*="${label}" i]`),
      page.locator("label").filter({ hasText: regex }).locator("xpath=following::input[1]"),
      page.locator("label").filter({ hasText: regex }).locator("xpath=following::textarea[1]"),
    ];

    for (const locator of locators) {
      const field = await visibleFirst(locator, label, 1500).catch(() => null);
      if (!field) continue;
      await field.fill(String(value));
      await field.press("Tab").catch(() => {});
      return true;
    }
  }
  return false;
}

async function checkByLabel(page, labels) {
  for (const label of labels) {
    const regex = new RegExp(label, "i");
    const locators = [
      page.getByLabel(regex),
      page.locator("label").filter({ hasText: regex }).locator("input[type='checkbox']"),
      page.locator("tr, .row, .form-group, .checkbox").filter({ hasText: regex }).locator("input[type='checkbox']").first(),
    ];
    for (const locator of locators) {
      const checkbox = await visibleFirst(locator, label, 1500).catch(() => null);
      if (!checkbox) continue;
      await checkbox.check();
      return;
    }
  }
  fail(`Could not find checkbox for labels: ${labels.join(", ")}`);
}

async function uncheckByLabel(page, labels) {
  for (const label of labels) {
    const regex = new RegExp(label, "i");
    const locators = [
      page.getByLabel(regex),
      page.locator("label").filter({ hasText: regex }).locator("input[type='checkbox']"),
      page.locator("tr, .row, .form-group, .checkbox").filter({ hasText: regex }).locator("input[type='checkbox']").first(),
    ];
    for (const locator of locators) {
      const checkbox = await visibleFirst(locator, label, 1500).catch(() => null);
      if (!checkbox) continue;
      await checkbox.uncheck();
      return;
    }
  }
}

async function selectByLabel(page, labels, optionText) {
  for (const label of labels) {
    const labelRegex = new RegExp(label, "i");
    const optionRegex = new RegExp(`^\\s*${escapeRegex(optionText)}\\s*$`, "i");
    const controls = [
      page.getByLabel(labelRegex),
      page.locator("label").filter({ hasText: labelRegex }).locator("xpath=following::select[1]"),
      page.locator("label").filter({ hasText: labelRegex }).locator("xpath=following::input[1]"),
      page.locator("label").filter({ hasText: labelRegex }).locator("xpath=following::*[@role='combobox'][1]"),
    ];

    for (const locator of controls) {
      const control = await visibleFirst(locator, `${label} control`, 1500).catch(() => null);
      if (!control) continue;
      const tagName = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
      if (tagName === "select") {
        const options = await control.evaluate((select) =>
          Array.from(select.options).map((option) => ({
            label: option.label || option.textContent || "",
            value: option.value || "",
          }))
        );
        const normalizedOption = optionText.trim().toLowerCase();
        const match = options.find((option) => option.label.trim().toLowerCase() === normalizedOption)
          || options.find((option) => option.value.trim().toLowerCase() === normalizedOption)
          || options.find((option) => option.label.trim().toLowerCase().includes(normalizedOption))
          || options.find((option) => normalizedOption.includes(option.label.trim().toLowerCase()) && option.value);

        if (!match) {
          const available = options
            .map((option) => option.label.trim() || option.value.trim())
            .filter(Boolean)
            .join(", ");
          fail(`Could not find "${optionText}" in ${label} options. Available options: ${available || "(none)"}`);
        }

        await control.selectOption({ value: match.value });
        return;
      }
      await control.click();
      await control.fill(optionText).catch(() => {});
      const option = page.getByRole("option", { name: optionRegex });
      const optionCandidate = await visibleFirst(option, `${optionText} option`, 3000).catch(() => null);
      if (optionCandidate) {
        await optionCandidate.click();
      } else {
        await page.keyboard.press("Enter");
      }
      return;
    }
  }
  fail(`Could not select "${optionText}" for labels: ${labels.join(", ")}`);
}

async function login(page, username, password) {
  const loginStartedAt = Date.now();
  log("LOGIN_STEP", `Opening AppFolio ${CONFIG.appfolioUrl}`);
  await page.goto(CONFIG.appfolioUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.appfolioLoginTimeoutMs });
  log("LOGIN_STEP", `AppFolio page opened at ${page.url()}`);

  if (await isSignedIn(page)) {
    await findSearchBox(page, CONFIG.appfolioActionTimeoutMs, "session reuse");
    logState("SESSION_REUSED", "Existing AppFolio authenticated browser session is valid");
    return;
  }

  logState("LOGIN_REQUIRED", "Existing AppFolio session is missing or expired");
  if (await handleExistingMfaScreen(page, loginStartedAt)) {
    await findSearchBox(page, CONFIG.appfolioActionTimeoutMs, "after AppFolio MFA login");
    logState("LOGIN_SUCCESS", "AppFolio authenticated session saved in persistent browser profile");
    return;
  }

  log("LOGIN_STEP", "Waiting for login form");
  await waitForLoginForm(page, loginStartedAt);
  log("LOGIN_STEP", "Login form detected");

  log("LOGIN_STEP", "Filling username");
  await fillByLabel(page, ["email", "username", "login"], username);
  log("LOGIN_STEP", "Username filled");

  log("LOGIN_STEP", "Filling password");
  await fillByLabel(page, ["password"], password);
  log("LOGIN_STEP", "Password filled");
  logState("LOGIN_CREDENTIALS_FILLED", "Filled AppFolio username and password from environment");

  log("LOGIN_STEP", "Clicking login button");
  await clickByRoleOrText(page, "sign in|log in|login", "login button");
  log("LOGIN_STEP", "Login button clicked; waiting for signed-in UI or MFA prompt");

  const firstOutcome = await waitForLoginOutcome(page, loginStartedAt);
  log("LOGIN_STEP", `Login outcome detected: ${firstOutcome}`);

  if (firstOutcome === "mfa") {
    await handleMfa(page, loginStartedAt);
    const mfaOutcome = await waitForLoginOutcome(page, loginStartedAt);
    log("LOGIN_STEP", `Post-MFA outcome detected: ${mfaOutcome}`);
  }

  if (!await isSignedIn(page)) {
    await saveLoginHangScreenshot(page, "login-not-complete");
    fail(`AppFolio login did not complete within ${CONFIG.appfolioLoginTimeoutMs}ms`);
  }
  await findSearchBox(page, CONFIG.appfolioActionTimeoutMs, "after AppFolio login");
  logState("LOGIN_SUCCESS", "AppFolio authenticated session saved in persistent browser profile");
}

async function handleExistingMfaScreen(page, loginStartedAt) {
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  if (await isMfaChoiceScreen(page, bodyText) || isMfaCodeEntryScreen(bodyText)) {
    await handleMfa(page, loginStartedAt);
    return true;
  }
  return false;
}

async function handleMfa(page, loginStartedAt) {
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  if (await isMfaChoiceScreen(page, bodyText)) {
    await requestSmsVerificationCode(page);
  } else {
    logState("MFA_REQUIRED", "AppFolio requested MFA code entry");
  }

  if (await isSignedIn(page)) {
    logState("LOGIN_SUCCESS", "AppFolio authenticated after MFA step");
    return;
  }

  const verificationCode = await getMfaCodeFromDashboard(page);
  if (!verificationCode) {
    if (!CONFIG.appfolioMfaCode) {
      fail("MFA_REQUIRED: AppFolio requested verification and GetMyMFA did not return a code.");
    }
    await fillMfaCode(page, CONFIG.appfolioMfaCode);
  } else {
    await fillMfaCode(page, verificationCode);
  }

  logState("MFA_CODE_TYPED", "Entered verification code into AppFolio");
  await clickMfaSubmitButton(page);
  logState("MFA_SUBMIT_CLICKED", "Clicked AppFolio MFA submit button");

  const deadline = loginStartedAt + CONFIG.appfolioLoginTimeoutMs;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    await page.waitForTimeout(500);
  }
  await saveLoginHangScreenshot(page, "mfa-login-not-complete");
  fail(`AppFolio MFA login did not complete within ${CONFIG.appfolioLoginTimeoutMs}ms`);
}

async function waitForLoginForm(page, startedAt) {
  while (Date.now() - startedAt < CONFIG.appfolioLoginTimeoutMs) {
    if (await isSignedIn(page)) return;
    const emailField = await page.getByLabel(/email|username|login/i).first().isVisible().catch(() => false);
    const passwordField = await page.getByLabel(/password/i).first().isVisible().catch(() => false);
    const emailInput = await page.locator("input[type='email'], input[name*='email' i], input[name*='username' i], input[name*='login' i]").first()
      .isVisible()
      .catch(() => false);
    const passwordInput = await page.locator("input[type='password'], input[name*='password' i]").first()
      .isVisible()
      .catch(() => false);
    if ((emailField || emailInput) && (passwordField || passwordInput)) return;
    await page.waitForTimeout(500);
  }
  await saveLoginHangScreenshot(page, "login-form-timeout");
  fail(`AppFolio login form did not appear within ${CONFIG.appfolioLoginTimeoutMs}ms`);
}

async function waitForLoginOutcome(page, startedAt) {
  while (Date.now() - startedAt < CONFIG.appfolioLoginTimeoutMs) {
    if (await isSignedIn(page)) return "signed-in";
    const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (await isMfaChoiceScreen(page, bodyText) || isMfaCodeEntryScreen(bodyText)) return "mfa";
    if (/invalid|incorrect|could not log|try again|account locked/i.test(bodyText)) {
      await saveLoginHangScreenshot(page, "login-error");
      fail(`AppFolio login page reported an error. Page text starts with: ${bodyText.slice(0, 300)}`);
    }
    await page.waitForTimeout(750);
  }

  await saveLoginHangScreenshot(page, "login-outcome-timeout");
  fail(`AppFolio login did not complete within ${CONFIG.appfolioLoginTimeoutMs}ms`);
}

async function isMfaChoiceScreen(page, bodyText) {
  const hasMfaChoiceControls = await page.evaluate(() => {
    const sms = document.querySelector("#method-sms, input[name='twoFactorMethod'][value*='sms' i]");
    const send = document.querySelector("#send_verification_code, input[name='send_verification_code']");
    return Boolean(sms && send);
  }).catch(() => false);
  if (hasMfaChoiceControls) return true;

  const hasVerificationPrompt = /2-step verification|two-step verification|verification method/i.test(bodyText);
  const hasSmsOption = /receive code via sms|sms/i.test(bodyText);
  const hasAlternateDeliveryOption = /receive code via phone call|phone call|call/i.test(bodyText);
  const hasSendButtonText = /send verification code/i.test(bodyText);
  return hasVerificationPrompt && hasSmsOption && (hasAlternateDeliveryOption || hasSendButtonText);
}

function isMfaCodeEntryScreen(bodyText) {
  return /2-step verification|two-step verification|verification code|enter.*code|mfa/i.test(bodyText) &&
    !/receive code via sms|receive code via phone call|send verification code/i.test(bodyText);
}

async function requestSmsVerificationCode(page) {
  logState("MFA_REQUIRED", "AppFolio requested 2-Step Verification method selection");
  await selectSmsVerificationMethod(page);
  await clickSendVerificationCode(page);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1000);
  logState("MFA_CODE_REQUESTED", "Clicked Send Verification Code after selecting SMS");
}

async function selectSmsVerificationMethod(page) {
  const directSmsRadio = page.locator("#method-sms, input[name='twoFactorMethod'][value*='sms' i]").first();
  if (await directSmsRadio.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!await directSmsRadio.isChecked().catch(() => false)) await directSmsRadio.check({ force: true });
    logState("MFA_SMS_SELECTED", "Selected SMS verification radio");
    return;
  }

  const selected = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label"));
    const smsLabel = labels.find((label) => /receive code via sms|sms/i.test(label.innerText || label.textContent || ""));
    if (smsLabel) {
      const forId = smsLabel.getAttribute("for");
      const radio = forId ? document.getElementById(forId) : smsLabel.querySelector("input[type='radio']");
      if (radio && radio instanceof HTMLInputElement) {
        radio.checked = true;
        radio.dispatchEvent(new Event("input", { bubbles: true }));
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      smsLabel.click();
      return true;
    }
    return false;
  });
  if (!selected) fail("Could not select AppFolio SMS verification option");
  logState("MFA_SMS_SELECTED", "Selected SMS verification option");
}

async function clickSendVerificationCode(page) {
  const directButton = page.locator("#send_verification_code, input[name='send_verification_code']").first();
  if (await directButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await directButton.click({ force: true });
    return;
  }

  const clicked = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button']"));
    const sendControl = controls.find((control) => /send verification code/i.test(`${control.innerText || ""} ${control.textContent || ""} ${control.value || ""} ${control.id || ""} ${control.name || ""}`));
    if (!sendControl) return false;
    sendControl.click();
    return true;
  }).catch(() => false);
  if (clicked) return;

  await clickByRoleOrText(page, /send verification code/i, "Send Verification Code button");
}

async function fillMfaCode(page, code) {
  const codeField = page.locator("#user-verification-code, input[name='code'], input[type='number'], input[type='tel'], input[type='text']").first();
  const field = await visibleFirst(codeField, "AppFolio verification code", CONFIG.appfolioActionTimeoutMs);
  await field.fill(String(code).replace(/\D/g, ""));
  await field.press("Tab").catch(() => {});
}

async function clickMfaSubmitButton(page) {
  const submit = page.locator("button, a, [role='button'], input[type='submit']").filter({ hasText: /verify|submit|continue|sign in|log in|login/i })
    .or(page.locator("input[type='submit'][value*='Log in' i], input[type='submit'][value*='Verify' i], input[type='submit'][value*='Continue' i]"));
  const button = await visibleFirst(submit, "AppFolio MFA submit button", CONFIG.appfolioActionTimeoutMs);
  await button.click({ force: true });
}

async function getMfaCodeFromDashboard(appfolioPage) {
  if (!CONFIG.getMyMfaUsername || !CONFIG.getMyMfaPassword || !CONFIG.getMyMfaPhoneNumber) {
    logState("GETMYMFA_DASHBOARD_NOT_CONFIGURED", "GETMYMFA_USERNAME, GETMYMFA_PASSWORD, or GETMYMFA_PHONE_NUMBER is missing");
    return "";
  }

  const dashboardPage = await appfolioPage.context().newPage();
  try {
    logState("GETMYMFA_DASHBOARD_LOGIN_STARTED", `Opening ${CONFIG.getMyMfaUrl}`);
    await dashboardPage.goto(CONFIG.getMyMfaUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.appfolioActionTimeoutMs });
    await loginToGetMyMfaDashboard(dashboardPage);
    logState("GETMYMFA_DASHBOARD_LOGIN_SUCCESS", "GetMyMFA dashboard loaded");
    await clickAccessLastMfaCode(dashboardPage);
    logState("GETMYMFA_ACCESS_LAST_CODE_CLICKED", `Clicked Access last MFA code for ${CONFIG.getMyMfaPhoneNumber}`);
    const code = await readDashboardMfaCode(dashboardPage);
    logState("GETMYMFA_DASHBOARD_CODE_FOUND", "Read 6-digit MFA code from GetMyMFA dashboard");
    await appfolioPage.bringToFront();
    return code;
  } catch (error) {
    const bodyText = await dashboardPage.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    logState("GETMYMFA_DASHBOARD_FAILED", `${error.message} url=${dashboardPage.url()} body=${bodyText.slice(0, 300).replace(/\s+/g, " ")}`);
    await appfolioPage.bringToFront().catch(() => {});
    return "";
  } finally {
    await dashboardPage.close().catch(() => {});
  }
}

async function loginToGetMyMfaDashboard(page) {
  if (await isGetMyMfaDashboardVisible(page).catch(() => false)) {
    logState("GETMYMFA_SESSION_REUSED", "Existing GetMyMFA dashboard session is valid");
    return;
  }

  await waitForGetMyMfaLoginOrDashboard(page);
  if (await isGetMyMfaDashboardVisible(page).catch(() => false)) {
    logState("GETMYMFA_SESSION_REUSED", "Existing GetMyMFA dashboard session is valid");
    return;
  }

  await fillLoginLocator(page, getGetMyMfaUsernameInput(page), CONFIG.getMyMfaUsername, "GetMyMFA username");
  await fillLoginLocator(page, page.locator("input[type='password']").first(), CONFIG.getMyMfaPassword, "GetMyMFA password");
  await clickGetMyMfaSubmit(page);
  await waitForGetMyMfaDashboard(page);
}

async function waitForGetMyMfaLoginOrDashboard(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: Math.min(CONFIG.appfolioActionTimeoutMs, 10000) }).catch(() => {});

  const deadline = Date.now() + CONFIG.appfolioActionTimeoutMs;
  while (Date.now() < deadline) {
    if (await isGetMyMfaDashboardVisible(page).catch(() => false)) return;
    const hasLoginInputs = await getGetMyMfaUsernameInput(page).isVisible({ timeout: 500 }).catch(() => false) &&
      await page.locator("input[type='password']").first().isVisible({ timeout: 500 }).catch(() => false);
    if (hasLoginInputs) return;
    await page.waitForTimeout(500);
  }
}

function getGetMyMfaUsernameInput(page) {
  return page.locator([
    "input[type='email']",
    "input[name*='email' i]",
    "input[id*='email' i]",
    "input[name*='user' i]",
    "input[id*='user' i]",
    "input[autocomplete='username']",
    "input[type='text']",
    "input:not([type])",
  ].join(", ")).first();
}

async function fillLoginLocator(page, locator, value, description) {
  const input = await visibleFirst(locator, description, CONFIG.appfolioActionTimeoutMs);
  await input.fill(String(value));
  await input.press("Tab").catch(() => {});
}

async function isGetMyMfaDashboardVisible(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  if (/my phone numbers|access last mfa code/i.test(bodyText)) return true;
  return page.getByText(/access last mfa code/i).first().isVisible({ timeout: 500 }).catch(() => false);
}

async function waitForGetMyMfaDashboard(page) {
  const deadline = Date.now() + CONFIG.appfolioLoginTimeoutMs;
  while (Date.now() < deadline) {
    if (await isGetMyMfaDashboardVisible(page)) return;
    await page.waitForTimeout(500);
  }
  fail("GetMyMFA dashboard login did not complete before timeout.");
}

async function clickAccessLastMfaCode(page) {
  await waitForGetMyMfaPhoneNumber(page);
  const attempts = [
    () => clickAccessTileByLocator(page),
    () => clickAccessTileByCoordinates(page),
    () => clickAccessTileByDom(page),
  ];

  for (const attempt of attempts) {
    await attempt().catch(() => false);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForTimeout(1200);
    if (await isGetMyMfaCodePageVisible(page)) return;
  }

  fail("Clicked Access last MFA code but GetMyMFA code page did not open.");
}

async function clickAccessTileByLocator(page) {
  const accessTile = await visibleFirst(
    page.getByText(/access last mfa code/i).or(page.locator("button, a, [role='button'], input[type='button'], input[type='submit'], div, span").filter({ hasText: /access last mfa code/i })),
    "Access last MFA code action",
    5000,
  );
  await accessTile.click({ force: true });
}

async function clickAccessTileByCoordinates(page) {
  const box = await page.getByText(/access last mfa code/i).first().boundingBox();
  if (!box) return false;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width / 2, Math.max(0, box.y - 36));
  return true;
}

async function clickAccessTileByDom(page) {
  return page.evaluate((phoneNumber) => {
    const normalize = (value) => String(value || "").replace(/\D/g, "");
    const target = normalize(phoneNumber);
    const elements = Array.from(document.querySelectorAll("body *"));
    const phoneElement = elements.find((element) => normalize(element.textContent).includes(target));
    const accessTextElement = elements.find((element) => /^access last mfa code$/i.test((element.textContent || "").trim()));
    const clickElement = (element) => {
      if (!element) return false;
      const clickable = element.closest("button, a, [role='button'], input[type='button'], input[type='submit'], [onclick]") || element;
      clickable.scrollIntoView({ block: "center", inline: "center" });
      clickable.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
      clickable.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      clickable.click();
      return true;
    };

    if (phoneElement && accessTextElement) {
      const phoneTop = phoneElement.getBoundingClientRect().top;
      const accessTop = accessTextElement.getBoundingClientRect().top;
      if (Math.abs(accessTop - phoneTop) < 300 && clickElement(accessTextElement)) return true;
    }

    let container = phoneElement || accessTextElement;
    for (let depth = 0; depth < 12 && container; depth += 1) {
      const controls = Array.from(container.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit'], [onclick], div, span"));
      const accessControl = controls.find((control) => /access last mfa code/i.test(control.innerText || control.textContent || control.value || ""));
      if (clickElement(accessControl)) return true;
      if (/access last mfa code/i.test(container.innerText || container.textContent || "") && clickElement(container)) return true;
      container = container.parentElement;
    }

    return clickElement(accessTextElement);
  }, CONFIG.getMyMfaPhoneNumber);
}

async function waitForGetMyMfaPhoneNumber(page) {
  const target = normalizeDigits(CONFIG.getMyMfaPhoneNumber);
  const deadline = Date.now() + CONFIG.appfolioActionTimeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((digits) => document.body?.innerText?.replace(/\D/g, "").includes(digits), target).catch(() => false);
    if (found) return;
    await page.waitForTimeout(500);
  }
  fail(`GetMyMFA phone number was not visible on dashboard: ${CONFIG.getMyMfaPhoneNumber}`);
}

async function isGetMyMfaCodePageVisible(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  return /last mfa code for/i.test(bodyText) || Boolean(extractSixDigitMfaCode(bodyText));
}

async function readDashboardMfaCode(page) {
  const deadline = Date.now() + CONFIG.appfolioActionTimeoutMs;
  while (Date.now() < deadline) {
    const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    const code = extractSixDigitMfaCode(bodyText);
    if (code) return code;
    await page.waitForTimeout(500);
  }
  fail("Could not find a 6-digit MFA code on GetMyMFA dashboard.");
}

function extractSixDigitMfaCode(text) {
  const value = String(text || "");
  const contiguousCandidates = value.match(/\b\d{6}\b/g) || [];
  if (contiguousCandidates.length) return contiguousCandidates[contiguousCandidates.length - 1];

  const spacedCandidates = value.match(/(?:\b\d\s+){5}\d\b/g) || [];
  if (spacedCandidates.length) return normalizeDigits(spacedCandidates[spacedCandidates.length - 1]);

  return "";
}

async function clickGetMyMfaSubmit(page) {
  const button = await visibleFirst(
    page.locator("button, a, [role='button'], input[type='submit']").filter({ hasText: /log in|login|sign in|continue|submit/i }).or(page.locator("input[type='submit']")),
    "GetMyMFA login button",
    CONFIG.appfolioActionTimeoutMs,
  );
  await button.click({ force: true });
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1000);
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

async function saveLoginHangScreenshot(page, label) {
  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  const screenshotPath = path.resolve(process.cwd(), `appfolio-login-${safeLabel}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  log("LOGIN_SCREENSHOT", screenshotPath);
}

async function isSignedIn(page) {
  if (await hasSearchBox(page, 1000)) return true;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /Dashboard|Property Manager|Tasks/i.test(bodyText) && /Search AppFolio/i.test(bodyText);
}

async function searchTenant(page, tenantName) {
  log("Searching tenant", tenantName);
  const searchBox = await findSearchBox(page, CONFIG.appfolioActionTimeoutMs, "tenant search");

  log("SEARCH_STEP", "Filling global search box");
  await fillGlobalSearch(page, searchBox, tenantName);
  await waitForTenantSearchResponse(page, tenantName);

  if (await isTenantPage(page, tenantName)) {
    log("Tenant page opened from search", `${tenantName} at ${page.url()}`);
    return;
  }

  log("Opening tenant page", tenantName);
  await openTenantSearchResult(page, tenantName);
  if (await isTenantPage(page, tenantName)) {
    log("Tenant page opened", `${tenantName} at ${page.url()}`);
    return;
  }

  const bodyPreview = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
  await failWithDiagnostics(page, `Clicked search result but did not reach tenant page for "${tenantName}". URL: ${page.url()}. Page starts with: ${bodyPreview}`, "tenant-page-not-opened");
}

async function ensurePostLoginReady(page, data) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await isTenantPage(page, data.tenantName)) {
      logState("POST_LOGIN_READY", `Already on tenant page at ${page.url()}`);
      return;
    }

    const searchBox = await findSearchBox(page, 1000, "post-login ready", { diagnose: false }).catch(() => null);
    if (searchBox) {
      logState("POST_LOGIN_READY", `Authenticated AppFolio search UI ready at ${page.url()}`);
      return;
    }

    const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (/Dashboard|Property Manager|Tasks|Add Functionality|Help & Training/i.test(bodyText)
      && !/Sign In|Log In|Verification Code|Send Verification Code/i.test(bodyText)) {
      logState("POST_LOGIN_READY", `Authenticated AppFolio page ready at ${page.url()}`);
      return;
    }

    await page.waitForTimeout(500);
  }

  await failWithDiagnostics(page, `Tenant search did not begin within 30 seconds after login. Current URL: ${page.url()}`, "post-login-tenant-search-not-started");
}

async function fillGlobalSearch(page, searchBox, tenantName) {
  let currentValue = "";
  try {
    await searchBox.click({ force: true });
    await replaceInputValue(searchBox, tenantName);
    await page.waitForTimeout(750);
    currentValue = await searchBox.inputValue().catch(() => "");
  } catch (error) {
    log("SEARCH_STEP", `Primary global search fill failed: ${error.message}`);
  }

  if (currentValue.trim() === tenantName.trim()) {
    log("SEARCH_STEP", "Global search value confirmed");
    return;
  }

  log("SEARCH_STEP", `Global search value was "${currentValue}". Retrying through active keyboard input`);
  try {
    const retrySearchBox = await findSearchBox(page, 3000, "tenant search retry", { diagnose: false }).catch(() => searchBox);
    await retrySearchBox.click({ force: true });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.type(tenantName, { delay: 35 });
    await page.waitForTimeout(750);
    currentValue = await retrySearchBox.inputValue().catch(() => "");
    searchBox = retrySearchBox;
  } catch (error) {
    log("SEARCH_STEP", `Keyboard global search retry failed: ${error.message}`);
  }

  if (currentValue.trim() === tenantName.trim()) {
    log("SEARCH_STEP", "Global search value confirmed after keyboard retry");
    return;
  }

  const domResult = await setGlobalSearchByDom(page, tenantName);
  await page.waitForTimeout(750);

  currentValue = domResult.value || await readGlobalSearchValueByDom(page);
  if (!domResult.ok || currentValue.trim() !== tenantName.trim()) {
    await failWithDiagnostics(page, `Could not enter tenant name into AppFolio global search. Attempted value "${tenantName}", current value "${currentValue}".`, "global-search-fill-failed");
  }

  log("SEARCH_STEP", "Global search value confirmed after DOM event retry");
}

async function setGlobalSearchByDom(page, tenantName) {
  return page.evaluate((value) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    const selectors = [
      "#global-search-input",
      "input[type='search']",
      "input[placeholder*='Search' i]",
      "input[aria-label*='Search' i]",
      "input[name*='search' i]",
    ];
    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const input = candidates.find((element) => isVisible(element) && /search|appfolio/i.test([
        element.id,
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        element.getAttribute("name"),
        element.className,
      ].join(" ")));
    if (!input) return { ok: false, value: "" };

    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value.slice(-1) || " " }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) || " " }));
    return { ok: input.value === value, value: input.value };
  }, tenantName).catch(() => ({ ok: false, value: "" }));
}

async function readGlobalSearchValueByDom(page) {
  return page.evaluate(() => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    const input = Array.from(document.querySelectorAll("#global-search-input, input[type='search'], input[placeholder*='Search' i], input[aria-label*='Search' i]"))
      .find((element) => isVisible(element));
    return input?.value || "";
  }).catch(() => "");
}

async function waitForTenantSearchResponse(page, tenantName) {
  const deadline = Date.now() + CONFIG.appfolioActionTimeoutMs;
  while (Date.now() < deadline) {
    if (await isTenantPage(page, tenantName)) return;
    const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (tenantNameMatches(bodyText, tenantName)) {
      log("SEARCH_STEP", "Search results contain tenant name");
      return;
    }
    if (/No results|No matches|No records/i.test(bodyText)) {
      await failWithDiagnostics(page, `AppFolio search returned no results for "${tenantName}"`, "tenant-search-no-results");
    }
    await page.waitForTimeout(500);
  }
  await failWithDiagnostics(page, `Timed out waiting for AppFolio search results for "${tenantName}"`, "tenant-search-timeout");
}

async function openTenantSearchResult(page, tenantName) {
  const tenantRegexes = tenantNameRegexes(tenantName);
  await page.waitForFunction((name) => {
    const text = document.body.innerText.toLowerCase();
    const normalized = String(name || "").toLowerCase();
    if (text.includes(normalized)) return true;
    if (normalized.includes(",")) {
      const [last, rest] = normalized.split(",", 2).map((part) => part.trim()).filter(Boolean);
      return Boolean(last && rest && text.includes(`${rest} ${last}`));
    }
    return false;
  }, tenantName, { timeout: 10000 })
    .catch(() => {});

  const locators = tenantRegexes.flatMap((tenantRegex) => [
    page.getByRole("link", { name: tenantRegex }),
    page.locator("a").filter({ hasText: tenantRegex }),
    page.locator("tr, li, .search-result, .search-results, .list-group-item, .row, [class*='result']")
      .filter({ hasText: tenantRegex })
      .locator("a")
      .first(),
  ]);

  for (const locator of locators) {
    const result = await visibleFirst(locator, `tenant search result for ${tenantName}`, 3000).catch(() => null);
    if (!result) continue;
    await result.scrollIntoViewIfNeeded().catch(() => {});
    const previousUrl = page.url();
    log("SEARCH_STEP", `Clicking tenant search result from ${previousUrl}`);
    await result.click({ force: true });
    await waitForTenantPageAfterClick(page, tenantName, previousUrl);
    return;
  }

  const href = await findTenantResultHref(page, tenantName);
  if (href) {
    log("Opening tenant result href", href);
    await page.goto(href, { waitUntil: "domcontentloaded" });
    await waitForTenantPageAfterClick(page, tenantName, "");
    return;
  }

  const bodyPreview = (await page.locator("body").innerText().catch(() => "")).slice(0, 500);
  await failWithDiagnostics(page, `Could not find clickable tenant search result for "${tenantName}". URL: ${page.url()}. Page starts with: ${bodyPreview}`, "tenant-result-not-found");
}

async function waitForTenantPageAfterClick(page, tenantName, previousUrl) {
  const deadline = Date.now() + CONFIG.appfolioActionTimeoutMs;
  while (Date.now() < deadline) {
    if (await isTenantPage(page, tenantName)) return;
    if (previousUrl && page.url() !== previousUrl) {
      log("SEARCH_STEP", `Tenant result navigation URL changed to ${page.url()}`);
    }
    await page.waitForTimeout(500);
  }
  await failWithDiagnostics(page, `Timed out after clicking tenant search result for "${tenantName}"`, "tenant-click-timeout");
}

async function findTenantResultHref(page, tenantName) {
  const href = await page.evaluate((names) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    }

    const targets = names.map(normalize).filter(Boolean);
    const anchors = Array.from(document.querySelectorAll("a[href]"))
      .filter((anchor) => {
        if (!isVisible(anchor)) return false;
        const text = normalize(anchor.textContent);
        return targets.some((target) => text.includes(target));
      })
      .map((anchor) => ({
        href: anchor.href,
        text: normalize(anchor.textContent),
      }))
      .filter(({ href }) => href && !href.endsWith("#") && !href.startsWith("javascript:"));

    const preferred = anchors.find(({ href }) => /tenant|occupanc|people|lease/i.test(href));
    return (preferred || anchors[0])?.href || "";
  }, tenantNameCandidates(tenantName));

  return href || "";
}

async function isTenantPage(page, tenantName) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const hasTenantName = tenantNameMatches(bodyText, tenantName);
  const hasTenantPageSignals = /Eligible for Renewal|Primary Tenant|Tenant Status|Recurring Charges|Portal Active|Move Out|Delinquency Notes/i.test(bodyText);
  const urlLooksTenantish = /tenant|occupanc|lease/i.test(page.url());
  const isSearchResultsOverlay = /Results\s+Advanced Search|FEEDBACK\s+People/i.test(bodyText) && !urlLooksTenantish;
  return hasTenantName && !isSearchResultsOverlay && (hasTenantPageSignals || urlLooksTenantish);
}

function tenantNameCandidates(tenantName) {
  const raw = String(tenantName || "").replace(/\s+/g, " ").trim();
  const candidates = [raw];
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",", 2).map((part) => part.trim()).filter(Boolean);
    if (last && rest) candidates.push(`${rest} ${last}`);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function tenantNameRegexes(tenantName) {
  return tenantNameCandidates(tenantName).map((candidate) => new RegExp(escapeRegex(candidate), "i"));
}

function tenantNameMatches(text, tenantName) {
  const value = String(text || "");
  if (tenantNameRegexes(tenantName).some((regex) => regex.test(value))) return true;
  const tokens = String(tenantName || "")
    .replace(/[,.'"]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  return tokens.length >= 2 && tokens.every((token) => new RegExp(`\\b${escapeRegex(token)}\\b`, "i").test(value));
}

async function hasSearchBox(page, timeout = 1000) {
  return Boolean(await findSearchBox(page, timeout, "auth check", { diagnose: false }).catch(() => null));
}

async function findSearchBox(page, timeout = 2000, context = "global search", options = {}) {
  const diagnose = options.diagnose !== false;
  const deadline = Date.now() + timeout;
  const searchLocators = [
    page.getByRole("searchbox"),
    page.getByPlaceholder(/search appfolio|search/i),
    page.getByLabel(/search appfolio|search/i),
    page.locator("input[type='search']"),
    page.locator("input[placeholder*='Search' i]"),
    page.locator("input[aria-label*='Search' i]"),
    page.locator("input[name*='search' i]"),
    page.locator("[contenteditable='true'][role='searchbox']"),
    page.locator("[contenteditable='true'][aria-label*='Search' i]"),
  ];

  while (Date.now() < deadline) {
    for (const locator of searchLocators) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index += 1) {
        const candidate = locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          log("SEARCH_BOX_FOUND", `${context} via locator ${searchLocators.indexOf(locator)}.${index}`);
          return candidate;
        }
      }
    }

    const domIndex = await page.evaluate(() => {
      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }

      const candidates = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true'], [role='searchbox']"));
      return candidates.findIndex((element) => {
        const haystack = [
          element.getAttribute("placeholder"),
          element.getAttribute("aria-label"),
          element.getAttribute("name"),
          element.getAttribute("id"),
          element.className,
          element.getAttribute("role"),
        ].join(" ").toLowerCase();
        return isVisible(element) && /search|appfolio/.test(haystack);
      });
    }).catch(() => -1);
    if (domIndex >= 0) {
      log("SEARCH_BOX_FOUND", `${context} via DOM index ${domIndex}`);
      return page.locator("input, textarea, [contenteditable='true'], [role='searchbox']").nth(domIndex);
    }

    await page.waitForTimeout(500);
  }

  if (diagnose) {
    await failWithDiagnostics(page, `Could not find AppFolio global search box during ${context}`, "global-search-not-found");
  }
  fail(`Could not find AppFolio global search box during ${context}`);
}

async function prepareRenewalOffer(page, data) {
  log("Starting renewal offer task");
  const taskPage = await clickRenewalTask(page);
  page = taskPage;
  const workflowPage = await findPageWithText(
    page.context(),
    /Renewal Notice Letter|Add Renewal Option|Send Renewal Notice Letter|Renewal Preview|Cancel All|Send All to Tenant|Select which option to review/i,
    CONFIG.appfolioActionTimeoutMs
  );
  if (!workflowPage) {
    const bodyPreview = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    await failWithDiagnostics(page, `Could not find renewal workflow page after opening ${page.url()}. Page starts with: ${bodyPreview.slice(0, 250)}`, "renewal-workflow-not-found");
  }
  page = workflowPage;
  await page.bringToFront();

  await skipIfRenewalAlreadySent(page);

  if (await isLeasePreviewPage(page)) {
    await configureLeasePreview(page, data);
    return;
  }

  if (await page.getByText(/Send Renewal Notice Letter/i).first().isVisible().catch(() => false)) {
    const leasePreviewPage = await configureRenewalNoticeLetter(page, data);
    await configureLeasePreview(leasePreviewPage, data);
    return;
  }

  log("Checking Renewal Notice Letter");
  await checkByLabel(page, ["Renewal Notice Letter"]);

  log("Entering notice dates", `Start ${data.leaseFrom}; deadline ${data.deadlineToRespond}`);
  await fillByLabel(page, ["Start Date", "Lease Start Date"], data.leaseFrom);
  await fillByLabel(page, ["Deadline to Respond Date", "Deadline to Respond", "Response Deadline"], data.deadlineToRespond);
  await checkByLabel(page, ["Month To Month"]);

  log("Configuring renewal option", "2020 Master Renewal Lease");
  await selectCustomDropdownByPlaceholder(page, "Select Lease Template", "2020 Master Renewal Lease");

  log("Clearing pre-existing renewal addenda");
  const renewalAddendaControl = await findCustomDropdownControlByLabel(page, "Select Addenda Template");
  await clearCustomDropdown(page, renewalAddendaControl);

  for (const addendum of data.addendums) {
    log("Selecting addendum", addendum);
    await selectAddendum(page, addendum);
  }
  await closeOpenSelectDropdowns(page, "renewal addenda");

  log("Entering county", "Duval");
  if (await fillByLabelIfPresent(page, ["County"], "Duval")) {
    log("COUNTY_FIELD_FILLED", "Duval");
  } else {
    log("COUNTY_FIELD_NOT_PRESENT", "County field was not visible on this renewal page; continuing");
  }

  log("Entering lease break fee", data.earlyTerminationRate);
  await fillByLabel(page, ["Lease Break Fee Amount", "2x Rent", "Lease Break Fee"], data.earlyTerminationRate);

  log("Entering lease end date", data.leaseTo);
  await fillByLabel(page, ["Lease End Date", "End Date"], data.leaseTo);

  log("Entering renewal option new rent", data.renewalRate);
  await fillRenewalOptionNewRent(page, data.renewalRate);

  await configureMonthToMonthOption(page, data);
  await configureAdditionalSettings(page);

  log("Scrolling to bottom");
  await scrollToBottom(page);

  log("Opening review screen");
  await clickReviewRenewalOffer(page);
  await continuePromptIfPresent(page);
  const noticePage = await waitForRenewalNoticeLetterScreen(page);

  const leasePreviewPage = await configureRenewalNoticeLetter(noticePage, data);
  await configureLeasePreview(leasePreviewPage, data);
  log("Lease preview selections completed", "No send action was performed");
}

async function skipIfRenewalAlreadySent(page) {
  const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  const statusMatch = bodyText.match(/Renewal Status:\s*([^\n]+)/i);
  if (!statusMatch) return;

  const status = statusMatch[1].trim();
  if (/^(sent|completed|complete|submitted)/i.test(status)) {
    throw new SkipError(`AppFolio renewal is already ${status}`);
  }
}

async function clickRenewalTask(page) {
  const taskHref = await page.evaluate(() => {
    const taskNames = [
      "Prepare Renewal Offer",
      "Prepare Renewal Letter",
      "Review Renewal Offer",
      "Send Renewal Offer",
    ];

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    const links = Array.from(document.querySelectorAll("a"));
    for (const name of taskNames) {
      const link = links.find((candidate) =>
        isVisible(candidate)
        && (candidate.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === name.toLowerCase()
      );
      if (link?.href) return link.href;
    }

    return "";
  });

  if (taskHref) {
    log("Opening renewal task URL", taskHref);
    await page.goto(taskHref, { waitUntil: "domcontentloaded" });
    return page;
  }

  const taskNames = [
    /^Prepare Renewal Offer$/i,
    /^Prepare Renewal Letter$/i,
    /^Review Renewal Offer$/i,
    /^Send Renewal Offer$/i,
  ];

  for (const taskName of taskNames) {
    const candidates = [
      page.getByRole("link", { name: taskName }),
      page.getByRole("button", { name: taskName }),
      page.locator("a").filter({ hasText: taskName }),
    ];

    for (const locator of candidates) {
      const task = await visibleFirst(locator, `renewal task ${taskName}`, 1000).catch(() => null);
      if (!task) continue;

      const popupPromise = page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null);
      const previousUrl = page.url();
      log("TASK_STEP", `Clicking renewal task ${taskName}`);
      await task.click({ force: true });
      const popup = await popupPromise;
      if (popup) {
        await popup.bringToFront();
        return popup;
      }
      await waitForPageText(page, /Renewal Notice Letter|Add Renewal Option|Send Renewal Notice Letter|Renewal Preview|Select which option to review/i, CONFIG.appfolioActionTimeoutMs, `renewal task page after ${previousUrl}`);
      return page;
    }
  }

  await failWithDiagnostics(page, "Could not find a Prepare/Review/Send Renewal Offer task link", "renewal-task-not-found");
}

async function waitForRenewalNoticeLetterScreen(page) {
  const existingPage = await findPageWithText(page.context(), /Send Renewal Notice Letter/i, 20000);
  if (existingPage) {
    await existingPage.bringToFront();
    return existingPage;
  }

  await failWithDiagnostics(page, "Could not find Send Renewal Notice Letter screen", "renewal-notice-screen-not-found");
}

async function configureRenewalNoticeLetter(page, data) {
  log("Selecting renewal notice letter", data.renewalLetterOption);
  await selectCustomDropdownInSection(page, "Send Renewal Notice Letter", "Select Letter", data.renewalLetterOption)
    .catch(async () => {
      await selectCustomDropdownByPlaceholder(page, "Select Letter Template", data.renewalLetterOption);
    });
  await clickReviewRenewalOffer(page);
  const previewPage = await findPageWithText(page.context(), /renewal preview|send all to tenant|cancel all/i, 30000);
  if (!previewPage) await failWithDiagnostics(page, "Could not find renewal preview page", "renewal-preview-not-found");
  await previewPage.bringToFront();
  return previewPage;
}

async function findPageWithText(context, pattern, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      const bodyText = await candidate.locator("body").innerText({ timeout: 1000 }).catch(() => "");
      if (pattern.test(bodyText)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function waitForPageText(page, pattern, timeout, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    if (pattern.test(bodyText)) return true;
    await page.waitForTimeout(500);
  }
  await failWithDiagnostics(page, `Timed out waiting for ${description}`, "page-text-timeout");
}

async function configureLeasePreview(page, data) {
  await skipIfRenewalAlreadySent(page);
  log("Configuring lease preview checkboxes");
  await configureLeadPaintDisclosure(page);
  await configureElectronicNotices(page);
  await configureLawnMaintenance(page, data.lawn);
  await configurePestControl(page);
  log("Lease preview selections complete", "leaving page without clicking Cancel All");
}

async function isLeasePreviewPage(page) {
  const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
  return /Renewal Preview|Cancel All|Send All to Tenant|Select which option to review/i.test(text);
}

async function configureLeadPaintDisclosure(page) {
  log("Configuring lead-based paint disclosure");
  await jumpToPreviewSection(page, /DISCLOSURE OF INFORMATION ON LEAD/i);
  await clickCheckboxNearText(page, "Lessor has no knowledge of lead-based paint", "lead-based paint disclosure");
  await clickCheckboxNearText(page, "Lessor has no reports or records pertaining to lead-based paint", "lead-based paint disclosure");
  await clickCheckboxNearText(page, "Agent has informed the lessor", "lead-based paint disclosure");
}

async function configureElectronicNotices(page) {
  log("Configuring Electronic Notices Addendum");
  await jumpToPreviewSection(page, /Electronic Notices Addendum/i);
  await setElectronicNoticesSelections(page);
}

async function configureLawnMaintenance(page, lawnOption) {
  log("Configuring Lawn Maintenance Addendum", lawnOption);
  await jumpToPreviewSection(page, /LAWN MAINTENANCE ADDENDUM/i);
  await setVisibleOptionGroup(page, ["Tenant", "Landlord", "Association"], lawnOption, "Lawn Maintenance Addendum");
}

async function configurePestControl(page) {
  log("Configuring Pest Control Addendum", "Tenant");
  await jumpToPreviewSection(page, /PEST CONTROL ADDENDUM/i);
  await setVisibleOptionGroup(page, ["Tenant", "Landlord", "Association"], "Tenant", "Pest Control Addendum");
}

async function cancelLeasePreview(page) {
  log("Closing lease preview", "Cancel All");
  const cancel = page.getByRole("link", { name: /^Cancel All$/i })
    .or(page.getByRole("button", { name: /^Cancel All$/i }));
  const button = await visibleFirst(cancel, "Cancel All", 10000);
  await button.click();
  await page.waitForTimeout(1000);
}

async function jumpToPreviewSection(page, sectionName) {
  const link = page.getByRole("link", { name: sectionName });
  const linkCandidate = await visibleFirst(link, `preview section ${sectionName}`, 10000);
  await linkCandidate.click();
  await page.waitForTimeout(1000);
}

async function clickVisibleCheckboxesByIndex(page, indexes, description) {
  const checkboxIndexes = await page.evaluate(() => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.left >= 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    return Array.from(document.querySelectorAll("input[type='checkbox'], .js-lease-template-checkbox"))
      .map((checkbox, index) => ({ checkbox, index, rect: checkbox.getBoundingClientRect() }))
      .filter(({ checkbox }) => isVisible(checkbox))
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left))
      .map(({ index }) => index);
  });

  for (const index of indexes) {
    const actualIndex = checkboxIndexes[index];
    if (actualIndex == null) fail(`Could not find checkbox ${index + 1} in ${description}`);
    const checkbox = page.locator("input[type='checkbox'], .js-lease-template-checkbox").nth(actualIndex);
    await ensureCheckboxSelected(checkbox);
  }
}

async function clickVisibleAppfolioCheckboxesByIndex(page, indexes, description) {
  const checkboxIndexes = await page.evaluate(() => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.top > 150
        && rect.top < window.innerHeight - 20
        && rect.left > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    return Array.from(document.querySelectorAll(".js-lease-template-checkbox"))
      .map((checkbox, index) => ({ checkbox, index, rect: checkbox.getBoundingClientRect() }))
      .filter(({ checkbox }) => isVisible(checkbox))
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left))
      .map(({ index }) => index);
  });

  for (const index of indexes) {
    const actualIndex = checkboxIndexes[index];
    if (actualIndex == null) fail(`Could not find visible checkbox ${index + 1} in ${description}`);
    await setCheckboxSelected(page.locator(".js-lease-template-checkbox").nth(actualIndex), true);
  }
}

async function clickFirstCheckboxAfterHeading(page, headingText, description) {
  const checkboxIndex = await page.evaluate(({ headingText }) => {
    function normalize(value) {
      return String(value || "")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    const target = normalize(headingText);
    const elements = Array.from(document.querySelectorAll("body *"));
    const heading = elements
      .map((element) => ({
        element,
        text: normalize(element.textContent),
        rect: element.getBoundingClientRect(),
      }))
      .filter(({ element, text, rect }) =>
        isVisible(element)
        && text === target
        && rect.height < 80
      )
      .sort((a, b) => ((a.rect.top + window.scrollY) - (b.rect.top + window.scrollY)) || (a.rect.left - b.rect.left))[0];

    if (!heading) return -1;

    const headingTop = heading.rect.top + window.scrollY;
    const checkboxes = Array.from(document.querySelectorAll(".js-lease-template-checkbox"))
      .map((checkbox, index) => ({ checkbox, index, rect: checkbox.getBoundingClientRect() }))
      .filter(({ checkbox, rect }) =>
        isVisible(checkbox)
        && rect.top + window.scrollY > headingTop
      )
      .sort((a, b) => ((a.rect.top + window.scrollY) - (b.rect.top + window.scrollY)) || (a.rect.left - b.rect.left));

    return checkboxes[0]?.index ?? -1;
  }, { headingText });

  if (checkboxIndex < 0) fail(`Could not find first checkbox after ${headingText} in ${description}`);
  await setCheckboxSelected(page.locator(".js-lease-template-checkbox").nth(checkboxIndex), true);
}

async function setElectronicNoticesSelections(page) {
  const selectionIndexes = await page.evaluate(() => {
    function normalize(value) {
      return String(value || "")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    }

    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    function findHeadingTop(text) {
      const target = normalize(text);
      const matches = Array.from(document.querySelectorAll("body *"))
        .map((element) => ({
          element,
          text: normalize(element.textContent),
          rect: element.getBoundingClientRect(),
        }))
        .filter(({ element, text, rect }) =>
          isVisible(element)
          && text === target
          && rect.height < 90
        )
        .sort((a, b) =>
          (a.text.length - b.text.length)
          || ((a.rect.top + window.scrollY) - (b.rect.top + window.scrollY))
          || (a.rect.left - b.rect.left)
        );
      return matches[0] ? matches[0].rect.top + window.scrollY : null;
    }

    const tenantTop = findHeadingTop("TENANT ELECTION");
    const landlordTop = findHeadingTop("LANDLORD/LANDLORD'S AGENT ELECTION");
    if (tenantTop == null || landlordTop == null) {
      return { error: "Could not locate both Electronic Notices election headings" };
    }

    const allBoxes = Array.from(document.querySelectorAll(".js-lease-template-checkbox"));
    const boxes = Array.from(document.querySelectorAll(".js-checkbox-container"))
      .map((container) => {
        const checkbox = container.querySelector(".js-lease-template-checkbox");
        const rect = container.getBoundingClientRect();
        return {
          index: checkbox ? allBoxes.indexOf(checkbox) : -1,
          text: normalize(container.textContent),
          top: rect.top + window.scrollY,
          left: rect.left,
          hasBox: Boolean(checkbox),
        };
      })
      .filter(({ index, hasBox }) => hasBox && index >= 0)
      .sort((a, b) => (a.top - b.top) || (a.left - b.left));

    const tenantBoxes = boxes.filter((box) => box.top > tenantTop && box.top < landlordTop);
    const landlordBoxes = boxes.filter((box) => box.top > landlordTop);
    if (tenantBoxes.length < 2) return { error: "Could not locate both Tenant Election checkboxes" };
    if (landlordBoxes.length < 1) return { error: "Could not locate Landlord Election checkbox" };

    return {
      selected: [tenantBoxes[0].index, landlordBoxes[0].index],
      unselected: tenantBoxes.slice(1).map((box) => box.index),
    };
  });

  if (selectionIndexes.error) fail(selectionIndexes.error);

  for (const index of selectionIndexes.selected) {
    await setCheckboxSelected(page.locator(".js-lease-template-checkbox").nth(index), true);
  }
  for (const index of selectionIndexes.unselected) {
    await setCheckboxSelected(page.locator(".js-lease-template-checkbox").nth(index), false);
  }
}

async function setVisibleOptionGroup(page, options, selectedOption, description) {
  const optionIndexes = await page.evaluate(({ options }) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.top > 150
        && rect.top < window.innerHeight - 20
        && rect.left > 0
        && rect.left < window.innerWidth
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    const wanted = options.map((option) => option.toLowerCase());
    return Array.from(document.querySelectorAll(".js-checkbox-container"))
      .map((container, index) => ({
        index,
        text: (container.textContent || "").replace(/\s+/g, " ").trim(),
        hasBox: Boolean(container.querySelector(".js-lease-template-checkbox")),
      }))
      .filter(({ text, hasBox }, index) => {
        const container = document.querySelectorAll(".js-checkbox-container")[index];
        return hasBox && isVisible(container) && wanted.includes(text.toLowerCase());
      });
  }, { options });

  const foundOptions = new Set(optionIndexes.map(({ text }) => text.toLowerCase()));
  for (const option of options) {
    if (!foundOptions.has(option.toLowerCase())) {
      fail(`Could not find ${option} checkbox in ${description}`);
    }
  }

  for (const { index, text } of optionIndexes) {
    const checkbox = page.locator(".js-checkbox-container").nth(index).locator(".js-lease-template-checkbox").first();
    await setCheckboxSelected(checkbox, text.toLowerCase() === selectedOption.toLowerCase());
  }
}

async function clickCheckboxNearText(page, text, description) {
  const appfolioCheckbox = page
    .locator(".js-checkbox-container")
    .filter({ hasText: new RegExp(escapeRegex(text), "i") })
    .locator(".js-lease-template-checkbox")
    .first();
  const appfolioCandidate = await visibleFirst(appfolioCheckbox, `${text} checkbox`, 2000).catch(() => null);
  if (appfolioCandidate) {
    await setCheckboxSelected(appfolioCandidate, true);
    return;
  }

  await page.getByText(new RegExp(escapeRegex(text), "i")).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  const checkboxIndex = await page.evaluate(({ text }) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.top > 190
        && rect.top < window.innerHeight - 20
        && rect.left > 120
        && rect.left < window.innerWidth - 250
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    const target = text.toLowerCase();
    const labels = Array.from(document.querySelectorAll("body *"))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: (element.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter(({ element, text: elementText }) => isVisible(element) && elementText.toLowerCase().includes(target))
      .sort((a, b) => (a.text.length - b.text.length) || (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));

    const label = labels[0];
    if (!label) return -1;

    const checkboxes = Array.from(document.querySelectorAll("input[type='checkbox'], .js-lease-template-checkbox"))
      .map((checkbox, index) => ({ checkbox, index, rect: checkbox.getBoundingClientRect() }))
      .filter(({ checkbox }) => isVisible(checkbox))
      .map((item) => ({
        ...item,
        distance: Math.abs((item.rect.top + item.rect.height / 2) - (label.rect.top + label.rect.height / 2))
          + Math.max(0, label.rect.left - item.rect.left) / 10,
      }))
      .sort((a, b) => a.distance - b.distance);

    return checkboxes[0]?.index ?? -1;
  }, { text });

  if (checkboxIndex < 0) fail(`Could not find ${text} checkbox in ${description}`);
  await setCheckboxSelected(page.locator("input[type='checkbox'], .js-lease-template-checkbox").nth(checkboxIndex), true);
}

async function ensureCheckboxSelected(locator) {
  await setCheckboxSelected(locator, true);
}

async function setCheckboxSelected(locator, desired) {
  await locator.scrollIntoViewIfNeeded();
  const checked = await locator.evaluate((element) => {
    if (element.matches("input[type='checkbox']")) return element.checked;
    const classText = String(element.className || "");
    const ariaChecked = element.getAttribute("aria-checked");
    return ariaChecked === "true" || /\b(is-)?(checked|selected|active)\b/i.test(classText);
  }).catch(() => false);
  if (checked !== desired) {
    await locator.click({ force: true }).catch(async () => {
      await locator.evaluate((element) => element.click());
    });
  }
}

async function continuePromptIfPresent(page) {
  log("Checking for confirmation prompt");
  const continueButton = page.getByRole("button", { name: /^Continue$/i });
  const button = await visibleFirst(continueButton, "Continue prompt button", 5000)
    .catch(() => null);
  if (!button) {
    log("No confirmation prompt found");
    return;
  }

  log("Continuing through confirmation prompt");
  await button.click();
}

async function configureMonthToMonthOption(page, data) {
  log("Configuring Month To Month option");
  await scrollElementIntoView(page.getByText(/^Add Month To Month Option$/i), "Add Month To Month Option section");
  const addendaControl = await findVisibleMonthToMonthAddendaControl(page);
  await clearCustomDropdown(page, addendaControl);
  await selectCustomDropdownControl(page, addendaControl, "Add Month To Month Option Include Addenda", "Month to Month Unavailable");
  log("Entering Month To Month new rent", data.monthToMonthRent);
  await fillInputUnderHeader(page, "Add Month To Month Option", "Additional Fee", "New Rent", data.monthToMonthRent, "Month To Month new rent");
}

async function configureAdditionalSettings(page) {
  log("Configuring Additional Settings", "Renew by Default / Option 2");
  await scrollElementIntoView(page.getByText(/^Additional Settings$/i), "Additional Settings section");
  await checkByLabel(page, ["Renew by Default"]);
  await selectCustomDropdownInSection(page, "Additional Settings", "Default Option", "Option 2");
}

async function clickReviewRenewalOffer(page) {
  const exactButton = page.getByRole("button", { name: /^(Review Renewal Offer|Prepare Renewal Letter)$/i });
  const button = await visibleFirst(exactButton, "Review Renewal Offer button", 5000)
    .catch(() => null);
  if (button) {
    await button.click();
    return;
  }

  const inputButton = page.locator("input[type='submit'], input[type='button']")
    .filter({ hasText: /^(Review Renewal Offer|Prepare Renewal Letter)$/i });
  const input = await visibleFirst(inputButton, "Review Renewal Offer input button", 2000)
    .catch(() => null);
  if (input) {
    await input.click();
    return;
  }

  const formButton = page.locator("button, input[type='submit'], input[type='button'], a.btn")
    .filter({ hasText: /^(Review Renewal Offer|Prepare Renewal Letter)$/i })
    .first();
  const fallback = await visibleFirst(formButton, "Review Renewal Offer button", 2000)
    .catch(() => null);
  if (fallback) {
    await fallback.click();
    return;
  }

  fail("Could not find the exact Review Renewal Offer / Prepare Renewal Letter button at the bottom of the form");
}

async function scrollToBottom(page) {
  await page.keyboard.press("Tab").catch(() => {});
  await page.keyboard.press("End").catch(() => {});
  await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    for (const element of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(element);
      const canScroll = /(auto|scroll)/.test(`${style.overflow}${style.overflowY}${style.overflowX}`);
      if (canScroll && element.scrollHeight > element.clientHeight) {
        element.scrollTop = element.scrollHeight;
      }
    }
  });
  await page.waitForTimeout(1000);
}

async function scrollElementIntoView(locator, description) {
  const element = await visibleFirst(locator, description, 10000);
  await element.scrollIntoViewIfNeeded();
  await element.click({ trial: true }).catch(() => {});
}

async function fillInputUnderHeader(page, startText, endText, headerText, value, description) {
  const inputIndex = await page.evaluate(({ startText, endText, headerText }) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function textContent(element) {
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }

    function findTextElement(text, afterY = -1) {
      return Array.from(document.querySelectorAll("body *"))
        .map((element) => ({ element, rect: element.getBoundingClientRect(), text: textContent(element) }))
        .filter(({ element, rect, text: elementText }) => {
          const y = rect.top + window.scrollY;
          return isVisible(element)
            && y > afterY
            && (elementText === text || elementText.startsWith(text))
            && rect.height < 120
            && rect.width < 900;
        })
        .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.height - b.rect.height))[0]?.element;
    }

    const allElements = Array.from(document.querySelectorAll("body *"));
    const start = findTextElement(startText);
    if (!start) return -1;

    const startY = start.getBoundingClientRect().top + window.scrollY;
    const end = findTextElement(endText, startY);
    const endY = end ? end.getBoundingClientRect().top + window.scrollY : Number.POSITIVE_INFINITY;

    const headers = allElements
      .filter((element) => isVisible(element) && textContent(element) === headerText)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => {
        const y = rect.top + window.scrollY;
        return y >= startY && y <= endY;
      });
    if (!headers.length) return -1;

    const header = headers[headers.length - 1];
    const headerX = header.rect.left + header.rect.width / 2;
    const headerY = header.rect.top + window.scrollY;
    const inputs = Array.from(document.querySelectorAll("input"));
    const candidates = inputs
      .map((input, index) => ({ input, index, rect: input.getBoundingClientRect() }))
      .filter(({ input, rect }) => {
        if (!isVisible(input)) return false;
        const y = rect.top + window.scrollY;
        const x = rect.left + rect.width / 2;
        return y > headerY && y < endY && Math.abs(x - headerX) < 140;
      })
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));

    return candidates[0]?.index ?? -1;
  }, { startText, endText, headerText });

  if (inputIndex < 0) fail(`Could not find ${description}`);
  const input = page.locator("input").nth(inputIndex);
  await replaceInputValue(input, value);
  await input.press("Tab").catch(() => {});
}

async function fillRenewalOptionNewRent(page, value) {
  const inputIndex = await page.evaluate(() => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function cleanText(element) {
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }

    const elements = Array.from(document.querySelectorAll("body *"));
    const addAnother = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) => isVisible(element) && /^Add Another Renewal Option$/i.test(text) && rect.height < 80)
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (!addAnother) return -1;

    const inputs = Array.from(document.querySelectorAll("input"));
    const candidates = inputs
      .map((input, index) => ({ input, index, rect: input.getBoundingClientRect(), type: (input.getAttribute("type") || "text").toLowerCase() }))
      .filter(({ input, rect, type }) =>
        isVisible(input)
        && !["checkbox", "radio", "hidden", "search"].includes(type)
        && rect.top < addAnother.rect.top
        && rect.top > 60
        && rect.left > 650
        && rect.width > 50
        && rect.height < 70
      )
      .sort((a, b) => (b.rect.top - a.rect.top) || (b.rect.left - a.rect.left));

    return candidates[0]?.index ?? -1;
  });

  if (inputIndex < 0) fail("Could not find renewal option new rent");
  const input = page.locator("input").nth(inputIndex);
  await replaceInputValue(input, value);
  await input.press("Tab").catch(() => {});
}

async function replaceInputValue(input, value) {
  await input.click({ force: true });
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.pressSequentially(String(value), { delay: 20 });
}

async function selectAddendum(page, addendum) {
  if (await isAddendumAlreadySelected(page, addendum)) {
    log("Skipping already-selected addendum", addendum);
    return;
  }
  const checkbox = await checkByLabel(page, [addendum]).then(() => true).catch(() => false);
  if (checkbox) return;
  const searchText = ADDENDUM_SEARCH_QUERIES.get(normalizeAddendumName(addendum)) || addendum;
  await selectCustomDropdownByPlaceholder(page, "Select Addenda Template", addendum, searchText);
}

async function isAddendumAlreadySelected(page, addendum) {
  const selectedValues = await page.evaluate(() => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    return Array.from(document.querySelectorAll(".Select-value-label, .Select-value, [class*='multi-value__label']"))
      .filter(isVisible)
      .map((element) => element.textContent || "");
  }).catch(() => []);

  const target = normalizeAddendumName(addendum);
  return selectedValues.some((value) => {
    const normalized = normalizeAddendumName(value.replace(/[x×]\s*$/i, ""));
    return normalized === target;
  });
}

async function clearCustomDropdown(page, control) {
  for (let i = 0; i < 20; i += 1) {
    const clearButtons = control.locator(".Select-value-icon, .Select-clear-zone");
    const count = await clearButtons.count().catch(() => 0);
    let clicked = false;
    for (let index = 0; index < count; index += 1) {
      const button = clearButtons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      await button.click({ force: true });
      clicked = true;
      break;
    }
    if (!clicked) return;
    await page.waitForTimeout(250);
  }
}

async function closeOpenSelectDropdowns(page, context) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const openDropdownCount = await page.locator(".Select-menu-outer:visible, .Select-menu:visible, [role='listbox']:visible").count().catch(() => 0);
    if (openDropdownCount === 0) return;

    log("DROPDOWN_CLOSE", `${context} attempt=${attempt} open=${openDropdownCount}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
    await page.waitForTimeout(300);
  }

  const remainingDropdownCount = await page.locator(".Select-menu-outer:visible, .Select-menu:visible, [role='listbox']:visible").count().catch(() => 0);
  if (remainingDropdownCount > 0) {
    log("DROPDOWN_CLOSE_WARNING", `${context} remaining=${remainingDropdownCount}`);
  }
}

async function selectCustomDropdownInSection(page, sectionHeading, labelText, optionText, searchText = optionText) {
  const control = await findCustomDropdownControlInSection(page, sectionHeading, labelText);
  await selectCustomDropdownControl(page, control, `${sectionHeading} ${labelText}`, optionText, searchText);
}

async function selectCustomDropdownByPlaceholder(page, placeholderText, optionText, searchText = optionText) {
  const placeholderRegex = new RegExp(`^\\s*${escapeRegex(placeholderText)}\\s*$`, "i");
  const placeholder = await visibleFirst(page.getByText(placeholderRegex), placeholderText, 5000)
    .catch(() => null);
  const control = placeholder
    ? placeholder.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' Select-control ')][1]")
    : await findCustomDropdownControlByLabel(page, placeholderText);
  await selectCustomDropdownControl(page, control, placeholderText, optionText, searchText);
}

async function selectCustomDropdownControl(page, control, description, optionText, searchText = optionText) {
  const optionRegex = new RegExp(`^\\s*${escapeRegex(optionText)}\\s*$`, "i");
  const searchRegex = new RegExp(escapeRegex(searchText), "i");
  const input = control.locator("input[role='combobox'], input").first();
  const inputCandidate = await visibleFirst(input, `${description} combobox input`, 2000).catch(() => null);
  if (!inputCandidate) fail(`Could not find combobox input for dropdown: ${description}`);

  await inputCandidate.click({ force: true });
  await inputCandidate.fill(searchText).catch(async () => {
    await inputCandidate.pressSequentially(searchText);
  });

  const optionLocators = [
    page.locator(".Select-menu-outer .Select-option, .Select-menu .Select-option, [role='option']").filter({ hasText: optionRegex }),
    page.locator(".Select-menu-outer .Select-option, .Select-menu .Select-option, [role='option']").filter({ hasText: searchRegex }),
  ];
  for (const locator of optionLocators) {
    const option = await visibleFirst(locator, optionText, 5000).catch(() => null);
    if (!option) continue;
    await option.click();
    return;
  }

  await inputCandidate.press("Enter").catch(() => {});
  await page.waitForTimeout(500);
  const selectedText = await control.innerText().catch(() => "");
  if (new RegExp(escapeRegex(optionText), "i").test(selectedText) || searchRegex.test(selectedText)) return;

  fail(`Could not find dropdown option "${optionText}" after opening "${description}"`);
}

async function findCustomDropdownControlInSection(page, sectionHeading, labelText) {
  const controlIndex = await page.evaluate(({ sectionHeading, labelText }) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function cleanText(element) {
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }

    const elements = Array.from(document.querySelectorAll("body *"));
    const section = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) =>
        isVisible(element)
        && text === sectionHeading
        && rect.height < 120
        && rect.width < 900
      )
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.height - b.rect.height))[0];
    if (!section) return -1;

    const sectionY = section.rect.top + window.scrollY;
    const label = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) =>
        isVisible(element)
        && text.includes(labelText)
        && rect.top + window.scrollY > sectionY
        && rect.height < 80
        && rect.width < 400
      )
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left))[0];
    if (!label) return -1;

    const labelRect = label.rect;
    const controls = Array.from(document.querySelectorAll(".Select-control"));
    const candidates = controls
      .map((control, index) => ({ control, index, rect: control.getBoundingClientRect() }))
      .filter(({ control, rect }) =>
        isVisible(control)
        && rect.top + window.scrollY > sectionY
        && rect.left > labelRect.left
        && Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2)) < 45
      )
      .sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - (labelRect.top + labelRect.height / 2))
        - Math.abs((b.rect.top + b.rect.height / 2) - (labelRect.top + labelRect.height / 2)));

    return candidates[0]?.index ?? -1;
  }, { sectionHeading, labelText });

  if (controlIndex < 0) fail(`Could not find ${labelText} dropdown in ${sectionHeading}`);
  return page.locator(".Select-control").nth(controlIndex);
}

async function findCustomDropdownControlAfterHeading(page, headingText, labelText) {
  const controlIndex = await page.evaluate(({ headingText, labelText }) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function cleanText(element) {
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }

    const elements = Array.from(document.querySelectorAll("body *"));
    const heading = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) =>
        isVisible(element)
        && text === headingText
        && rect.height < 100
        && rect.width < 900
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (!heading) return -1;

    const headingY = heading.rect.top + window.scrollY;
    const label = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) =>
        isVisible(element)
        && text.includes(labelText)
        && rect.top + window.scrollY > headingY
        && rect.height < 80
        && rect.width < 500
      )
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left))[0];
    if (!label) return -1;

    const controls = Array.from(document.querySelectorAll(".Select-control"));
    const candidates = controls
      .map((control, index) => ({ control, index, rect: control.getBoundingClientRect() }))
      .filter(({ control, rect }) =>
        isVisible(control)
        && rect.top + window.scrollY > headingY
        && rect.left > label.rect.left
        && Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2)) < 70
      )
      .sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - (label.rect.top + label.rect.height / 2))
        - Math.abs((b.rect.top + b.rect.height / 2) - (label.rect.top + label.rect.height / 2)));

    return candidates[0]?.index ?? -1;
  }, { headingText, labelText });

  if (controlIndex < 0) fail(`Could not find ${labelText} dropdown after ${headingText}`);
  return page.locator(".Select-control").nth(controlIndex);
}

async function findVisibleMonthToMonthAddendaControl(page) {
  const controlIndex = await page.evaluate(() => {
    function isActuallyVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < window.innerHeight
        && style.visibility !== "hidden"
        && style.display !== "none";
    }

    function cleanText(element) {
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }

    const heading = Array.from(document.querySelectorAll("body *"))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) =>
        isActuallyVisible(element)
        && text === "Add Month To Month Option"
        && rect.height < 100
      )
      .sort((a, b) => a.rect.top - b.rect.top)[0];
    if (!heading) return -1;

    const controls = Array.from(document.querySelectorAll(".Select-control"))
      .map((control, index) => ({ control, index, rect: control.getBoundingClientRect(), text: cleanText(control) }))
      .filter(({ control, rect }) =>
        isActuallyVisible(control)
        && rect.top > heading.rect.top
        && rect.left > 400
      )
      .sort((a, b) => (b.rect.height - a.rect.height) || (a.rect.top - b.rect.top));

    return controls[0]?.index ?? -1;
  });

  if (controlIndex < 0) fail("Could not find Month To Month Include Addenda dropdown");
  return page.locator(".Select-control").nth(controlIndex);
}

async function findCustomDropdownControlByLabel(page, placeholderText) {
  const labelText = placeholderText.includes("Addenda")
    ? "Include Addenda"
    : placeholderText.includes("Lease")
      ? "Include Lease"
      : placeholderText;
  const label = await visibleFirst(
    page.getByText(new RegExp(`^\\s*${escapeRegex(labelText)}\\s*$`, "i")),
    labelText,
    3000
  ).catch(() => null);
  if (!label) fail(`Could not find dropdown placeholder: ${placeholderText}`);
  return label.locator("xpath=following::*[contains(concat(' ', normalize-space(@class), ' '), ' Select-control ')][1]");
}

async function findLastCustomDropdownControlByLabel(page, labelText) {
  const controlIndex = await page.evaluate((labelText) => {
    function isVisible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }

    function cleanText(element) {
      return (element.textContent || "").replace(/\s+/g, " ").trim();
    }

    const elements = Array.from(document.querySelectorAll("body *"));
    const labels = elements
      .map((element) => ({ element, rect: element.getBoundingClientRect(), text: cleanText(element) }))
      .filter(({ element, rect, text }) =>
        isVisible(element)
        && text.includes(labelText)
        && rect.height < 80
        && rect.width < 500
      )
      .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));

    const controls = Array.from(document.querySelectorAll(".Select-control"));
    const matches = labels
      .map((label) => {
        const candidates = controls
          .map((control, index) => ({ control, index, rect: control.getBoundingClientRect() }))
          .filter(({ control, rect }) =>
            isVisible(control)
            && rect.left > label.rect.left
            && Math.abs((rect.top + rect.height / 2) - (label.rect.top + label.rect.height / 2)) < 90
          )
          .sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - (label.rect.top + label.rect.height / 2))
            - Math.abs((b.rect.top + b.rect.height / 2) - (label.rect.top + label.rect.height / 2)));
        return candidates[0]?.index ?? -1;
      })
      .filter((index) => index >= 0);

    return matches[matches.length - 1] ?? -1;
  }, labelText);

  if (controlIndex < 0) fail(`Could not find ${labelText} dropdown`);
  return page.locator(".Select-control").nth(controlIndex);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  let context;
  let page;
  try {
    CONFIG.rowNumber = resolveRowNumber();
    log("Selected Google Sheet row", String(CONFIG.rowNumber));
    const data = await readLeaseRenewalRow();
    const username = requireEnv("APPFOLIO_USERNAME");
    const password = requireEnv("APPFOLIO_PASSWORD");

    log("Launching Playwright", CONFIG.headless ? "headless" : "headed");
    const userDataDir = path.resolve(process.cwd(), process.env.PLAYWRIGHT_USER_DATA_DIR || ".playwright-appfolio-profile");
    log("Using Playwright persistent profile", userDataDir);
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: CONFIG.headless,
      slowMo: CONFIG.slowMo,
      viewport: { width: 1440, height: 1000 },
    });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(Number(process.env.PLAYWRIGHT_TIMEOUT_MS || "15000"));

    await login(page, username, password);
    if (CONFIG.appfolioNoticeUrl) {
      log("Starting from renewal notice URL", CONFIG.appfolioNoticeUrl);
      await page.goto(CONFIG.appfolioNoticeUrl, { waitUntil: "domcontentloaded" });
      const noticePage = await waitForRenewalNoticeLetterScreen(page);
      const leasePreviewPage = await configureRenewalNoticeLetter(noticePage, data);
      await configureLeasePreview(leasePreviewPage, data);
    } else {
      await ensurePostLoginReady(page, data);
      logState("STARTING_TENANT_SEARCH", data.tenantName);
      await searchTenant(page, data.tenantName);
      await prepareRenewalOffer(page, data);
    }
    await markProcessedRowGreen();
    logState("SUCCESS", `Processed row ${CONFIG.rowNumber}`);
  } catch (error) {
    if (error instanceof SkipError) {
      logState("SKIPPED", error.message);
      return;
    }

    let screenshotPath = "";
    if (page) {
      screenshotPath = await capturePageDiagnostics(page, "renewal-error", error.message);
    }
    logState("ERROR", error.message);
    if (page) {
      console.error(`Screenshot saved to: ${screenshotPath}`);
    }
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
  }
}

main().catch((error) => {
  logState("ERROR", error.message);
  process.exit(1);
});
