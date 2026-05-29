const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const port = Number(process.env.PORT || 8787);
const rootDir = __dirname;
const dataDir = path.join(rootDir, "data");
const dataFile = path.join(dataDir, "work-orders.json");
const webhookLogFile = path.join(dataDir, "webhook-log.json");
const completionLogFile = path.join(dataDir, "completion-log.json");
const renewalJobLogFile = path.join(rootDir, "renewal-job.log");
const appUrl = `http://127.0.0.1:${port}`;
const completionWebhookUrl = "https://tgpm.app.n8n.cloud/webhook/25b7e346-ebf6-483f-838f-b5e8ffbc45f7";
const renewalJobQueue = [];
let activeRenewalJob = null;

const bucketTypes = ["HVAC", "Plumbing", "Maintenance", "Freestyle"];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const bucketKeywords = {
  HVAC: [
    "ac",
    "air conditioning",
    "hvac",
    "heat",
    "no cooling",
    "no heat",
    "thermostat",
    "air handler",
    "drain line",
  ],
  Plumbing: [
    "toilet",
    "sink",
    "faucet",
    "tub",
    "shower",
    "drain",
    "leak",
    "pipe",
    "disposal",
    "sewer",
    "water heater",
  ],
  Maintenance: [
    "door",
    "doors",
    "lock",
    "locks",
    "cabinet",
    "cabinets",
    "light",
    "lights",
    "smoke detector",
    "smoke detectors",
    "drywall",
    "paint",
    "appliance",
    "appliances",
    "hardware",
    "minor repair",
    "minor repairs",
    "handyman",
  ],
};

function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, "[]\n", "utf8");
  }
  if (!fs.existsSync(webhookLogFile)) {
    fs.writeFileSync(webhookLogFile, "[]\n", "utf8");
  }
  if (!fs.existsSync(completionLogFile)) {
    fs.writeFileSync(completionLogFile, "[]\n", "utf8");
  }
}

function readWorkOrders() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    return Array.isArray(parsed) ? parsed.map(normalizeWorkOrder) : [];
  } catch (error) {
    console.error("Could not read work order data.", error);
    return [];
  }
}

function writeWorkOrders(orders) {
  ensureDataFile();
  fs.writeFileSync(dataFile, `${JSON.stringify(orders.map(normalizeWorkOrder), null, 2)}\n`, "utf8");
}

function readWebhookLog() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(webhookLogFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not read webhook log.", error);
    return [];
  }
}

function writeWebhookLog(entries) {
  ensureDataFile();
  fs.writeFileSync(webhookLogFile, `${JSON.stringify(entries.slice(0, 20), null, 2)}\n`, "utf8");
}

function readCompletionLog() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(completionLogFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Could not read completion log.", error);
    return [];
  }
}

function writeCompletionLog(entries) {
  ensureDataFile();
  fs.writeFileSync(completionLogFile, `${JSON.stringify(entries.slice(0, 50), null, 2)}\n`, "utf8");
}

function getWorkOrderKey(order) {
  return String(order.number || order.work_order_number || "").trim().toLowerCase();
}

function isTestWorkOrder(order) {
  const number = String(order.number || order.work_order_number || "").trim().toUpperCase();
  const property = String(order.property || "").trim().toUpperCase();
  const testNumbers = new Set([
    "WO-1045",
    "WO-1046",
    "WO-1047",
    "WO-1048",
    "WO-1049",
    "WO-2201",
    "WO-2202",
    "WO-2203",
  ]);

  return (
    testNumbers.has(number) ||
    number.startsWith("DUP-") ||
    number.startsWith("VERCEL-") ||
    number.startsWith("REAL-PROD-") ||
    number.startsWith("REAL-LOCAL-") ||
    number.startsWith("QA-") ||
    number.startsWith("N8N-DOC-") ||
    number.startsWith("N8N-100") ||
    number.startsWith("MOCK-") ||
    number.startsWith("TEST-") ||
    number.startsWith("SAMPLE-") ||
    property.includes("TEST") ||
    property.includes("SAMPLE") ||
    property.includes("MOCK")
  );
}

