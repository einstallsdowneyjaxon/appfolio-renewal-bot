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
  useHardcodedTestRow: parseBoolean(process.env.USE_HARDCODED_TEST_ROW, false),
  appfolioNoticeUrl: process.env.APPFOLIO_NOTICE_URL || "",
  headless: parseBoolean(process.env.HEADLESS, false),
  slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO || "0"),
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
  let byColumn;
  if (CONFIG.useHardcodedTestRow) {
    log("Using temporary hardcoded row 2 test values", "Google Sheets read is bypassed");
    byColumn = {
      unitId: "",
      tenantName: "Test Testing",
      renewalRate: "1500",
      leaseFrom: "06/01/2026",
      leaseTo: "05/31/2027",
      earlyTerminationRate: "3,000",
      addendumsAdded: "",
      addendumsRemoved: "",
      addendums: "",
      renewalLetterOption: "Main",
      lawn: "Tenant",
    };
  } else {
    byColumn = await readLeaseRenewalRowFromSheet();
  }

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
  if (CONFIG.useHardcodedTestRow) return;
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
      return;
    }
  }
  fail(`Could not find field for labels: ${labels.join(", ")}`);
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
  log("Opening AppFolio", CONFIG.appfolioUrl);
  await page.goto(CONFIG.appfolioUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  if (await isSignedIn(page)) {
    log("AppFolio session already signed in");
    return;
  }

  log("Logging into AppFolio");
  await fillByLabel(page, ["email", "username", "login"], username);
  await fillByLabel(page, ["password"], password);
  await clickByRoleOrText(page, "sign in|log in|login", "login button");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle").catch(() => {});

  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/2-Step Verification|Send Verification Code|verification code/i.test(bodyText)) {
    log("AppFolio requires 2-step verification", "Requesting verification code");
    await clickByRoleOrText(page, "send verification code", "Send Verification Code button");
    await page.waitForLoadState("networkidle").catch(() => {});

    const verificationCode = await askForInput("Enter AppFolio verification code: ");
    if (!verificationCode) fail("No AppFolio verification code was entered");

    const afterPromptText = await page.locator("body").innerText().catch(() => "");
    if (!/2-Step Verification|verification code/i.test(afterPromptText)) {
      log("2-step verification completed manually");
      return;
    }

    log("Entering AppFolio verification code");
    await fillByLabel(page, ["Verification Code", "Code", "Security Code"], verificationCode);
    await clickByRoleOrText(page, "verify|submit|continue|sign in|log in", "2-step verification submit button");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    log("2-step verification completed");
  }
}

async function isSignedIn(page) {
  const searchBox = await findSearchBox(page, 2000).catch(() => null);
  if (searchBox) return true;
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return /Dashboard|Property Manager|Tasks/i.test(bodyText) && /Search AppFolio/i.test(bodyText);
}

async function searchTenant(page, tenantName) {
  log("Searching tenant", tenantName);
  const searchBox = await findSearchBox(page, 5000);

  await searchBox.fill(tenantName);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});

  log("Opening tenant page", tenantName);
  const tenantLink = page.getByRole("link", { name: new RegExp(escapeRegex(tenantName), "i") });
  const result = await visibleFirst(tenantLink, `tenant result for ${tenantName}`, 10000).catch(() => null);
  if (result) {
    await result.click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    return;
  }

  if (new RegExp(escapeRegex(tenantName), "i").test(await page.locator("body").innerText())) {
    return;
  }

  fail(`Could not open tenant page for: ${tenantName}`);
}

async function findSearchBox(page, timeout = 2000) {
  const searchLocators = [
    page.getByRole("searchbox"),
    page.getByPlaceholder(/search appfolio|search/i),
    page.getByLabel(/search appfolio|search/i),
    page.locator("input[type='search']"),
    page.locator("input[name*='search' i]"),
  ];

  for (const locator of searchLocators) {
    const searchBox = await visibleFirst(locator, "global search box", timeout).catch(() => null);
    if (searchBox) return searchBox;
  }
  fail("Could not find AppFolio global search box");
}

