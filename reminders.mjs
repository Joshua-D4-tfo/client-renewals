import nodemailer from "nodemailer";
import { getStore } from "@netlify/blobs";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

// Column headings exactly as they appear in row 1 of the sheet (case-insensitive).
const HEADERS = {
  ubo: "ubo/shareholder name",
  corporate: "corporate name",
  type: "type of corporate",
  issued: "date of license issuance",
  authority: "authority involved",
};

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_LOOKUP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ */
/* Date helpers (all dates are handled as UTC midnight)                */
/* ------------------------------------------------------------------ */

function utcDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

// Reads the issuance date. The sheet uses MM/DD/YYYY (e.g. 03/03/2026 is
// 3 March 2026). Any entry that is not a valid MM/DD date, such as 25/09/2025,
// is rejected and flagged on the dashboard as "Date not recognised" rather
// than guessed. ISO dates (2026-03-03) and written dates (03 Mar 2026) are
// also accepted.
export function parseIssuanceDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return utcDate(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
  if (m) {
    const month = +m[1];
    const day = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    return utcDate(y, month, day); // MM/DD/YYYY
  }

  m = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]+)[\s\-,]+(\d{2}|\d{4})$/);
  if (m) {
    const month = MONTH_LOOKUP[m[2].slice(0, 3).toLowerCase()];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (month) return utcDate(y, month, +m[1]);
  }

  return null;
}

function addMonthsClamped(date, months) {
  const day = date.getUTCDate();
  const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
}

// Renewal date: one full year after issuance, less one day.
export function renewalFromIssuance(issued) {
  return new Date(addMonthsClamped(issued, 12).getTime() - DAY_MS);
}

// Reminder date: exactly one calendar month before the renewal date.
export function reminderFromRenewal(renewal) {
  return addMonthsClamped(renewal, -1);
}

export function todayInDubai() {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = s.split("-").map(Number);
  return utcDate(y, m, d);
}

export function toIso(d) {
  return d ? d.toISOString().slice(0, 10) : null;
}

function fromIso(s) {
  const [y, m, d] = s.split("-").map(Number);
  return utcDate(y, m, d);
}

export function longDate(d) {
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ------------------------------------------------------------------ */
/* Sheet loading                                                       */
/* ------------------------------------------------------------------ */

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function loadEntities() {
  const url = process.env.SHEET_CSV_URL;
  if (!url) throw new Error("SHEET_CSV_URL is not set in the Netlify environment variables.");

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`The sheet could not be fetched (HTTP ${res.status}).`);

  const rows = parseCsv(await res.text());
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [key, label] of Object.entries(HEADERS)) {
    idx[key] = header.indexOf(label);
    if (idx[key] === -1) throw new Error(`The column "${label}" was not found in row 1 of the sheet.`);
  }

  const today = todayInDubai();

  const entities = rows
    .slice(1)
    .map((r, i) => ({ r, rowNumber: i + 2 }))
    .filter(({ r }) => r.some((c) => c.trim()))
    .map(({ r, rowNumber }) => {
      const get = (key) => (r[idx[key]] || "").trim();
      const issuedRaw = get("issued");
      const issued = parseIssuanceDate(issuedRaw);
      const renewal = issued ? renewalFromIssuance(issued) : null;
      const reminder = renewal ? reminderFromRenewal(renewal) : null;

      let status;
      if (!issuedRaw) status = "missing";
      else if (!issued) status = "invalid";
      else if (today > renewal) status = "overdue";
      else if (today >= reminder) status = "due";
      else status = "upcoming";

      return {
        rowNumber,
        ubo: get("ubo"),
        corporate: get("corporate"),
        type: get("type"),
        authority: get("authority"),
        issuedRaw,
        issued: toIso(issued),
        renewal: toIso(renewal),
        reminder: toIso(reminder),
        daysToRenewal: renewal ? Math.round((renewal - today) / DAY_MS) : null,
        daysToReminder: reminder ? Math.round((reminder - today) / DAY_MS) : null,
        status,
      };
    });

  // Soonest reminder date first; rows without a usable date go to the bottom.
  entities.sort((a, b) => {
    if (!a.reminder && !b.reminder) return a.rowNumber - b.rowNumber;
    if (!a.reminder) return 1;
    if (!b.reminder) return -1;
    return a.reminder.localeCompare(b.reminder);
  });

  return { today: toIso(today), entities };
}

/* ------------------------------------------------------------------ */
/* Sent log (stored in Netlify Blobs so nothing is emailed twice)      */
/* ------------------------------------------------------------------ */

function logStore() {
  return getStore({ name: "renewal-reminders", consistency: "strong" });
}

export function sentKey(e) {
  return `${e.ubo}|${e.corporate}|${e.renewal}`;
}

export async function getSentLog() {
  return (await logStore().get("sent-log", { type: "json" })) || {};
}