function withoutTestWorkOrders(orders) {
  return orders.filter((order) => !isTestWorkOrder(order));
}

function upsertWorkOrders(existingOrders, incomingOrders) {
  const merged = withoutTestWorkOrders(existingOrders.map(normalizeWorkOrder));
  const indexByNumber = new Map();

  merged.forEach((order, index) => {
    const key = getWorkOrderKey(order);
    if (key) indexByNumber.set(key, index);
  });

  const results = withoutTestWorkOrders(incomingOrders.map(normalizeWorkOrder)).map((order) => {
    const key = getWorkOrderKey(order);
    const existingIndex = key ? indexByNumber.get(key) : undefined;
    const action = existingIndex === undefined ? "created" : "updated";

    if (existingIndex === undefined) {
      indexByNumber.set(key, merged.length);
      merged.push(order);
    } else {
      merged[existingIndex] = order;
    }

    return { action, order };
  });

  return { workOrders: merged, results };
}

function appendWebhookLog(results) {
  const receivedAt = new Date().toISOString();
  const orders = results.map((result) => result.order);
  const entry = {
    received_at: receivedAt,
    count: orders.length,
    created_count: results.filter((result) => result.action === "created").length,
    updated_count: results.filter((result) => result.action === "updated").length,
    work_order_numbers: orders.map((order) => order.number),
    imports: results.map((result) => ({
      action: result.action,
      work_order_number: result.order.number,
      property: result.order.property,
    })),
    properties: [...new Set(orders.map((order) => order.property))],
  };

  writeWebhookLog([entry, ...readWebhookLog()]);
  return entry;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function appendRenewalJobLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(renewalJobLogFile, line, "utf8");
  } catch (error) {
    console.error("Could not write renewal job log.", error);
  }
  console.log(line.trimEnd());
}

function getPayloadRowNumber(payload) {
  const value =
    payload?.rowNumber ??
    payload?.row ??
    payload?.sheetRow ??
    payload?.cocoRow ??
    payload?.leaseRenewalRow ??
    payload?.row_number ??
    payload?.sheet_row ??
    payload?.coco_row ??
    payload?.lease_renewal_row;

  const rowNumber = Number(value);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return null;
  }
  return rowNumber;
}