async function prepareRenewalOffer(page, data) {
  log("Starting renewal offer task");
  const taskPage = await clickRenewalTask(page);
  page = taskPage;
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  const workflowPage = await findPageWithText(
    page.context(),
    /Renewal Notice Letter|Add Renewal Option|Send Renewal Notice Letter|Renewal Preview|Cancel All|Send All to Tenant|Select which option to review/i,
    15000
  );
  if (!workflowPage) {
    const bodyPreview = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    fail(`Could not find renewal workflow page after opening ${page.url()}. Page starts with: ${bodyPreview.slice(0, 250)}`);
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

  for (const addendum of data.addendums) {
    log("Selecting addendum", addendum);
    await selectAddendum(page, addendum);
  }

  log("Entering county", "Duval");
  await fillByLabel(page, ["County"], "Duval");

  log("Entering lease break fee", data.earlyTerminationRate);
  await fillByLabel(page, ["Lease Break Fee Amount", "2x Rent", "Lease Break Fee"], data.earlyTerminationRate);

  log("Entering lease end date", data.leaseTo);
  await fillByLabel(page, ["Lease End Date", "End Date"], data.leaseTo);

  log("Entering renewal option new rent", data.renewalRate);
  await fillInputUnderHeader(page, "Add Renewal Option", "Add Another Renewal Option", "New Rent", data.renewalRate, "renewal option new rent");

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
      await task.click({ force: true });
      const popup = await popupPromise;
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        await popup.bringToFront();
        return popup;
      }

      return page;
    }
  }

  fail("Could not find a Prepare/Review/Send Renewal Offer task link");
}

async function waitForRenewalNoticeLetterScreen(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  const existingPage = await findPageWithText(page.context(), /Send Renewal Notice Letter/i, 20000);
  if (existingPage) {
    await existingPage.bringToFront();
    return existingPage;
  }

  fail("Could not find Send Renewal Notice Letter screen");
}

async function configureRenewalNoticeLetter(page, data) {
  log("Selecting renewal notice letter", data.renewalLetterOption);
  await selectCustomDropdownInSection(page, "Send Renewal Notice Letter", "Select Letter", data.renewalLetterOption)
    .catch(async () => {
      await selectCustomDropdownByPlaceholder(page, "Select Letter Template", data.renewalLetterOption);
    });
  await clickReviewRenewalOffer(page);
  const previewPage = await findPageWithText(page.context(), /renewal preview|send all to tenant|cancel all/i, 30000);
  if (!previewPage) fail("Could not find renewal preview page");
  await previewPage.bringToFront();
  return previewPage;
}

async function findPageWithText(context, pattern, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      await candidate.waitForLoadState("domcontentloaded").catch(() => {});
      const bodyText = await candidate.locator("body").innerText({ timeout: 1000 }).catch(() => "");
      if (pattern.test(bodyText)) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
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
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
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
  const addendaControl = await findCustomDropdownControlInSection(page, "Add Month To Month Option", "Include Addenda");
  await clearCustomDropdown(page, addendaControl);
  await selectCustomDropdownInSection(page, "Add Month To Month Option", "Include Addenda", "Month to Month Unavailable");
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

async function replaceInputValue(input, value) {
  await input.click({ force: true });
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.pressSequentially(String(value), { delay: 20 });
}

async function selectAddendum(page, addendum) {
  const checkbox = await checkByLabel(page, [addendum]).then(() => true).catch(() => false);
  if (checkbox) return;
  const searchText = ADDENDUM_SEARCH_QUERIES.get(normalizeAddendumName(addendum)) || addendum;
  await selectCustomDropdownByPlaceholder(page, "Select Addenda Template", addendum, searchText);
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
      await page.waitForLoadState("networkidle").catch(() => {});
      const noticePage = await waitForRenewalNoticeLetterScreen(page);
      const leasePreviewPage = await configureRenewalNoticeLetter(noticePage, data);
      await configureLeasePreview(leasePreviewPage, data);
    } else {
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

    const screenshotPath = path.resolve(process.cwd(), `appfolio-renewal-error-${Date.now()}.png`);
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
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