async function saveSentLog(log) {
  await logStore().setJSON("sent-log", log);
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

function smtpTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.office365.com",
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function splitAddresses(value) {
  return String(value || "")
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

function usingGraph() {
  return Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
}

// Microsoft Graph (OAuth). Used automatically when the three MS_ variables
// are set. This is the method Microsoft supports for Outlook / Microsoft 365
// over the long term, as basic SMTP authentication is being retired.
async function graphToken() {
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.MS_CLIENT_ID,
        client_secret: process.env.MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Microsoft sign-in failed: ${body.error_description || res.status}`);
  return body.access_token;
}

async function sendViaGraph(token, mail) {
  const toRecipients = (list) => list.map((address) => ({ emailAddress: { address } }));
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mail.from)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: "HTML", content: mail.html },
          toRecipients: toRecipients(splitAddresses(mail.to)),
          ccRecipients: toRecipients(splitAddresses(mail.cc)),
        },
        saveToSentItems: true,
      }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Microsoft Graph refused the email: ${body.error?.message || res.status}`);
  }
}

// EmailJS. Used automatically when the EmailJS variables are set. EmailJS
// sends through the Outlook account already connected in its dashboard, so
// no Microsoft app registration or SMTP password is required.
function usingEmailJs() {
  return Boolean(
    process.env.EMAILJS_SERVICE_ID &&
      process.env.EMAILJS_TEMPLATE_ID &&
      process.env.EMAILJS_PUBLIC_KEY &&
      process.env.EMAILJS_PRIVATE_KEY
  );
}

async function sendViaEmailJs(mail) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: process.env.EMAILJS_SERVICE_ID,
      template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY,
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: splitAddresses(mail.to).join(","),
        cc_email: splitAddresses(mail.cc).join(","),
        subject: mail.subject,
        message_html: mail.html,
        message_text: mail.text,
        ...mail.fields,
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`EmailJS refused the email (HTTP ${res.status}): ${detail}`);
  }
}

// Returns a function that sends one email, using EmailJS if configured,
// then Microsoft Graph if configured, otherwise SMTP.
async function createSender() {
  if (usingEmailJs()) {
    return (mail) => sendViaEmailJs(mail);
  }
  if (usingGraph()) {
    const token = await graphToken();
    return (mail) => sendViaGraph(token, mail);
  }
  const transporter = smtpTransport();
  return ({ fields, ...mail }) => transporter.sendMail(mail);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function buildEmail(e) {
  const renewal = longDate(fromIso(e.renewal));
  const issued = longDate(fromIso(e.issued));
  const greeting = process.env.MAIL_GREETING || "Dear Joshua and Smitha,";

  const lead =
    `${e.corporate}, owned by ${e.ubo} and based out of ${e.authority}, ` +
    `is up for renewal on ${renewal}. Please contact the relevant authorities to process the renewal.`;

  const details = [
    ["Entity type", e.type],
    ["Authority", e.authority],
    ["Licence issued", issued],
    ["Renewal date", renewal],
  ];

  const text =
    `${greeting}\n\n${lead}\n\n` +
    details.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nThis is an automated reminder from the licence renewal tracker.`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#16232e;line-height:1.55">` +
    `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(lead)}</p>` +
    `<table style="border-collapse:collapse;margin:12px 0">` +
    details
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 16px 4px 0;color:#5e6b73">${escapeHtml(k)}</td>` +
          `<td style="padding:4px 0"><strong>${escapeHtml(v)}</strong></td></tr>`
      )
      .join("") +
    `</table><p style="color:#5e6b73;font-size:12px">This is an automated reminder from the licence renewal tracker.</p></div>`;

  return {
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: process.env.MAIL_TO,
    cc: process.env.MAIL_CC || undefined,
    subject: `Renewal reminder: ${e.corporate} (renews ${renewal})`,
    text,
    html,
    // Individual values, available as {{variables}} in an EmailJS template.
    fields: {
      corporate_name: e.corporate,
      owner_name: e.ubo,
      entity_type: e.type,
      authority: e.authority,
      issued_date: issued,
      renewal_date: renewal,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Main job                                                            */
/* ------------------------------------------------------------------ */

// Sends one email for every entity whose reminder date has arrived and whose
// renewal date has not yet passed, provided it has not been emailed before.
// If a daily run is ever missed, the next run catches it up.
export async function sendDueReminders() {
  const { today, entities } = await loadEntities();
  const log = await getSentLog();

  const due = entities.filter((e) => e.status === "due" && !log[sentKey(e)]);
  const sent = [];
  const failed = [];

  if (due.length) {
    const send = await createSender();
    for (const e of due) {
      try {
        await send(buildEmail(e));
        log[sentKey(e)] = { sentAt: new Date().toISOString() };
        await saveSentLog(log);
        sent.push(e.corporate);
      } catch (err) {
        failed.push({ corporate: e.corporate, error: err.message });
      }
    }
  }

  return { today, checked: entities.length, sent, failed };
}

/* ------------------------------------------------------------------ */
/* Dashboard access                                                    */
/* ------------------------------------------------------------------ */

export function isAuthorised(req) {
  const pw = process.env.DASHBOARD_PASSWORD;
  return Boolean(pw) && req.headers.get("x-dashboard-password") === pw;
}
