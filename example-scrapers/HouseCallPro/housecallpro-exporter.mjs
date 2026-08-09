#!/usr/bin/env node

/**
 * HouseCall Pro Exporter
 *
 * Automates HouseCall Pro exports. Most non-invoice categories use HCP's
 * built-in email export flow. Invoices are exported locally as line items by
 * scraping invoice preview pages; the invoice path does not send an email.
 *
 * Usage:
 *   node housecallpro-exporter.mjs
 *   node housecallpro-exporter.mjs --only contacts,jobs,invoices
 *   node housecallpro-exporter.mjs --headless
 *
 * Environment variables (from housecallpro.env or shell):
 *   HOUSECALLPRO_EMAIL             Login email
 *   HOUSECALLPRO_PASSWORD          Login password
 *   HOUSECALLPRO_CUSTOMER_NAME     Override auto-detected company name (optional)
 *   HOUSECALLPRO_INVOICE_MAX_INVOICES  Cap invoice line-item scrape for testing
 *   HOUSECALLPRO_INVOICE_STATUSES      Optional comma list, e.g. open,paid,pending_payment
 *   HOUSECALLPRO_OUTPUT_DIR            Output directory (default: ~/Downloads)
 *
 * Categories triggered:
 *   contacts   — Customers → Actions → Export → Send file
 *   estimates  — Estimates → Actions → Export → Send file
 *   jobs       — Jobs → Actions → Export → Send file
 *   invoices   — Local XLSX from invoice-list API + invoice preview line items
 *   services   — Settings → Price Book → Services tab → Export
 *   materials  — Settings → Price Book → Materials tab → Export
 *   equipment  — Equipment (Property Profile) → Download icon
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import process from "node:process";

import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Load env file if present
// ---------------------------------------------------------------------------

const envPath = path.join(__dirname, "housecallpro.env");
try {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) {
      const k = key.trim();
      if (k && !process.env[k]) process.env[k] = rest.join("=").trim();
    }
  }
} catch {
  // env file is optional
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE = "https://pro.housecallpro.com";
const DEFAULT_SESSION_DIR = path.resolve(process.env.HOME, ".housecallpro-session");
const DEFAULT_OUTPUT_DIR = path.resolve(os.homedir(), "Downloads");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ---------------------------------------------------------------------------
// Export definitions
// ---------------------------------------------------------------------------

const EXPORT_DEFINITIONS = {
  contacts: {
    label: "Contacts (Customers)",
    url: `${BASE}/app/customers/list`,
    type: "actions-menu",
    dialogTitle: /export customer list/i,
  },
  estimates: {
    label: "Estimates",
    url: `${BASE}/app/customers/estimates`,
    type: "estimate-line-items",
  },
  jobs: {
    label: "Job History",
    url: `${BASE}/app/customers/jobs`,
    type: "actions-menu",
    dialogTitle: /export job/i,
  },
  invoices: {
    label: "Invoices",
    type: "invoice-line-items",
  },
  services: {
    label: "Services (Pricebook)",
    url: `${BASE}/app/settings/price_book/services`,
    type: "pricebook-tab",
    tab: null, // already on Services tab
  },
  materials: {
    label: "Materials (Pricebook)",
    url: `${BASE}/app/settings/price_book/services`,
    type: "pricebook-tab",
    tab: "Materials",
  },
  equipment: {
    label: "Equipment (Property Profile)",
    url: `${BASE}/app/equipment`,
    type: "equipment",
  },
};

const ALL_EXPORT_KEYS = Object.keys(EXPORT_DEFINITIONS);

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function getArgValue(keys) {
  for (const key of keys) {
    const index = process.argv.indexOf(key);
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  }
  return undefined;
}

function getFlag(name) {
  return process.argv.includes(name);
}

function getBooleanEnv(name, defaultValue) {
  const value = process.env[name];
  if (!value) return defaultValue;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function getIntegerOption(argNames, envName, defaultValue) {
  const argValue = getArgValue(argNames);
  const rawValue = argValue ?? process.env[envName];
  if (rawValue === undefined || rawValue === "") return defaultValue;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${envName} must be a non-negative integer.`);
  }
  return parsed;
}

function resolveExportKeys() {
  const only = getArgValue(["--only"]);
  if (!only) return ALL_EXPORT_KEYS;
  const keys = only.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  const invalid = keys.filter((k) => !EXPORT_DEFINITIONS[k]);
  if (invalid.length > 0) {
    console.error(`Unknown export keys: ${invalid.join(", ")}`);
    console.error(`Valid keys: ${ALL_EXPORT_KEYS.join(", ")}`);
    process.exit(1);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForManualStep(promptText) {
  const rl = readline.createInterface({ input, output });
  await rl.question(promptText);
  rl.close();
}

// Wait for React to finish rendering — HCP is MUI-based and needs a few seconds
async function waitForReact(page, extraMs = 2000) {
  await page.waitForFunction(
    () => document.querySelectorAll("button").length > 2,
    { timeout: 15000 }
  ).catch(() => {});
  await sleep(extraMs);
}

// ---------------------------------------------------------------------------
// Customer name detection
// ---------------------------------------------------------------------------

async function detectCustomerName(page) {
  if (process.env.HOUSECALLPRO_CUSTOMER_NAME) return process.env.HOUSECALLPRO_CUSTOMER_NAME;

  // Try company settings page
  try {
    await page.goto(`${BASE}/app/settings/account`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await sleep(2000);
    const name = await page.evaluate(() => {
      // Generic labels/section headings that are NOT a real company name.
      const GENERIC = new Set([
        "company", "companies", "account", "settings", "profile",
        "business", "business info", "company info", "company profile",
        "housecall pro", "customer", "customers",
      ]);
      const isGeneric = (v) => GENERIC.has((v || "").trim().toLowerCase());

      for (const inp of document.querySelectorAll("input[type='text'], input:not([type])")) {
        if ((inp.name || inp.id || inp.placeholder || "").toLowerCase().includes("company") &&
            inp.value && inp.value.length > 2 && !isGeneric(inp.value)) {
          return inp.value;
        }
      }
      // Also try page heading — but reject generic section headings.
      const h1 = document.querySelector("h1, h2");
      if (h1) {
        const text = (h1.innerText || h1.textContent || "").trim();
        if (text && text.length > 2 && text.length < 80 && !isGeneric(text)) return text;
      }
      return null;
    });
    if (name) return name;
    console.log("Note: could not auto-detect a company name. Set HOUSECALLPRO_CUSTOMER_NAME in .env for correct output filenames.");
  } catch {}

  return "HouseCall Pro Customer";
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function isLoggedIn(page) {
  if (/log_in|login|sign_in/i.test(page.url())) return false;
  const hasPasswordField = await page.$('input[type="password"]').catch(() => null);
  return !hasPasswordField;
}

async function attemptLogin(page) {
  const email = process.env.HOUSECALLPRO_EMAIL;
  const password = process.env.HOUSECALLPRO_PASSWORD;
  if (!email || !password) return false;

  await sleep(3000); // wait for React form to render
  const emailField = await page.$(
    'input[type="email"], input[name="email"], input[id*="email" i]'
  );
  const passField = await page.$('input[type="password"]');
  if (!emailField || !passField) return false;

  await emailField.click({ clickCount: 3 });
  await emailField.type(email, { delay: 30 });
  await passField.click({ clickCount: 3 });
  await passField.type(password, { delay: 30 });
  await sleep(300);

  // Click the login button
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /log.?in|sign.?in/i.test(b.textContent || "")
    );
    if (btn) btn.click();
  });

  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => sleep(6000));
  return isLoggedIn(page);
}

async function ensureLoggedIn(page, headless) {
  // Try saved session first
  await page.goto(`${BASE}/app/home`, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(7000);

  if (await isLoggedIn(page)) {
    console.log("Session restored.");
    return;
  }

  console.log("Not logged in — attempting auto-login...");
  const ok = await attemptLogin(page);
  if (ok) {
    console.log("Logged in successfully.");
    return;
  }

  if (headless) throw new Error("Auto-login failed. Set HOUSECALLPRO_EMAIL and HOUSECALLPRO_PASSWORD.");

  console.log("\nPlease complete login in the browser window.");
  await waitForManualStep("Press Enter after the HouseCall Pro app loads...");
  if (!(await isLoggedIn(page))) throw new Error("Still on login page — could not authenticate.");
}

// ---------------------------------------------------------------------------
// Export: list pages (Actions menu → Export → Send file dialog)
// ---------------------------------------------------------------------------

async function runActionsMenuExport(page, definition, headless) {
  const { url, dialogTitle } = definition;

  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await waitForReact(page, 3000);

  // Wait for the page-level Actions button to appear (lazy-rendered after data loads)
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll("button")).some(
      (b) => /^Actions?$/i.test((b.innerText || b.textContent || "").trim()) && !b.closest("tr, td")
    ),
    { timeout: 20000 }
  ).catch(() => {});

  // Click the page-level Actions button (not a per-row one inside a <tr>/<td>)
  const actionsClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) => {
      if (!/^Actions?$/i.test((b.innerText || b.textContent || "").trim())) return false;
      let el = b;
      while (el) {
        if (el.tagName === "TR" || el.tagName === "TD") return false;
        el = el.parentElement;
      }
      return true;
    });
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!actionsClicked) {
    if (headless) throw new Error("Could not find page-level Actions button.");
    await waitForManualStep("  Click the Actions button manually, then press Enter...");
  } else {
    await sleep(800);
  }

  // Click "Export" in the dropdown
  const exportClicked = await page.evaluate(() => {
    const items = Array.from(
      document.querySelectorAll("li.MuiMenuItem-root, [role='menuitem']")
    );
    const item = items.find((el) =>
      /^export$/i.test((el.innerText || el.textContent || "").trim())
    );
    if (item) { item.click(); return true; }
    return false;
  });

  if (!exportClicked) {
    if (headless) throw new Error("Could not find Export menu item.");
    await waitForManualStep("  Click Export in the dropdown manually, then press Enter...");
  } else {
    await sleep(800);
  }

  // Wait for the confirmation dialog and click "Send file"
  const dialogAppeared = await page.waitForFunction(
    () => {
      const dialogs = Array.from(document.querySelectorAll(".MuiDialog-paper, [role='dialog']"));
      return dialogs.some((d) => (d.innerText || "").includes("Send file"));
    },
    { timeout: 8000 }
  ).then(() => true).catch(() => false);

  if (!dialogAppeared) {
    if (headless) {
      throw new Error("Export dialog did not appear; cannot verify the email export was queued.");
    }
    console.warn("  Warning: export dialog did not appear — export may have been triggered directly.");
    await waitForManualStep("  Confirm the export email was queued or trigger it manually, then press Enter...");
    return true;
  }

  const sendClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const btn = btns.find((b) =>
      /^send\s*file$/i.test((b.innerText || b.textContent || "").trim())
    );
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!sendClicked) {
    if (headless) throw new Error("Could not click 'Send file' button.");
    await waitForManualStep("  Click 'Send file' in the dialog, then press Enter...");
  } else {
    await sleep(1000);
  }

  // Wait for dialog to close (success indicator)
  await page.waitForFunction(
    () => !document.querySelector(".MuiDialog-paper"),
    { timeout: 8000 }
  ).catch(() => {});

  return true;
}

// ---------------------------------------------------------------------------
// Export: Pricebook (Services or Materials tab → Export button)
// ---------------------------------------------------------------------------

async function runPricebookExport(page, definition, headless) {
  const { url, tab } = definition;
  let lastButtonLabels = [];

  // Navigate + render the pricebook page. HCP occasionally serves a blank/
  // unmounted page on first hit, so reload and retry until buttons appear.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await waitForReact(page);
    await sleep(1500);

    let btnCount = 0;
    for (let waited = 0; waited < 12000; waited += 500) {
      btnCount = await page.evaluate(
        () => document.querySelectorAll("button").length
      );
      if (btnCount > 0) break;
      await sleep(500);
    }
    if (btnCount > 0) break;
    if (attempt < 3) {
      console.log(`  Pricebook page came up empty (attempt ${attempt}); reloading...`);
    } else if (headless) {
      throw new Error("Pricebook page never rendered any buttons after 3 attempts.");
    }
  }

  if (tab) {
    // Click the specified tab (e.g. "Materials")
    const tabClicked = await page.evaluate((tabText) => {
      const tabs = Array.from(
        document.querySelectorAll("[role='tab'], button.MuiTab-root")
      );
      const t = tabs.find((el) =>
        new RegExp(`^${tabText}$`, "i").test((el.innerText || el.textContent || "").trim())
      );
      if (t) { t.click(); return true; }
      return false;
    }, tab);

    if (!tabClicked) {
      if (headless) throw new Error(`Could not find "${tab}" tab.`);
      await waitForManualStep(`  Click the "${tab}" tab manually, then press Enter...`);
    } else {
      await sleep(1500);
    }
  }

  // Click the Export button on the active tab.
  // For Services tab: the first "Export" button (Export services, not "Export with flat rate").
  // For Materials tab: the only "Export" button.
  // The button can render late after a tab switch / React load, so poll for it.
  // The Export button may live in the top document OR inside an embedded
  // iframe (HCP sometimes renders pricebook settings in a frame), so search
  // every frame on each poll.
  const findAndClickExport = async () => {
    for (const frame of page.frames()) {
      try {
        const res = await frame.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button, [role='button']"))
            .filter((b) => !b.disabled && b.offsetParent !== null);
          const label = (b) => (b.innerText || b.textContent || "").trim();
          let btn = btns.find((b) => /^export$/i.test(label(b)));
          if (!btn) btn = btns.find((b) => /^export\b/i.test(label(b)) && !/flat\s*rate/i.test(label(b)));
          if (btn) { btn.click(); return { clicked: true }; }
          return { clicked: false, labels: btns.map(label).filter(Boolean) };
        });
        if (res.clicked) return { clicked: true };
        if (res.labels && res.labels.length) lastButtonLabels = res.labels;
      } catch { /* frame detached mid-eval */ }
    }
    return { clicked: false };
  };

  let exportClicked = false;
  for (let waited = 0; waited < 15000; waited += 500) {
    if ((await findAndClickExport()).clicked) { exportClicked = true; break; }
    await sleep(500);
  }

  if (!exportClicked) {
    const frameUrls = page.frames().map((f) => f.url()).filter((u) => u && u !== "about:blank");
    const seen = `Visible buttons seen: [${(lastButtonLabels || []).join(", ")}]. Frames: ${frameUrls.length}`;
    if (headless) {
      try { await page.screenshot({ path: "/tmp/hcp-pricebook-fail.png", fullPage: true }); } catch {}
      throw new Error(`Could not find Export button on pricebook page. ${seen} (screenshot: /tmp/hcp-pricebook-fail.png)`);
    }
    console.log(`  ${seen}`);
    await waitForManualStep("  Click the Export button manually, then press Enter...");
  } else {
    await sleep(1500);
  }

  // Some pricebook exports show a confirmation dialog, others just send
  const hasDialog = await page.evaluate(() =>
    !!document.querySelector(".MuiDialog-paper, [role='dialog']")
  );

  if (hasDialog) {
    const sendResult = await page.evaluate(() => {
      const dialog = document.querySelector(".MuiDialog-paper, [role='dialog']") || document;
      const btns = Array.from(dialog.querySelectorAll("button"))
        .filter((b) => !b.disabled && b.offsetParent !== null);
      const label = (b) => (b.innerText || b.textContent || "").trim();

      // Preferred confirm labels seen across HCP pricebook export dialogs.
      // NOTE: for pricebook, clicking "Export" already triggers the email; the
      // resulting dialog is a success acknowledgement whose button reads "Okay".
      const CONFIRM = /^(send\s*file|send\s*export|send\s*to\s*email|send|confirm|export|email\s*file|email|download|submit|okay|ok|got\s*it|done|yes)$/i;
      let btn = btns.find((b) => CONFIRM.test(label(b)));

      // Fallback: click the primary (contained) action button in the dialog,
      // preferring the last one (dialogs put the primary action on the right).
      if (!btn) {
        const contained = btns.filter((b) =>
          /MuiButton-contained|Mui-primary/.test(b.className) &&
          !/^(cancel|close|back|dismiss)$/i.test(label(b))
        );
        btn = contained[contained.length - 1];
      }

      if (btn) { btn.click(); return { clicked: true }; }
      return { clicked: false, labels: btns.map(label) };
    });
    if (!sendResult.clicked) {
      const seen = `Dialog buttons found: [${(sendResult.labels || []).join(", ")}]`;
      if (headless) throw new Error(`Confirmation dialog appeared, but no Send/Confirm button was found. ${seen}`);
      console.log(`  ${seen}`);
      await waitForManualStep("  Click Send/Confirm in the dialog, then press Enter...");
    } else {
      await sleep(1000);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Export: Equipment (Property Profile → download icon)
// ---------------------------------------------------------------------------

async function runEquipmentExport(page, headless) {
  await page.goto(`${BASE}/app/equipment`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await waitForReact(page, 3000);

  // The equipment page has a download icon button in the top-right toolbar area.
  // It's an icon-only button (no visible text label) with an SVG download icon.
  // Strategy: find all icon-only buttons near the top of the page and click the download one.
  const downloadClicked = await page.evaluate(() => {
    // Look for aria-label containing download/export
    const byAriaLabel = document.querySelector(
      'button[aria-label*="download" i], button[aria-label*="export" i], button[title*="download" i]'
    );
    if (byAriaLabel) { byAriaLabel.click(); return "aria-label"; }

    // Look for a button that contains a download SVG path (d attribute with typical download shape)
    const allBtns = Array.from(document.querySelectorAll("button"));
    for (const btn of allBtns) {
      const svg = btn.querySelector("svg");
      if (!svg) continue;
      const text = (btn.innerText || btn.textContent || "").trim();
      if (text.length > 0) continue; // skip labeled buttons — we want icon-only
      // Check if button is near the top of the page (within the header toolbar)
      const rect = btn.getBoundingClientRect();
      if (rect.top < 100 && rect.top > 0) {
        btn.click();
        return "top-icon-button";
      }
    }
    return false;
  });

  if (!downloadClicked) {
    if (headless) throw new Error("Could not find the equipment download button.");
    console.log("  Could not auto-click the equipment download button.");
    await waitForManualStep("  Click the download icon (top-right of the equipment table), then press Enter...");
    return true;
  }

  await sleep(2000);

  // Handle any dialog that appears
  const hasDialog = await page.evaluate(() =>
    !!document.querySelector(".MuiDialog-paper, [role='dialog']")
  );

  if (hasDialog) {
    const sendResult = await page.evaluate(() => {
      const dialog = document.querySelector(".MuiDialog-paper, [role='dialog']") || document;
      const btns = Array.from(dialog.querySelectorAll("button"))
        .filter((b) => !b.disabled && b.offsetParent !== null);
      const label = (b) => (b.innerText || b.textContent || "").trim();
      // Same set as pricebook: the equipment dialog may be a confirm ("Send"/
      // "Download") OR a success acknowledgement ("Okay").
      const CONFIRM = /^(send\s*file|send\s*export|send\s*to\s*email|send|confirm|export|email\s*file|email|download|submit|okay|ok|got\s*it|done|yes)$/i;
      let btn = btns.find((b) => CONFIRM.test(label(b)));
      if (!btn) {
        const contained = btns.filter((b) =>
          /MuiButton-contained|Mui-primary/.test(b.className) &&
          !/^(cancel|close|back|dismiss)$/i.test(label(b))
        );
        btn = contained[contained.length - 1];
      }
      if (btn) { btn.click(); return { clicked: true }; }
      return { clicked: false, labels: btns.map(label) };
    });
    if (!sendResult.clicked) {
      const seen = `Dialog buttons found: [${(sendResult.labels || []).join(", ")}]`;
      if (headless) throw new Error(`Equipment confirmation dialog appeared, but no Send/Confirm/Download button was found. ${seen}`);
      console.log(`  ${seen}`);
      await waitForManualStep("  Click Send/Confirm/Download in the dialog, then press Enter...");
    } else {
      await sleep(1000);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Export: Invoice line items (local XLSX, no email export)
// ---------------------------------------------------------------------------

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseMoneyToCents(value) {
  if (value === null || value === undefined || value === "") return "";
  const raw = String(value).trim();
  const negative = raw.includes("(") && raw.includes(")") || raw.startsWith("-");
  const number = Number(raw.replace(/[$,\s()]/g, ""));
  if (!Number.isFinite(number)) return "";
  return Math.round(Math.abs(number) * 100) * (negative ? -1 : 1);
}

function invoiceStatusFilterValues() {
  const raw =
    getArgValue(["--invoice-statuses"]) ??
    process.env.HOUSECALLPRO_INVOICE_STATUSES ??
    "";
  return String(raw)
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
}

function buildInvoiceListUrl({ pageNumber, pageSize, statuses }) {
  const params = new URLSearchParams();
  if (statuses.length > 0) {
    params.append("filters[][operator]", "eq");
    params.append("filters[][property]", "status");
    for (const status of statuses) params.append("filters[][values][]", status);
  }
  params.set("sort_by", "invoice_number");
  params.set("sort_direction", "desc");
  params.set("page_size", String(pageSize));
  params.set("page", String(pageNumber));
  return `${BASE}/api/invoices/v1/invoices?${params.toString()}`;
}

async function fetchJsonInPage(page, url) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok && response.status !== 304) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return response.json();
  }, url);
}

async function fetchAllInvoices(page) {
  const pageSize = Math.max(
    1,
    getIntegerOption(["--invoice-page-size"], "HOUSECALLPRO_INVOICE_PAGE_SIZE", 100)
  );
  const maxInvoices = getIntegerOption(
    ["--invoice-max-invoices"],
    "HOUSECALLPRO_INVOICE_MAX_INVOICES",
    0
  );
  const statuses = invoiceStatusFilterValues();

  const firstUrl = buildInvoiceListUrl({ pageNumber: 1, pageSize, statuses });
  const firstPage = await fetchJsonInPage(page, firstUrl);
  const totalPages = Number(firstPage.total_pages_count || 1);
  const totalCount = Number(firstPage.total_count || firstPage.data?.length || 0);
  const invoices = Array.isArray(firstPage.data) ? [...firstPage.data] : [];

  console.log(
    `  Invoice API total: ${totalCount} invoice(s), ${totalPages} page(s)` +
      (statuses.length ? `, statuses: ${statuses.join(", ")}` : ", statuses: all")
  );

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    if (maxInvoices && invoices.length >= maxInvoices) break;
    const url = buildInvoiceListUrl({ pageNumber, pageSize, statuses });
    const json = await fetchJsonInPage(page, url);
    if (Array.isArray(json.data)) invoices.push(...json.data);
    console.log(`  Invoice list page ${pageNumber}/${totalPages}: ${invoices.length} collected`);
  }

  return maxInvoices ? invoices.slice(0, maxInvoices) : invoices;
}

async function fetchInvoicePreviewLineItems(page, invoice) {
  const invoiceId = invoice.uuid || invoice.id;
  if (!invoiceId) throw new Error("Invoice record had no id/uuid.");

  const previewUrl = `${BASE}/api/invoices/v1/invoices/${invoiceId}/preview.html?include_global_scss=false`;
  const parsed = await page.evaluate(async (previewUrl) => {
    const response = await fetch(previewUrl, {
      credentials: "include",
      headers: { Accept: "text/html" },
    });
    const html = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        contentType: response.headers.get("content-type") || "",
        htmlBytes: html.length,
        error: html.slice(0, 300),
        lineItems: [],
        totals: {},
        fields: {},
      };
    }

    const doc = new DOMParser().parseFromString(html, "text/html");
    const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
    const bodyText = clean(doc.body?.innerText || doc.body?.textContent || "");
    const between = (start, end) => {
      const pattern = new RegExp(`${start}\\s+([\\s\\S]*?)\\s+${end}`, "i");
      const match = bodyText.match(pattern);
      return match ? clean(match[1]) : "";
    };

    const lineItems = [];
    for (const table of Array.from(doc.querySelectorAll("table.invoice-table"))) {
      const rowTexts = Array.from(table.querySelectorAll("tr"))
        .map((tr) =>
          Array.from(tr.querySelectorAll("th,td"))
            .map((cell) => clean(cell.innerText || cell.textContent))
            .filter(Boolean)
        )
        .filter((cells) => cells.length > 0);
      if (rowTexts.length < 2) continue;

      const section = rowTexts[0]?.[0] || "";
      // Identify columns by VALUE, not header position (invoice tables vary):
      // the trailing cells of a data row are [ ...name, qty, unit price, amount ]
      // where amount and unit price are money and qty is a bare number. Peel
      // them off the end so we capture REAL quantities and unit prices.
      const isMoney = (s) => /^\(?-?\$?\s*[\d,]+\.\d{2}\)?$/.test(String(s).trim());
      const isQty = (s) => /^-?\d+(\.\d+)?$/.test(String(s).trim());
      let current = null;
      for (const cells of rowTexts.slice(1)) {
        if (cells.length >= 2) {
          let end = cells.length;
          let amount = "";
          let unit = "";
          let qty = "";
          if (isMoney(cells[end - 1])) { amount = cells[end - 1]; end -= 1; }
          if (end - 1 >= 1 && isMoney(cells[end - 1])) { unit = cells[end - 1]; end -= 1; }
          if (end - 1 >= 1 && isQty(cells[end - 1])) { qty = cells[end - 1]; end -= 1; }
          const name = cells.slice(0, Math.max(1, end)).join(" ");
          current = {
            section,
            name,
            description: "",
            quantity: qty,
            unit_price: unit,
            amount,
            raw_cells: cells,
          };
          lineItems.push(current);
        } else if (cells.length === 1 && current) {
          current.description = [current.description, cells[0]].filter(Boolean).join("\n");
        } else if (cells.length === 1) {
          lineItems.push({
            section,
            name: "",
            description: cells[0],
            amount: "",
            raw_cells: cells,
          });
        }
      }
    }

    const totals = {};
    const totalsTable = doc.querySelector("table.invoice-totals-table");
    if (totalsTable) {
      for (const tr of Array.from(totalsTable.querySelectorAll("tr"))) {
        const cells = Array.from(tr.querySelectorAll("th,td"))
          .map((cell) => clean(cell.innerText || cell.textContent))
          .filter(Boolean);
        if (cells.length >= 2) totals[cells[0]] = cells[cells.length - 1];
      }
    }

    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      htmlBytes: html.length,
      error: "",
      lineItems,
      totals,
      fields: {
        service_date: between("SERVICE DATE", "PAYMENT TERMS"),
        payment_terms: between("PAYMENT TERMS", "Amount Due"),
      },
    };
  }, previewUrl);

  return { invoiceId, previewUrl, ...parsed };
}