function createRenewalJob(rowNumber) {
  return {
    jobId: `renewal-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    rowNumber,
    status: "QUEUED",
    queuedAt: new Date().toISOString(),
    startedAt: "",
    finishedAt: "",
    pid: null,
  };
}

function getRenewalQueueSnapshot(job = null) {
  const queuedJobs = renewalJobQueue.map((entry, index) => ({
    jobId: entry.jobId,
    rowNumber: entry.rowNumber,
    status: entry.status,
    queuePosition: index + 1,
    queuedAt: entry.queuedAt,
  }));

  const queuePosition = job
    ? renewalJobQueue.findIndex((entry) => entry.jobId === job.jobId) + 1
    : null;

  return {
    active: activeRenewalJob
      ? {
          jobId: activeRenewalJob.jobId,
          rowNumber: activeRenewalJob.rowNumber,
          status: activeRenewalJob.status,
          pid: activeRenewalJob.pid,
          startedAt: activeRenewalJob.startedAt,
        }
      : null,
    queued: queuedJobs,
    queueDepth: renewalJobQueue.length,
    queuePosition: queuePosition > 0 ? queuePosition : null,
  };
}

function enqueueRenewalJob(rowNumber) {
  const job = createRenewalJob(rowNumber);
  renewalJobQueue.push(job);
  appendRenewalJobLog(`JOB_QUEUED job=${job.jobId} rowNumber=${rowNumber} queuePosition=${renewalJobQueue.length} activeJob=${activeRenewalJob?.jobId || ""}`);
  processRenewalQueue();
  return job;
}

function processRenewalQueue() {
  if (activeRenewalJob || !renewalJobQueue.length) return;
  const job = renewalJobQueue.shift();
  startRenewalJob(job);
}

function finishRenewalJob(job, outcome, detail = "") {
  if (job.finishedAt) return;
  job.status = outcome;
  job.finishedAt = new Date().toISOString();
  if (outcome === "COMPLETED") {
    appendRenewalJobLog(`JOB_COMPLETED job=${job.jobId} rowNumber=${job.rowNumber}${detail ? ` ${detail}` : ""}`);
  } else {
    appendRenewalJobLog(`JOB_FAILED job=${job.jobId} rowNumber=${job.rowNumber}${detail ? ` ${detail}` : ""}`);
  }

  if (activeRenewalJob?.jobId === job.jobId) {
    activeRenewalJob = null;
  }
  processRenewalQueue();
}

function startRenewalJob(job) {
  activeRenewalJob = job;
  job.status = "RUNNING";
  job.startedAt = new Date().toISOString();
  const scriptPath = path.join(rootDir, "scripts", "appfolio-renewal-offer.js");
  const n8nPayload = JSON.stringify({ rowNumber: job.rowNumber, jobId: job.jobId });
  const child = spawn(process.execPath, [scriptPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      N8N_PAYLOAD: n8nPayload,
      LEASE_RENEWAL_ROW: "",
    },
    windowsHide: true,
  });
  job.pid = child.pid;

  let combinedOutput = "";
  appendRenewalJobLog(`JOB_STARTED job=${job.jobId} rowNumber=${job.rowNumber} pid=${child.pid}`);
  appendRenewalJobLog(`START job=${job.jobId} rowNumber=${job.rowNumber} pid=${child.pid}`);

  const logChunk = (streamName, chunk) => {
    const text = chunk.toString();
    combinedOutput += text;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      appendRenewalJobLog(`${streamName} job=${job.jobId} ${line}`);
    }
  };

  child.stdout.on("data", (chunk) => logChunk("stdout", chunk));
  child.stderr.on("data", (chunk) => logChunk("stderr", chunk));
  child.on("error", (error) => {
    appendRenewalJobLog(`ERROR job=${job.jobId} rowNumber=${job.rowNumber} spawn failed: ${error.message}`);
    finishRenewalJob(job, "FAILED", `spawnError="${error.message}"`);
  });
  child.on("close", (code, signal) => {
    if (/\bSKIPPED\b/.test(combinedOutput)) {
      appendRenewalJobLog(`SKIPPED job=${job.jobId} rowNumber=${job.rowNumber} exitCode=${code}`);
      finishRenewalJob(job, "COMPLETED", `result=SKIPPED exitCode=${code}`);
      return;
    }
    if (code === 0 && /\bSUCCESS\b/.test(combinedOutput)) {
      appendRenewalJobLog(`SUCCESS job=${job.jobId} rowNumber=${job.rowNumber} exitCode=0`);
      finishRenewalJob(job, "COMPLETED", "result=SUCCESS exitCode=0");
      return;
    }
    if (code === 0) {
      appendRenewalJobLog(`SUCCESS job=${job.jobId} rowNumber=${job.rowNumber} exitCode=0`);
      finishRenewalJob(job, "COMPLETED", "result=EXIT_0 exitCode=0");
      return;
    }
    appendRenewalJobLog(`ERROR job=${job.jobId} rowNumber=${job.rowNumber} exitCode=${code} signal=${signal || ""}`);
    finishRenewalJob(job, "FAILED", `exitCode=${code} signal=${signal || ""}`);
  });

  child.unref();
  return job;
}

async function postCompletionToN8n(payload) {
  const result = await fetch(completionWebhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const responseText = await result.text();

  if (!result.ok) {
    throw new Error(`n8n completion webhook failed with status ${result.status}: ${responseText}`);
  }

  return {
    status: result.status,
    body: responseText,
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function classifyWorkOrderType(order) {
  const text = [order.issue, order.description, order.instructions]
    .join(" ")
    .toLowerCase();

  const hasKeyword = (keyword) => {
    if (keyword === "ac" || keyword === "heat") {
      return new RegExp(`\\b${keyword}\\b`).test(text);
    }
    return text.includes(keyword);
  };

  if (bucketKeywords.HVAC.some(hasKeyword)) return "HVAC";
  if (bucketKeywords.Plumbing.some(hasKeyword)) return "Plumbing";
  if (bucketKeywords.Maintenance.some(hasKeyword)) return "Maintenance";
  return "Freestyle";
}

function normalizeWorkOrderType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return bucketTypes.find((type) => type.toLowerCase() === normalized) || "";
}

function normalizePriority(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("urgent") || normalized.includes("high")) return "High";
  if (normalized.includes("low")) return "Low";
  return value || "Medium";
}

function normalizeWorkOrder(input) {
  const order = {
    number: input.number || input.work_order_number || `WO-${Date.now()}`,
    property: input.property || "Unassigned Property",
    address:
      input.address ||
      input.property_address ||
      input.propertyAddress ||
      input.service_address ||
      input.location ||
      input.property ||
      "Property address not provided",
    issue: input.issue || input.work_order_issue || "General Maintenance",
    description: input.description || input.job_description || "No job description provided.",
    instructions: input.instructions || "Review resident notes and verify scope before dispatch.",
    availability: input.availability || input.tenant_availability || "Tenant availability not provided",
    tenant_name: input.tenant_name || input.tenantName || "",
    tenant_phone: input.tenant_phone || input.tenantPhone || "",
    status: input.status || "New",
    technician: input.technician || input.assigned_technician || "Unassigned",
    priority: normalizePriority(input.priority),
  };

  order.workOrderType =
    normalizeWorkOrderType(input.workOrderType || input.ai_work_order_type) || classifyWorkOrderType(order);

  return order;
}

async function handleApi(request, response, pathname) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return true;
  }

  if (pathname === "/run-renewal" && request.method === "POST") {
    const payload = await readJsonBody(request);
    const rowNumber = getPayloadRowNumber(payload);
    if (!rowNumber) {
      sendJson(response, 400, {
        success: false,
        error: "POST /run-renewal requires rowNumber, row, sheetRow, cocoRow, or leaseRenewalRow as an integer >= 2.",
      });
      return true;
    }

    const job = enqueueRenewalJob(rowNumber);
    const queue = getRenewalQueueSnapshot(job);
    const isRunning = activeRenewalJob?.jobId === job.jobId;
    sendJson(response, 202, {
      success: true,
      status: isRunning ? "STARTED" : "QUEUED",
      message: isRunning
        ? "Renewal job accepted. Playwright is running in the background."
        : "Renewal job accepted and queued. It will run after earlier renewal jobs finish.",
      rowNumber,
      jobId: job.jobId,
      pid: job.pid,
      queuePosition: isRunning ? 0 : queue.queuePosition,
      activeJobId: queue.active?.jobId || null,
      queueDepth: queue.queueDepth,
      logFile: renewalJobLogFile,
    });
    return true;
  }

  if (pathname === "/run-renewal/status" && request.method === "GET") {
    sendJson(response, 200, {
      success: true,
      ...getRenewalQueueSnapshot(),
      logFile: renewalJobLogFile,
    });
    return true;
  }

  if (pathname === "/api/work-orders" && request.method === "GET") {
    const cleaned = withoutTestWorkOrders(readWorkOrders());
    sendJson(response, 200, { success: true, work_orders: cleaned });
    return true;
  }

  if (pathname === "/api/integration/n8n" && request.method === "GET") {
    const log = readWebhookLog().filter((entry) => {
      const numbers = entry.work_order_numbers || [];
      return !numbers.some((number) => isTestWorkOrder({ number }));
    });
    sendJson(response, 200, {
      success: true,
      local_webhook_url: `${appUrl}/api/n8n/work-orders`,
      completion_handoff_url: completionWebhookUrl,
      expected_json: {
        work_order_number: "WO-12345",
        property: "Willow Creek Apartments",
        property_address: "1200 Willow Creek Dr, Atlanta, GA 30309",
        job_description: "Kitchen faucet leak under sink",
        instructions: "Check faucet supply line and pipe connection",
        work_order_issue: "Leak",
        ai_work_order_type: "Plumbing",
        status: "New",
        assigned_technician: "Unassigned",
        priority: "High",
      },
      last_webhook_received_at: log[0]?.received_at || null,
      recent_webhook_import_log: log.slice(0, 10),
    });
    return true;
  }

  if (pathname === "/api/work-orders" && request.method === "PUT") {
    const payload = await readJsonBody(request);
    const orders = Array.isArray(payload) ? payload : payload.work_orders;
    if (!Array.isArray(orders)) {
      sendJson(response, 400, { success: false, error: "Expected an array or work_orders array." });
      return true;
    }
    const normalized = withoutTestWorkOrders(orders.map(normalizeWorkOrder));
    writeWorkOrders(normalized);
    sendJson(response, 200, { success: true, count: normalized.length, work_orders: normalized });
    return true;
  }

  if (pathname === "/api/work-orders" && request.method === "DELETE") {
    writeWorkOrders([]);
    sendJson(response, 200, { success: true, count: 0 });
    return true;
  }

  if (pathname === "/api/test-data" && request.method === "DELETE") {
    const cleaned = withoutTestWorkOrders(readWorkOrders());
    const cleanedLog = readWebhookLog().filter((entry) => {
      const numbers = entry.work_order_numbers || [];
      return !numbers.some((number) => isTestWorkOrder({ number }));
    });
    writeWorkOrders(cleaned);
    writeWebhookLog(cleanedLog);
    sendJson(response, 200, { success: true, count: cleaned.length, work_orders: cleaned });
    return true;
  }

  if (pathname === "/api/n8n/work-orders" && request.method === "POST") {
    const payload = await readJsonBody(request);
    const postedOrders = Array.isArray(payload) ? payload : payload.work_orders || [payload];
    const existing = readWorkOrders();
    const { workOrders: merged, results } = upsertWorkOrders(existing, postedOrders);
    writeWorkOrders(merged);
    const logEntry = appendWebhookLog(results);
    sendJson(response, 201, {
      success: true,
      message: "Work order received.",
      count: results.length,
      created_count: logEntry.created_count,
      updated_count: logEntry.updated_count,
      received_at: logEntry.received_at,
      import_log: logEntry.imports,
      work_orders: results.map((result) => result.order),
    });
    return true;
  }

  if (pathname === "/api/n8n/job-completions" && request.method === "POST") {
    const payload = await readJsonBody(request);
    const completedAt = payload.completed_at || new Date().toISOString();
    const entry = {
      ...payload,
      completed_at: completedAt,
      received_at: new Date().toISOString(),
    };
    const n8nResponse = await postCompletionToN8n(entry);
    const key = getWorkOrderKey({ work_order_number: payload.work_order_number });
    const updated = readWorkOrders().map((order) =>
      getWorkOrderKey(order) === key ? { ...order, status: "Completed" } : order,
    );
    const completionLog = [entry, ...readCompletionLog()].slice(0, 50);
    writeWorkOrders(updated);
    writeCompletionLog(completionLog);
    sendJson(response, 201, {
      success: true,
      message: "Completion note received.",
      completed_at: completedAt,
      total_completion_count: completionLog.length,
      n8n_webhook_url: completionWebhookUrl,
      n8n_status: n8nResponse.status,
    });
    return true;
  }

  return false;
}

function sendFile(response, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(data);
  });
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(rootDir, requestedPath));

  if (!filePath.startsWith(rootDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isFile()) {
      sendFile(response, filePath);
      return;
    }

    const hasFileExtension = Boolean(path.extname(pathname));
    const isBrowserRoute = request.method === "GET" && !hasFileExtension;
    if (isBrowserRoute) {
      sendFile(response, path.join(rootDir, "index.html"));
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  });
}

const server = http.createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  try {
    if ((pathname === "/run-renewal" || pathname === "/run-renewal/status" || pathname.startsWith("/api/")) && (await handleApi(request, response, pathname))) {
      return;
    }
  } catch (error) {
    sendJson(response, 400, { success: false, error: error.message });
    return;
  }

  serveStatic(request, response, pathname);
});

server.listen(port, () => {
  console.log(`The Property Manager Toolbox is running at ${appUrl}`);
  console.log(`n8n webhook endpoint: ${appUrl}/api/n8n/work-orders`);
});