function invoiceMetadata(invoice) {
  return {
    invoice_id: invoice.uuid || invoice.id || "",
    invoice_number: invoice.invoice_number || "",
    invoice_status: invoice.status || "",
    invoice_created_at: invoice.created_at || "",
    invoice_due_at: invoice.due_at || "",
    invoice_amount_cents: invoice.amount ?? "",
    invoice_amount: invoice.amount === null || invoice.amount === undefined ? "" : Number(invoice.amount) / 100,
    amount_due_cents: invoice.due_amount ?? "",
    amount_due: invoice.due_amount === null || invoice.due_amount === undefined ? "" : Number(invoice.due_amount) / 100,
    customer_id: invoice.customer_uuid || "",
    customer_name: invoice.customer_display_name || "",
    customer_email: invoice.customer_email || "",
    customer_phone: invoice.customer_phone_number || "",
    job_number: invoice.external_reference || "",
    job_reference_name: invoice.external_reference_name || "",
    billing_address: invoice.billing_address || "",
    service_address: invoice.service_address || "",
    service_address_street: invoice.service_address_street || "",
    service_address_city: invoice.service_address_city || "",
    service_address_state: invoice.service_address_state || "",
    service_address_zip_code: invoice.service_address_zip_code || "",
  };
}

function numberOrBlank(value) {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "";
}

function dateOnly(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

// HCP invoice line-item text often contains emojis (✅ inspection checklists,
// etc.) copied from the tech's notes. Strip them for the invoice export.
function stripEmoji(text) {
  return String(text ?? "")
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function lineItemPayloadFromPreview(lineItem) {
  // Prefer the real qty + unit-price columns from the preview table. Fall back
  // to qty 1 with unit_price = line amount when those columns aren't present,
  // so unit_price * quantity always equals the line total.
  const qtyRaw = Number(String(lineItem.quantity ?? "").replace(/[^\d.\-]/g, ""));
  const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
  const unitFromColumn = String(lineItem.unit_price ?? "").trim()
    ? parseMoneyToCents(lineItem.unit_price)
    : "";
  const amountCents = parseMoneyToCents(lineItem.amount);
  let unitPrice;
  if (unitFromColumn !== "" && unitFromColumn !== 0) {
    unitPrice = unitFromColumn;
  } else if (amountCents !== "" && quantity > 1) {
    // Only a line total is available; derive per-unit so qty*unit = line total.
    unitPrice = Math.round(amountCents / quantity);
  } else {
    unitPrice = amountCents === "" ? 0 : amountCents;
  }
  const payload = {
    name: stripEmoji(lineItem.name || lineItem.section || "Imported line item").slice(0, 255) || "Imported line item",
    quantity,
    unit_price: unitPrice,
  };
  if (lineItem.description) {
    const desc = stripEmoji(lineItem.description);
    if (desc) payload.description = desc;
  }
  return payload;
}

function syntheticInvoiceLineItemPayload(meta) {
  const amountCents = numberOrBlank(meta.invoice_amount_cents);
  return {
    name: "Imported total",
    quantity: 1,
    unit_price: amountCents === "" ? 0 : amountCents,
  };
}

function invoiceUploadRow({ meta, parsed, lineItems }) {
  const payload = lineItems.length > 0
    ? lineItems.map(lineItemPayloadFromPreview)
    : [syntheticInvoiceLineItemPayload(meta)];
  const subtotalCents = payload.reduce(
    (sum, item) => sum + Math.round(Number(item.unit_price || 0) * Number(item.quantity || 1)),
    0
  );
  const totalCents = numberOrBlank(meta.invoice_amount_cents);

  return {
    invoice_number: meta.invoice_number,
    status: meta.invoice_status,
    job_id: meta.job_number,
    customer_name: meta.customer_name,
    customer_email: meta.customer_email,
    customer_phone: meta.customer_phone,
    total_cents: totalCents === "" ? subtotalCents : totalCents,
    subtotal_cents: subtotalCents,
    issue_date: dateOnly(meta.invoice_created_at),
    due_date: dateOnly(meta.invoice_due_at),
    payment_terms: parsed?.fields?.payment_terms || "",
    line_items_json: JSON.stringify(payload),
  };
}

// Adds the single clean "Invoices" tab (with line_items_json) to a workbook.
// The old "Invoice Metadata" and "Review" helper tabs are intentionally omitted.
function addInvoiceSheet(workbook, invoiceRows) {
  const invoiceSheet = workbook.addWorksheet("Invoices");
  invoiceSheet.columns = [
    { header: "invoice_number", key: "invoice_number", width: 18 },
    { header: "status", key: "status", width: 16 },
    { header: "job_id", key: "job_id", width: 18 },
    { header: "customer_name", key: "customer_name", width: 28 },
    { header: "customer_email", key: "customer_email", width: 30 },
    { header: "customer_phone", key: "customer_phone", width: 18 },
    { header: "total_cents", key: "total_cents", width: 14 },
    { header: "subtotal_cents", key: "subtotal_cents", width: 16 },
    { header: "issue_date", key: "issue_date", width: 14 },
    { header: "due_date", key: "due_date", width: 14 },
    { header: "payment_terms", key: "payment_terms", width: 18 },
    { header: "line_items_json", key: "line_items_json", width: 80 },
  ];
  invoiceSheet.addRows(invoiceRows);
  invoiceSheet.getRow(1).font = { bold: true };
  invoiceSheet.views = [{ state: "frozen", ySplit: 1 }];
}

function buildEstimateListUrl({ pageNumber, pageSize }) {
  const params = new URLSearchParams();
  params.append("filters[][property]", "work_status");
  params.append("filters[][operator]", "eq");
  for (const status of ["unscheduled", "scheduled", "in_progress", "completed", "copied_to_job"]) {
    params.append("filters[][values][]", status);
  }
  for (const expansion of ["customer", "tax", "analytics"]) {
    params.append("expand[]", expansion);
  }
  params.set("sortAttribute", "invoice_number");
  params.set("sortDirection", "desc");
  params.set("sort_by", "invoice_number");
  params.set("sort_direction", "desc");
  params.set("page_size", String(pageSize));
  params.set("page", String(pageNumber));
  params.set("time_zone", Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Denver");
  return `${BASE}/beta/estimates?${params.toString()}`;
}

async function fetchAllEstimates(page) {
  const pageSize = Math.max(
    1,
    getIntegerOption(["--estimate-page-size"], "HOUSECALLPRO_ESTIMATE_PAGE_SIZE", 100)
  );
  const maxEstimates = getIntegerOption(
    ["--estimate-max-estimates"],
    "HOUSECALLPRO_ESTIMATE_MAX_ESTIMATES",
    0
  );

  const firstPage = await fetchJsonInPage(page, buildEstimateListUrl({ pageNumber: 1, pageSize }));
  const totalPages = Number(firstPage.total_pages_count || 1);
  const totalCount = Number(firstPage.total_count || firstPage.data?.length || 0);
  const estimates = Array.isArray(firstPage.data) ? [...firstPage.data] : [];

  console.log(`  Estimate API total: ${totalCount} estimate(s), ${totalPages} page(s)`);

  for (let pageNumber = 2; pageNumber <= totalPages; pageNumber += 1) {
    if (maxEstimates && estimates.length >= maxEstimates) break;
    const json = await fetchJsonInPage(page, buildEstimateListUrl({ pageNumber, pageSize }));
    if (Array.isArray(json.data)) estimates.push(...json.data);
    console.log(`  Estimate list page ${pageNumber}/${totalPages}: ${estimates.length} collected`);
  }

  return maxEstimates ? estimates.slice(0, maxEstimates) : estimates;
}

async function fetchEstimateDetail(page, estimate) {
  const estimateId = estimate.estimate_uuid || estimate.uuid || estimate.id;
  if (!estimateId) throw new Error("Estimate record had no id/uuid.");
  const detailUrl = `${BASE}/api/estimates/${estimateId}`;
  const detail = await fetchJsonInPage(page, detailUrl);
  return { estimateId, detailUrl, detail };
}

// The estimate's linked job number ("Copied to Job #…") is NOT in the estimate
// detail API — it lives in the estimate page's data feed under
// corresponding_jobs[].number. Returns "" when the estimate hasn't produced a
// job. Uses estimate.id (the "best_…"/"est_…" form) which this endpoint keys on.
async function fetchEstimateJobNumber(page, estimate) {
  const id = estimate.id || estimate.estimate_uuid || estimate.uuid;
  if (!id) return "";
  try {
    const data = await fetchJsonInPage(page, `${BASE}/pro/jobs/react/${id}/data`);
    const text = JSON.stringify(data);
    const match = text.match(/"corresponding_jobs":\s*\[\s*\{[^]*?"number":"(\d+)"/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function hcpCents(value) {
  if (value === null || value === undefined || value === "") return "";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : "";
}

function normalizeEstimateStatus(value) {
  const text = String(value || "").toLowerCase();
  if (/declin|reject|lost|cancel/.test(text)) return "rejected";
  if (/approv|accept|won|sold/.test(text)) return "approved";
  return "draft";
}

function estimateCustomer(summary, detail) {
  const customer = detail?.customer || summary?.customer?.data || {};
  return {
    customer_name:
      customer.full_name ||
      customer.display_name ||
      customer.billable_name ||
      summary.customer_name ||
      "",
    customer_email:
      customer.billable_email ||
      customer.email ||
      summary.customer_billable_email ||
      summary.customer?.data?.billable_email ||
      summary.customer?.data?.email ||
      "",
    customer_phone:
      customer.billable_phone_number ||
      customer.mobile_number ||
      customer.home_number ||
      summary.customer_phone_number ||
      summary.customer?.data?.billable_phone_number ||
      summary.customer?.data?.mobile_number ||
      "",
  };
}

function estimateLineItemPayload(lineItem) {
  const unitPrice = hcpCents(lineItem.unit_price_cents ?? lineItem.amount_cents);
  const quantity = Number(lineItem.quantity ?? 1);
  const payload = {
    name: (lineItem.name || lineItem.kind || "Imported line item").slice(0, 255),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    unit_price: unitPrice === "" ? 0 : unitPrice,
  };
  if (lineItem.description) payload.description = lineItem.description;
  if (typeof lineItem.taxable === "boolean") payload.taxable = lineItem.taxable;
  return payload;
}

function syntheticEstimateLineItemPayload(option, summary) {
  const amountCents = hcpCents(
    option?.totals?.total_amount ??
      option?.totals?.sub_total ??
      option?.total_amount ??
      option?.sub_total ??
      summary?.value
  );
  return {
    name: "Imported estimate total",
    quantity: 1,
    unit_price: amountCents === "" ? 0 : amountCents,
  };
}

function estimateOptionRows({ summary, detail, jobNumber = "" }) {
  const estimateId = detail?.uuid || summary.estimate_uuid || summary.id || "";
  const estimateNumber = detail?.invoice_number || summary.display_invoice_number || summary.invoice_number || "";
  const options = Array.isArray(detail?.options) && detail.options.length
    ? detail.options
    : Array.isArray(summary.options) && summary.options.length
      ? summary.options
      : [null];
  const customer = estimateCustomer(summary, detail);
  const estimateRows = [];
  const lineRows = [];

  options.forEach((option, optionIndex) => {
    const optionId = option?.uuid || option?.id || `${estimateId}-${optionIndex + 1}`;
    const rawLineItems = Array.isArray(option?.line_items)
      ? option.line_items.filter((item) => item && (item.kind !== "tax" || Number(item.amount_cents || 0) !== 0))
      : [];
    const payload = rawLineItems.length
      ? rawLineItems.map(estimateLineItemPayload)
      : [syntheticEstimateLineItemPayload(option, summary)];
    const subtotalFromItems = payload.reduce(
      (sum, item) => sum + Math.round(Number(item.unit_price || 0) * Number(item.quantity || 1)),
      0
    );
    const subtotalCents = hcpCents(option?.totals?.sub_total ?? option?.sub_total);
    const totalCents = hcpCents(option?.totals?.total_amount ?? option?.total_amount);
    const resolvedSubtotal = subtotalCents === "" ? subtotalFromItems : subtotalCents;
    const resolvedTotal = totalCents === "" ? resolvedSubtotal : totalCents;
    const optionName = option?.name || `Option ${optionIndex + 1}`;
    const description = option?.description || option?.option_description || detail?.description || summary.description || "";

    estimateRows.push({
      name: `${estimateNumber || estimateId} - ${optionName}`.slice(0, 255),
      external_estimate_id: optionId,
      job_id: jobNumber || "",
      customer_name: customer.customer_name,
      customer_email: customer.customer_email,
      customer_phone: customer.customer_phone,
      total_cents: resolvedTotal,
      subtotal_cents: resolvedSubtotal,
      valid_until: dateOnly(detail?.expiration_date),
      estimate_status: normalizeEstimateStatus(option?.status || summary.outcome || detail?.status),
      notes: [description, option?.summary || "", option?.message_from_pro || ""].filter(Boolean).join("\n"),
      line_items_json: JSON.stringify(payload),
    });

    payload.forEach((lineItem, lineIndex) => {
      const raw = rawLineItems[lineIndex] || {};
      lineRows.push({
        estimate_id: estimateId,
        estimate_number: estimateNumber,
        option_id: optionId,
        option_name: optionName,
        line_index: lineIndex + 1,
        line_uuid: raw.uuid || "",
        name: lineItem.name,
        description: lineItem.description || "",
        quantity: lineItem.quantity,
        unit_price_cents: lineItem.unit_price,
        taxable: lineItem.taxable ?? "",
        kind: raw.kind || "",
        service_item_uuid: raw.service_item_uuid || "",
      });
    });
  });

  return { estimateRows, lineRows };
}

function estimateMetadata(estimate) {
  return {
    estimate_id: estimate.estimate_uuid || estimate.id || "",
    estimate_number: estimate.display_invoice_number || estimate.invoice_number || "",
    customer_id: estimate.customer_uuid || "",
    customer_name: estimate.customer_name || "",
    customer_email: estimate.customer_billable_email || estimate.customer?.data?.billable_email || "",
    customer_phone: estimate.customer_phone_number || "",
    created_at: estimate.created_at || "",
    outcome: estimate.outcome || "",
    value_cents: estimate.value ?? "",
    options_count: Array.isArray(estimate.options) ? estimate.options.length : "",
    address: estimate.address || estimate.request_address || "",
    description: estimate.description || "",
  };
}

// Adds the single clean "Estimates" tab (with line_items_json) to a workbook.
// The old "Estimate Line Items", "Estimate Metadata" and "Review" helper tabs
// are intentionally omitted — per-item detail lives inside line_items_json.
function addEstimateSheet(workbook, estimateRows) {
  const estimateSheet = workbook.addWorksheet("Estimates");
  estimateSheet.columns = [
    { header: "name", key: "name", width: 32 },
    { header: "external_estimate_id", key: "external_estimate_id", width: 36 },
    { header: "job_id", key: "job_id", width: 18 },
    { header: "customer_name", key: "customer_name", width: 28 },
    { header: "customer_email", key: "customer_email", width: 30 },
    { header: "customer_phone", key: "customer_phone", width: 18 },
    { header: "total_cents", key: "total_cents", width: 14 },
    { header: "subtotal_cents", key: "subtotal_cents", width: 16 },
    { header: "valid_until", key: "valid_until", width: 14 },
    { header: "estimate_status", key: "estimate_status", width: 16 },
    { header: "notes", key: "notes", width: 50 },
    { header: "line_items_json", key: "line_items_json", width: 80 },
  ];
  estimateSheet.addRows(estimateRows);
  estimateSheet.getRow(1).font = { bold: true };
  estimateSheet.views = [{ state: "frozen", ySplit: 1 }];
}

// Collects invoice/estimate rows across the run so both land in ONE workbook
// with two tabs (Invoices + Estimates) instead of two separate files.
const combinedWorkbook = { invoiceRows: null, estimateRows: null };

async function writeCombinedWorkbook(outputPath) {
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "HouseCall Pro Exporter";
  workbook.created = new Date();
  if (combinedWorkbook.invoiceRows) addInvoiceSheet(workbook, combinedWorkbook.invoiceRows);
  if (combinedWorkbook.estimateRows) addEstimateSheet(workbook, combinedWorkbook.estimateRows);
  await workbook.xlsx.writeFile(outputPath);
}

// Run `worker` over items with bounded concurrency, preserving result order.
// Concurrent page.evaluate fetches interleave on the browser event loop, so
// this gives real network parallelism even on a single page.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, run));
  return results;
}

const DETAIL_CONCURRENCY = Math.max(
  1,
  getIntegerOption(["--detail-concurrency"], "HOUSECALLPRO_DETAIL_CONCURRENCY", 6)
);

async function runEstimateLineItemsExport(page) {
  const outputDir = path.resolve(process.env.HOUSECALLPRO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
  ensureDirectory(outputDir);

  await page.goto(`${BASE}/app/customers/estimates`, { waitUntil: "networkidle2", timeout: 45000 });
  await sleep(1000);

  const estimates = await fetchAllEstimates(page);
  const estimateRows = [];
  const lineRows = [];
  const reviewRows = [];

  console.log(`  Fetching detail line items for ${estimates.length} estimate(s) (${DETAIL_CONCURRENCY} workers)...`);
  const details = await mapLimit(estimates, DETAIL_CONCURRENCY, async (summary) => {
    try {
      const { detailUrl, detail } = await fetchEstimateDetail(page, summary);
      const jobNumber = await fetchEstimateJobNumber(page, summary);
      return { summary, detailUrl, detail, jobNumber, error: null };
    } catch (error) {
      return { summary, detailUrl: null, detail: null, jobNumber: "", error };
    }
  });

  for (let index = 0; index < details.length; index += 1) {
    const { summary, detailUrl, detail, jobNumber, error } = details[index];
    const estimateId = summary.estimate_uuid || summary.id || "";
    if (!error) {
      const rows = estimateOptionRows({ summary, detail, jobNumber });
      estimateRows.push(...rows.estimateRows);
      lineRows.push(...rows.lineRows);
      if (rows.lineRows.length === 0) {
        reviewRows.push({
          estimate_id: estimateId,
          estimate_number: summary.display_invoice_number || summary.invoice_number || "",
          status: "no_line_items",
          message: "Detail loaded but no option line items were found; used option totals where available.",
          detail_url: detailUrl,
        });
      }
    } else {
      const rows = estimateOptionRows({ summary, detail: null, jobNumber });
      estimateRows.push(...rows.estimateRows);
      lineRows.push(...rows.lineRows);
      reviewRows.push({
        estimate_id: estimateId,
        estimate_number: summary.display_invoice_number || summary.invoice_number || "",
        status: "error",
        message: error.message,
        detail_url: estimateId ? `${BASE}/api/estimates/${estimateId}` : "",
      });
    }

    if ((index + 1) % 25 === 0 || index + 1 === details.length) {
      console.log(`  Estimate details checked: ${index + 1}/${details.length}; estimate rows ${estimateRows.length}; line rows ${lineRows.length}; review ${reviewRows.length}`);
    }
  }

  // Stash rows so main() can write ONE workbook with both Invoices + Estimates.
  combinedWorkbook.estimateRows = estimateRows;
  console.log(`  Estimate rows: ${estimateRows.length}; line rows: ${lineRows.length}; estimates checked: ${estimates.length}; review rows: ${reviewRows.length}`);
  return true;
}

async function runInvoiceLineItemsExport(page) {
  const outputDir = path.resolve(process.env.HOUSECALLPRO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
  ensureDirectory(outputDir);

  await page.goto(`${BASE}/app/home`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1000);

  const invoices = await fetchAllInvoices(page);
  const invoiceRows = [];
  const lineRows = [];
  const reviewRows = [];

  console.log(`  Fetching preview line items for ${invoices.length} invoice(s) (${DETAIL_CONCURRENCY} workers)...`);
  const previews = await mapLimit(invoices, DETAIL_CONCURRENCY, async (invoice) => {
    const meta = invoiceMetadata(invoice);
    try {
      const parsed = await fetchInvoicePreviewLineItems(page, invoice);
      return { meta, parsed, error: null };
    } catch (error) {
      return { meta, parsed: null, error };
    }
  });

  for (let index = 0; index < previews.length; index += 1) {
    const { meta, parsed, error } = previews[index];
    try {
      if (error) throw error;
      if (!parsed.ok) {
        invoiceRows.push(invoiceUploadRow({ meta, parsed, lineItems: [] }));
        reviewRows.push({
          invoice_id: meta.invoice_id,
          invoice_number: meta.invoice_number,
          status: `HTTP ${parsed.status}`,
          message: parsed.error || "Preview fetch failed",
          preview_url: parsed.previewUrl,
        });
      } else if (parsed.lineItems.length === 0) {
        invoiceRows.push(invoiceUploadRow({ meta, parsed, lineItems: [] }));
        reviewRows.push({
          invoice_id: meta.invoice_id,
          invoice_number: meta.invoice_number,
          status: "no_line_items",
          message: "Preview loaded but no Services/Materials line-item tables were found.",
          preview_url: parsed.previewUrl,
        });
      } else {
        invoiceRows.push(invoiceUploadRow({ meta, parsed, lineItems: parsed.lineItems }));
        parsed.lineItems.forEach((lineItem, lineIndex) => {
          const amountCents = parseMoneyToCents(lineItem.amount);
          lineRows.push({
            ...meta,
            service_date: parsed.fields?.service_date || "",
            section: lineItem.section,
            line_index: lineIndex + 1,
            name: lineItem.name,
            description: lineItem.description,
            quantity: 1,
            unit_price: lineItem.amount,
            unit_price_cents: amountCents,
            line_total: lineItem.amount,
            line_total_cents: amountCents,
            taxable: "",
            preview_url: parsed.previewUrl,
          });
        });
      }
    } catch (error) {
      invoiceRows.push(invoiceUploadRow({ meta, parsed: null, lineItems: [] }));
      reviewRows.push({
        invoice_id: meta.invoice_id,
        invoice_number: meta.invoice_number,
        status: "error",
        message: error.message,
        preview_url: meta.invoice_id
          ? `${BASE}/api/invoices/v1/invoices/${meta.invoice_id}/preview.html?include_global_scss=false`
          : "",
      });
    }

    if ((index + 1) % 25 === 0 || index + 1 === invoices.length) {
      console.log(`  Invoice previews checked: ${index + 1}/${invoices.length}; line rows ${lineRows.length}; review ${reviewRows.length}`);
    }
  }

  // Stash rows so main() can write ONE workbook with both Invoices + Estimates.
  combinedWorkbook.invoiceRows = invoiceRows;
  console.log(`  Invoice rows: ${invoiceRows.length}; line rows: ${lineRows.length}; invoices checked: ${invoices.length}; review rows: ${reviewRows.length}`);
  return true;
}

// ---------------------------------------------------------------------------
// Run one export
// ---------------------------------------------------------------------------

async function runExport(page, key, definition, headless) {
  const { label, type } = definition;
  console.log(`\n── ${label} ──`);

  switch (type) {
    case "actions-menu":
      return runActionsMenuExport(page, definition, headless);
    case "pricebook-tab":
      return runPricebookExport(page, definition, headless);
    case "equipment":
      return runEquipmentExport(page, headless);
    case "invoice-line-items":
      return runInvoiceLineItemsExport(page);
    case "estimate-line-items":
      return runEstimateLineItemsExport(page);
    default:
      throw new Error(`Unknown export type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const sessionDir = getArgValue(["--session-dir"]) || process.env.HOUSECALLPRO_SESSION_DIR || DEFAULT_SESSION_DIR;
  const headless = getFlag("--headless") || getBooleanEnv("HEADLESS", false);
  const exportKeys = resolveExportKeys();

  console.log("HouseCall Pro Exporter");
  console.log(`Categories : ${exportKeys.join(", ")}`);
  console.log(`Headless   : ${headless}`);
  console.log(`Note       : Invoice and estimate line items are written locally; other categories use HCP email exports.\n`);

  const executablePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined;
  const browser = await puppeteer.launch({
    headless,
    executablePath,
    userDataDir: sessionDir,
    defaultViewport: { width: 1440, height: 900 },
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const [page] = await browser.pages();
  page.setDefaultTimeout(30000);

  try {
    await ensureLoggedIn(page, headless);

    console.log("\nDetecting company name...");
    const customerName = await detectCustomerName(page);
    if (!process.env.HOUSECALLPRO_CUSTOMER_NAME) process.env.HOUSECALLPRO_CUSTOMER_NAME = customerName;
    console.log(`Company: ${customerName}`);
    console.log(`Note: Use --only invoices,estimates to avoid HCP email-export triggers.\n`);

    const results = [];

    for (const key of exportKeys) {
      const definition = EXPORT_DEFINITIONS[key];
      try {
        await runExport(page, key, definition, headless);
        const localWorkbook = ["invoice-line-items", "estimate-line-items"].includes(definition.type);
        const successMessage =
          localWorkbook ? "Local workbook created." : "Export triggered.";
        console.log(`  ✓ ${successMessage}`);
        results.push({ key, label: definition.label, ok: true });
      } catch (err) {
        console.error(`  ✗ Error: ${err.message}`);
        results.push({ key, label: definition.label, ok: false, error: err.message });
      }
    }

    // Write the single combined workbook (Invoices + Estimates tabs) if either
    // local category produced rows.
    if (combinedWorkbook.invoiceRows || combinedWorkbook.estimateRows) {
      const outputDir = path.resolve(process.env.HOUSECALLPRO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);
      ensureDirectory(outputDir);
      const safeName = (process.env.HOUSECALLPRO_CUSTOMER_NAME || "HouseCall Pro Customer")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const wbPath = path.join(outputDir, `${safeName} - HouseCall Pro.xlsx`);
      await writeCombinedWorkbook(wbPath);
      const tabs = [
        combinedWorkbook.invoiceRows ? "Invoices" : null,
        combinedWorkbook.estimateRows ? "Estimates" : null,
      ].filter(Boolean).join(" + ");
      console.log(`\nSaved combined workbook (${tabs}): ${wbPath}`);
    }

    const email = process.env.HOUSECALLPRO_EMAIL || "your registered email";

    console.log("\n── Summary ──");
    for (const r of results) {
      const icon = r.ok ? "✓" : "✗";
      const localWorkbook = ["invoice-line-items", "estimate-line-items"].includes(EXPORT_DEFINITIONS[r.key]?.type);
      const note = r.ok
        ? (localWorkbook ? "local workbook saved" : "email queued")
        : `failed — ${r.error}`;
      console.log(`  ${icon} ${r.label}: ${note}`);
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      console.warn(
        `\n${failed.length} export(s) failed. Retry with: --only ${failed.map((r) => r.key).join(",")}`
      );
    } else {
      const emailTriggered = results.some(
        (r) => r.ok && !["invoice-line-items", "estimate-line-items"].includes(EXPORT_DEFINITIONS[r.key]?.type)
      );
      if (emailTriggered) {
        console.log(`\nCompleted selected exports for ${customerName}. Check ${email} for email-triggered CSV categories.`);
      } else {
        console.log(`\nCompleted selected exports for ${customerName}. Local files were written to ${process.env.HOUSECALLPRO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR}.`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
