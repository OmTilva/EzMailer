const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");

function safeLower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

const ROOT_DIR = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT_DIR, ".env") });
dotenv.config({ path: path.join(__dirname, ".env"), override: false });

const Email = require("./models/email");
const SenderPreference = require("./models/senderPreference");
const ActionItem = require("./models/actionItem");
const ClassificationFeedback = require("./models/classificationFeedback");
const {
  groupThreads,
  messageTimestamp,
  detectDeadlineChanges,
  detectPlanChanges,
} = require("./threadIntelligence");
const { computePriority } = require("./priorityEngine");
const app = express();
app.use(
  cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000" }),
);
app.use(express.json({ limit: "1mb" }));

const credentialsPath = path.join(__dirname, "credentials.json");
if (!fs.existsSync(credentialsPath)) {
  console.error(
    "Missing server/credentials.json. Configure Google OAuth credentials locally; do not commit this file.",
  );
  process.exit(1);
}
const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
const oauthConfig = credentials.web || credentials.installed;
if (
  !oauthConfig ||
  !oauthConfig.client_id ||
  !oauthConfig.client_secret ||
  !Array.isArray(oauthConfig.redirect_uris)
) {
  console.error(
    "Google OAuth credentials.json is missing client_id, client_secret, or redirect_uris.",
  );
  process.exit(1);
}
const redirectUri =
  process.env.GOOGLE_REDIRECT_URI ||
  oauthConfig.redirect_uris.find((uri) =>
    uri.includes("/auth/google/callback"),
  ) ||
  oauthConfig.redirect_uris[0];
const oAuth2Client = new google.auth.OAuth2(
  oauthConfig.client_id,
  oauthConfig.client_secret,
  redirectUri,
);

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/ezmail";
mongoose
  .connect(mongoUri)
  .then(() => console.log("Connected to MongoDB"))
  .catch((error) => console.error("MongoDB connection error:", error.message));

const TOKEN_PATH = path.join(__dirname, "tokens.json");
const CLASSIFIER_PATH = path.join(ROOT_DIR, "classification_model", "model.py");
const SMART_ASSISTANT_PATH = path.join(
  ROOT_DIR,
  "classification_model",
  "smart_assistant.py",
);
const VENV_PYTHON = path.join(ROOT_DIR, ".venv", "Scripts", "python.exe");
const PYTHON_EXECUTABLE =
  process.env.PYTHON_EXECUTABLE ||
  (fs.existsSync(VENV_PYTHON)
    ? VENV_PYTHON
    : process.platform === "win32"
      ? "python"
      : "python3");
const CATEGORIES = [
  "Work/Professional",
  "Security/Account",
  "Banking/Finance",
  "Shopping/Orders",
  "Travel/Bookings",
  "Social/Promotions",
  "Newsletters/Updates",
  "Personal/Family",
  "Spam",
];

const PRIORITIES = ["High", "Medium", "Low"];

function preferredCategoryFromFeedback(rows = []) {
  const valid = rows.filter((row) =>
    CATEGORIES.includes(row.correctedCategory),
  );
  if (valid.length < 3) return null;
  const counts = new Map();
  for (const row of valid)
    counts.set(
      row.correctedCategory,
      (counts.get(row.correctedCategory) || 0) + 1,
    );
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [category, count] = ranked[0] || [];
  // Require repeated, consistent human corrections before applying a sender-specific category preference.
  return category && count >= 3 && count / valid.length >= 0.8
    ? category
    : null;
}

const CLASSIFICATION_TEST_CASES = [
  {
    id: "eval-security-alert",
    expectedCategory: "Security/Account",
    senderName: "Google Account Security",
    senderMail: "no-reply@accounts.google.com",
    subject: "New sign-in to your Google Account",
    snippet:
      "We detected a sign-in from a new device. Review the activity if this was not you.",
    body: "Your Google Account was used to sign in from a new device. If you do not recognize this activity, secure your account and change your password.",
  },
  {
    id: "eval-otp",
    expectedCategory: "Security/Account",
    senderName: "Verification Service",
    senderMail: "no-reply@example.test",
    subject: "Your one-time verification code",
    snippet:
      "Use this code to verify your sign-in. Never share it with anyone.",
    body: "Your one-time password (OTP) is 482913. Enter it to verify your account sign-in. Do not share this security code.",
  },
  {
    id: "eval-placement-drive",
    expectedCategory: "Work/Professional",
    senderName: "University Placement Cell",
    senderMail: "placements@example.test",
    subject: "Placement drive registration invitation",
    snippet:
      "Register for the campus recruitment drive before the registration deadline.",
    body: "Eligible students are invited to register for the campus placement drive. Review the job description and submit your application before the stated deadline.",
  },
  {
    id: "eval-upi",
    expectedCategory: "Banking/Finance",
    senderName: "Example Bank",
    senderMail: "alerts@bank.example.test",
    subject: "UPI transaction debit alert",
    snippet: "Your account was debited for a UPI transaction.",
    body: "A UPI payment of INR 850.00 was debited from your bank account. If you did not authorize this transaction, contact the bank using its official app or phone number.",
  },
  {
    id: "eval-bill-due",
    expectedCategory: "Banking/Finance",
    senderName: "Example Card Services",
    senderMail: "statements@cards.example.test",
    subject: "Credit card statement and payment due date",
    snippet:
      "Your latest statement is ready. Payment is due by the date shown in your statement.",
    body: "Your monthly credit card statement is available. Please pay the outstanding balance by the due date to avoid late fees.",
  },
  {
    id: "eval-order-shipped",
    expectedCategory: "Shopping/Orders",
    senderName: "Example Store",
    senderMail: "orders@shop.example.test",
    subject: "Your order has shipped",
    snippet:
      "Your package is on its way. Track your delivery with the order link.",
    body: "We have shipped your online order. You can track the package status and expected delivery date from your order page.",
  },
  {
    id: "eval-flight-booking",
    expectedCategory: "Travel/Bookings",
    senderName: "Example Airline",
    senderMail: "booking@air.example.test",
    subject: "Flight booking confirmation",
    snippet: "Your flight itinerary and booking reference are confirmed.",
    body: "Your flight reservation is confirmed. This email contains your travel itinerary, booking reference, departure details, and check-in information.",
  },
  {
    id: "eval-promotion",
    expectedCategory: "Social/Promotions",
    senderName: "Example Fashion Store",
    senderMail: "offers@fashion.example.test",
    subject: "Festival sale: extra discounts this weekend",
    snippet: "Shop now and enjoy limited-time discounts on selected products.",
    body: "Our festival sale is live. Browse selected products and use the promotional code at checkout to receive a discount. This is a marketing offer.",
  },
  {
    id: "eval-newsletter",
    expectedCategory: "Newsletters/Updates",
    senderName: "Tech Weekly",
    senderMail: "newsletter@tech.example.test",
    subject: "Your weekly technology newsletter",
    snippet:
      "Read this week's product updates, feature announcements, and industry highlights.",
    body: "Here is your weekly digest of technology news, product release notes, and industry updates. No action is required.",
  },
  {
    id: "eval-personal",
    expectedCategory: "Personal/Family",
    senderName: "Alex",
    senderMail: "alex@example.test",
    subject: "Dinner at home on Sunday?",
    snippet: "Are you free to join us for dinner this Sunday?",
    body: "Hey, hope you are doing well. We are planning a family dinner on Sunday and wanted to see if you could join. Let me know when you get a chance.",
  },
  {
    id: "eval-spam",
    expectedCategory: "Spam",
    senderName: "Unknown Prize Center",
    senderMail: "claim-prize@example.test",
    subject: "Congratulations, claim your unexpected cash prize",
    snippet:
      "You have won a prize you never entered for. Pay a processing fee to claim it.",
    body: "You have been selected for an unrequested cash prize. Send payment and personal account details immediately to release the reward. This message is unsolicited and asks for sensitive information.",
  },
];

const loadTokens = () => {
  try {
    return fs.existsSync(TOKEN_PATH)
      ? JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"))
      : null;
  } catch (error) {
    console.error("Unable to read OAuth tokens:", error.message);
    return null;
  }
};
const saveTokens = (tokens) =>
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
  });

function formatDate(date) {
  if (!date || Number.isNaN(new Date(date).getTime())) return "Unknown Date";
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function htmlToReadableText(html) {
  return (
    String(html || "")
      // Remove content that should never appear in the email text.
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Preserve basic paragraph and line-break spacing.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      // Preserve anchor destinations for security review when HTML is the only body part.
      .replace(
        /<a\b[^>]*href=["']?([^"' >]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
        "$2 ($1)",
      )
      // Remove remaining HTML tags.
      .replace(/<[^>]*>/g, " ")
      // Decode common HTML entities.
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
        String.fromCodePoint(parseInt(n, 16)),
      )
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function extractMessageContent(payload) {
  if (!payload) return "";

  const plainBodies = [];
  const htmlBodies = [];

  function collectParts(part) {
    if (!part) return;

    if (part.body && part.body.data) {
      const decoded = Buffer.from(part.body.data, "base64url").toString("utf8");

      const mimeType = safeLower(part.mimeType);

      if (mimeType === "text/plain") {
        plainBodies.push(decoded);
      } else if (mimeType === "text/html") {
        htmlBodies.push(decoded);
      }
    }

    for (const child of part.parts || []) {
      collectParts(child);
    }
  }

  collectParts(payload);

  // Prefer plain text, but handle emails whose plain-text part
  // mistakenly contains HTML markup.
  if (plainBodies.length) {
    const text = plainBodies.join("\n\n");

    if (/<\/?[a-z][^>]*>/i.test(text)) {
      return htmlToReadableText(text);
    }

    return htmlToReadableText(text);
  }

  // If only HTML is available, convert it into readable text.
  if (htmlBodies.length) {
    return htmlToReadableText(htmlBodies.join("\n\n"));
  }

  // Fallback for unusual Gmail payload structures with no MIME type.
  if (payload.body && payload.body.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString(
      "utf8",
    );

    return htmlToReadableText(decoded);
  }

  return "";
}

function getHeader(headers = [], name) {
  const header = headers.find(
    (item) => safeLower(item.name) === safeLower(name),
  );
  return header ? header.value : "";
}

function parseSender(rawSender) {
  const match = String(rawSender || "").match(/^(.*?)\s*<([^>]+)>/);
  if (match)
    return {
      senderName: match[1].replace(/^"|"$/g, "").trim() || match[2],
      senderMail: match[2].trim().toLowerCase(),
    };
  const emailMatch = String(rawSender || "").match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
  return {
    senderName: String(rawSender || "Unknown Sender").trim(),
    senderMail: emailMatch ? emailMatch[0].toLowerCase() : "",
  };
}

function classifyEmailsWithGemini(emails) {
  if (!emails.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn(PYTHON_EXECUTABLE, [CLASSIFIER_PATH], {
      cwd: ROOT_DIR,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (results) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(results);
      }
    };
    const timeout = setTimeout(
      () => {
        child.kill();
        console.error(
          "Gemini classification timed out; continuing with rule-based priority.",
        );
        finish(
          emails.map((email) => ({
            id: email.id,
            classification: "Unclassified",
            classificationStatus: "timeout",
          })),
        );
      },
      Number(process.env.CLASSIFICATION_TIMEOUT_MS || 300000),
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      console.error("Could not start Python classifier:", error.message);
      finish(
        emails.map((email) => ({
          id: email.id,
          classification: "Unclassified",
          classificationStatus: "unavailable",
        })),
      );
    });
    child.on("close", (code) => {
      if (stderr.trim())
        console.warn("Classifier diagnostics:", stderr.trim().slice(-1500));
      try {
        const parsed = JSON.parse(stdout.trim());
        if (Array.isArray(parsed)) finish(parsed);
        else {
          console.error("Classifier returned an unexpected response.");
          finish(
            emails.map((email) => ({
              id: email.id,
              classification: "Unclassified",
              classificationStatus: "failed",
            })),
          );
        }
      } catch (error) {
        console.error(
          `Classifier exited with code ${code}; output could not be parsed.`,
        );
        finish(
          emails.map((email) => ({
            id: email.id,
            classification: "Unclassified",
            classificationStatus: "failed",
          })),
        );
      }
    });
    child.stdin.end(
      JSON.stringify(
        emails.map((email) => ({
          id: email.id,
          senderName: email.senderName,
          senderMail: email.senderMail,
          subject: email.subject || "",
          snippet: email.snippet,
          body: email.body,
        })),
      ),
    );
  });
}

async function saveProcessedEmails(rawEmails) {
  // Read existing records first so already-classified emails do not consume Gemini quota again.
  const existingById = new Map();
  const needsClassification = [];

  const existingDocs = rawEmails.length
    ? await Email.find({
        id: { $in: rawEmails.map((email) => email.id) },
      }).lean()
    : [];

  for (const existing of existingDocs) {
    existingById.set(existing.id, existing);
  }

  const senderMails = [
    ...new Set(
      rawEmails
        .map((email) => safeLower(email.senderMail).trim())
        .filter(Boolean),
    ),
  ];
  const feedbackRows = senderMails.length
    ? await ClassificationFeedback.find({
        senderMail: { $in: senderMails },
      }).lean()
    : [];
  const feedbackBySender = new Map();
  for (const feedback of feedbackRows) {
    const key = safeLower(feedback.senderMail).trim();
    if (!feedbackBySender.has(key)) feedbackBySender.set(key, []);
    feedbackBySender.get(key).push(feedback);
  }
  const learnedCategoriesBySender = new Map();
  for (const [senderMail, rows] of feedbackBySender.entries()) {
    const learned = preferredCategoryFromFeedback(rows);
    if (learned) learnedCategoriesBySender.set(senderMail, learned);
  }

  for (const email of rawEmails) {
    const existing = existingById.get(email.id);

    if (
      !existing ||
      !existing.classification ||
      existing.classification === "Unclassified" ||
      !existing.aiUrgency ||
      !existing.aiPriorityReason
    ) {
      needsClassification.push(email);
    }
  }
  const classifications = await classifyEmailsWithGemini(needsClassification);
  const byId = new Map(classifications.map((result) => [result.id, result]));
  const saved = [];
  for (const rawEmail of rawEmails) {
    const existing = existingById.get(rawEmail.id);
    const classificationResult = byId.get(rawEmail.id);
    const existingCategory =
      existing && CATEGORIES.includes(existing.classification)
        ? existing.classification
        : null;
    const proposedCategory =
      classificationResult &&
      CATEGORIES.includes(classificationResult.classification)
        ? classificationResult.classification
        : null;
    const userCorrectedExisting = Boolean(
      existing &&
      existing.classificationSource === "user-feedback" &&
      existingCategory,
    );
    const senderCategoryPreference =
      learnedCategoriesBySender.get(safeLower(rawEmail.senderMail).trim()) ||
      null;
    // Apply sender-level category learning to new/unclassified messages, not retroactively to already-classified history.
    const learnedCategory =
      !userCorrectedExisting &&
      (!existing ||
        !existingCategory ||
        ["failed", "unavailable", "timeout"].includes(
          String(existing.classificationStatus || "").toLowerCase(),
        ))
        ? senderCategoryPreference
        : null;
    const category = userCorrectedExisting
      ? existingCategory
      : learnedCategory ||
        proposedCategory ||
        existingCategory ||
        "Unclassified";
    const modelClassification =
      proposedCategory ||
      (existing && existing.modelClassification) ||
      existingCategory ||
      "Unclassified";
    const preference = rawEmail.senderMail
      ? await SenderPreference.findOne({
          senderMail: rawEmail.senderMail.toLowerCase(),
        }).lean()
      : null;
    const aiUrgency =
      classificationResult &&
      ["High", "Medium", "Low"].includes(classificationResult.aiUrgency)
        ? classificationResult.aiUrgency
        : (existing && existing.aiUrgency) || null;
    const aiPriorityReason =
      (classificationResult && classificationResult.aiPriorityReason) ||
      (existing && existing.aiPriorityReason) ||
      "";
    const scored = computePriority(
      { ...rawEmail, classification: category, aiUrgency, aiPriorityReason },
      preference,
    );
    const document = {
      ...rawEmail,
      classification: category,
      modelClassification,
      classificationSource: userCorrectedExisting
        ? "user-feedback"
        : learnedCategory && learnedCategory !== proposedCategory
          ? "sender-feedback"
          : proposedCategory
            ? "ai"
            : (existing && existing.classificationSource) || "existing",
      aiUrgency,
      aiPriorityReason,
      ...scored,
      senderTrusted: Boolean(preference && preference.trusted),
      classificationStatus: userCorrectedExisting
        ? "user-corrected"
        : learnedCategory && learnedCategory !== proposedCategory
          ? "personalized"
          : classificationResult
            ? classificationResult.classificationStatus
            : existingCategory
              ? existing.classificationStatus || "classified"
              : "failed",
      priorityOverride: Boolean(existing && existing.priorityOverride),
    };
    // A manual priority choice survives future syncs; automatic classification may still refresh.
    if (existing && existing.priorityOverride) {
      document.priorityLevel = existing.priorityLevel;
      document.priorityScore = existing.priorityScore;
      document.isPriority = existing.isPriority;
      document.priorityReasons = existing.priorityReasons || [
        "Manually set by user",
      ];
      document.priorityOverride = true;
      document.feedbackAppliedPriority =
        existing.feedbackAppliedPriority || existing.priorityLevel;
    }
    await Email.updateOne(
      { id: rawEmail.id },
      { $set: document },
      { upsert: true },
    );
    saved.push({ ...document });
  }
  return saved;
}

app.get("/", (req, res) =>
  res.status(200).json({ status: "ok", message: "EzMailer server is running" }),
);
app.get("/check-auth", (req, res) => {
  const tokens = loadTokens();
  if (tokens) {
    oAuth2Client.setCredentials(tokens);
    return res.json({ accessToken: tokens.access_token });
  }
  return res.status(401).json({ error: "Not authenticated" });
});
app.get("/auth/google", (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
  res.redirect(authUrl);
});
app.get("/auth/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error)
    return res
      .status(400)
      .send("Google authentication was cancelled or denied.");
  if (!code) return res.status(400).send("Missing OAuth authorization code.");
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    const existing = loadTokens() || {};
    // Google may omit refresh_token on later consent responses; retain an existing one.
    const mergedTokens = {
      ...existing,
      ...tokens,
      refresh_token: tokens.refresh_token || existing.refresh_token,
    };
    oAuth2Client.setCredentials(mergedTokens);
    saveTokens(mergedTokens);
    res.redirect(process.env.FRONTEND_ORIGIN || "http://localhost:3000");
  } catch (error) {
    console.error("OAuth callback failed:", error.message);
    res
      .status(500)
      .send("Authentication failed. Check the backend terminal for details.");
  }
});

async function fetchGmailMessages({ date }) {
  const tokens = loadTokens();
  if (!tokens)
    throw Object.assign(new Error("Not authenticated"), { statusCode: 401 });
  oAuth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: "v1", auth: oAuth2Client });
  const listOptions = {
    userId: "me",
    q: "category:primary",
    maxResults: date ? 100 : 20,
  };
  if (date) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(new Date(`${date}T00:00:00`).getTime())
    ) {
      throw Object.assign(new Error("Date must be in YYYY-MM-DD format"), {
        statusCode: 400,
      });
    }
    const start = new Date(`${date}T00:00:00`);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const after = Math.floor(start.getTime() / 1000);
    const before = Math.floor(end.getTime() / 1000);
    listOptions.q = `category:primary after:${after} before:${before}`;
  }
  const response = await gmail.users.messages.list(listOptions);
  const messages = response.data.messages || [];
  const result = await Promise.all(
    messages.map(async (message) => {
      const responseItem = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "full",
      });

      const item = responseItem.data;

      const headers =
        item.payload && item.payload.headers ? item.payload.headers : [];

      const sender = parseSender(getHeader(headers, "From"));
      const rawDate = getHeader(headers, "Date");
      const subject = getHeader(headers, "Subject");

      const receivedTimestamp =
        Number(item.internalDate) ||
        (rawDate ? new Date(rawDate).getTime() : null);
      return {
        id: item.id,
        threadId: item.threadId || "",
        internalDate: receivedTimestamp,
        senderName: sender.senderName,
        senderMail: sender.senderMail,
        subject,
        snippet: item.snippet || "",
        isRead: !(item.labelIds || []).includes("UNREAD"),
        date: receivedTimestamp
          ? formatDate(new Date(receivedTimestamp))
          : "Unknown Date",
        body: extractMessageContent(item.payload),
        classification: "Unclassified",
      };
    }),
  );

  return result;
}

function getAuthorizedGmailClient() {
  const tokens = loadTokens();
  if (!tokens)
    throw Object.assign(new Error("Not authenticated"), { statusCode: 401 });
  oAuth2Client.setCredentials(tokens);
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

function convertGmailThreadMessage(item) {
  const headers =
    item && item.payload && item.payload.headers ? item.payload.headers : [];
  const sender = parseSender(getHeader(headers, "From"));
  const rawDate = getHeader(headers, "Date");
  const receivedTimestamp =
    Number(item && item.internalDate) ||
    (rawDate ? new Date(rawDate).getTime() : null);
  return {
    id: String((item && item.id) || ""),
    threadId: String((item && item.threadId) || ""),
    internalDate: receivedTimestamp,
    senderName: sender.senderName,
    senderMail: sender.senderMail,
    subject: getHeader(headers, "Subject"),
    snippet: String((item && item.snippet) || ""),
    isRead: !((item && item.labelIds) || []).includes("UNREAD"),
    date: receivedTimestamp
      ? formatDate(new Date(receivedTimestamp))
      : rawDate
        ? formatDate(new Date(rawDate))
        : "Unknown Date",
    body: extractMessageContent(item && item.payload),
  };
}

async function fetchGmailThread(threadId) {
  if (!threadId || typeof threadId !== "string" || threadId.length > 200) {
    throw Object.assign(new Error("A valid Gmail thread ID is required"), {
      statusCode: 400,
    });
  }
  const gmail = getAuthorizedGmailClient();
  const response = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full",
  });
  const messages = ((response.data && response.data.messages) || []).map(
    convertGmailThreadMessage,
  );
  messages.sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
  if (!messages.length)
    throw Object.assign(new Error("No messages found in this conversation"), {
      statusCode: 404,
    });
  return messages;
}

async function resolveThreadIdFromMessage(emailId) {
  try {
    const gmail = getAuthorizedGmailClient();
    const response = await gmail.users.messages.get({
      userId: "me",
      id: emailId,
      format: "minimal",
    });
    return response.data && response.data.threadId
      ? String(response.data.threadId)
      : null;
  } catch (error) {
    return null;
  }
}

async function loadConversation({ threadId, emailIds }) {
  const ids = [
    ...new Set(
      (Array.isArray(emailIds) ? emailIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  ].slice(0, 25);
  let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!resolvedThreadId && ids.length === 1)
    resolvedThreadId = (await resolveThreadIdFromMessage(ids[0])) || "";

  if (resolvedThreadId) {
    try {
      const messages = await fetchGmailThread(resolvedThreadId);
      return { threadId: resolvedThreadId, messages, source: "gmail" };
    } catch (error) {
      // Fall back to saved records if Gmail is temporarily unavailable or access is no longer valid.
      console.warn(
        "Could not load live Gmail thread; trying saved copies:",
        error.message,
      );
    }
  }

  let saved = [];
  if (resolvedThreadId)
    saved = await Email.find({ threadId: resolvedThreadId }).lean();
  if (!saved.length && ids.length)
    saved = await Email.find({ id: { $in: ids } }).lean();
  saved.sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
  if (!saved.length)
    throw Object.assign(
      new Error("No saved messages were found for this conversation"),
      { statusCode: 404 },
    );
  return {
    threadId: resolvedThreadId || saved[0].threadId || null,
    messages: saved,
    source: "saved",
  };
}

function runSmartAssistant(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_EXECUTABLE, [SMART_ASSISTANT_PATH], {
      cwd: ROOT_DIR,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const configuredTimeout = Number(
      process.env.SMART_ASSISTANT_TIMEOUT_MS || 45000,
    );
    const timeoutMs = Number.isFinite(configuredTimeout)
      ? Math.max(1000, Math.min(configuredTimeout, 120000))
      : 45000;
    const timeout = setTimeout(() => {
      child.kill();
      finish(
        Object.assign(
          new Error(
            "The email assistant timed out. Try a shorter conversation.",
          ),
          { statusCode: 504 },
        ),
      );
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      finish(
        Object.assign(
          new Error(`Could not start the Python assistant: ${error.message}`),
          { statusCode: 503 },
        ),
      ),
    );
    child.on("close", (code) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        console.error(
          "Smart assistant returned invalid JSON:",
          stderr.trim().slice(-1200),
        );
        return finish(
          Object.assign(
            new Error("The email assistant returned an invalid response."),
            { statusCode: 502 },
          ),
        );
      }
      if (code !== 0 || !parsed || parsed.ok !== true || !parsed.result) {
        console.error(
          "Smart assistant failed:",
          (parsed && parsed.error) ||
            stderr.trim().slice(-1200) ||
            `exit code ${code}`,
        );
        return finish(
          Object.assign(
            new Error(
              (parsed && parsed.error) ||
                "AI assistant request failed. Check the backend terminal.",
            ),
            { statusCode: 502 },
          ),
        );
      }
      finish(null, parsed.result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function handleFetch(req, res) {
  try {
    if (req.path === "/fetch-emails" && !req.body.date)
      return res.status(400).json({ error: "Date is required (YYYY-MM-DD)" });
    const rawEmails = await fetchGmailMessages({
      date: req.path === "/fetch-emails" ? req.body.date : null,
    });
    const savedEmails = await saveProcessedEmails(rawEmails);
    const failedCount = savedEmails.filter(
      (email) => email.classification === "Unclassified",
    ).length;
    res.status(200).json({
      emails: savedEmails,
      classificationWarning: failedCount
        ? `${failedCount} email(s) could not be classified. Fetching and rule-based priority still succeeded.`
        : null,
    });
  } catch (error) {
    const status =
      error.statusCode ||
      (error.code === 401 || error.code === 403 ? 401 : 500);
    console.error(`Fetch failed (${req.path}):`, error.message);
    res
      .status(status)
      .json({ error: error.message || "Failed to fetch emails" });
  }
}
app.post("/fetch-emails", handleFetch);
app.post("/fetch-lastHundred", handleFetch);

// Thread index is built from stored messages; full conversations are fetched from Gmail only when opened.
app.get("/threads", async (req, res) => {
  try {
    const emails = await Email.find({})
      .sort({ internalDate: -1, createdAt: -1 })
      .limit(500)
      .lean();
    return res.json(groupThreads(emails));
  } catch (error) {
    console.error("Thread index failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not load conversations from saved emails." });
  }
});

app.post("/threads/content", async (req, res) => {
  try {
    const { threadId, emailIds } = req.body || {};
    if (!threadId && (!Array.isArray(emailIds) || !emailIds.length)) {
      return res
        .status(400)
        .json({ error: "Provide a threadId or at least one emailId." });
    }
    const conversation = await loadConversation({ threadId, emailIds });
    return res.json({
      ...conversation,
      deadlineChanges: detectDeadlineChanges(conversation.messages),
      planChanges: detectPlanChanges(conversation.messages),
      messageCount: conversation.messages.length,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error("Thread content failed:", error.message);
    return res
      .status(status)
      .json({ error: error.message || "Could not load this conversation." });
  }
});

async function handleAssistantRequest(req, res, task) {
  try {
    const { threadId, emailIds, tone, instructions } = req.body || {};
    if (!threadId && (!Array.isArray(emailIds) || !emailIds.length)) {
      return res.status(400).json({ error: "Provide a threadId or emailIds." });
    }
    const conversation = await loadConversation({ threadId, emailIds });
    const result = await runSmartAssistant({
      task,
      tone: typeof tone === "string" ? tone.slice(0, 40) : "Professional",
      instructions:
        typeof instructions === "string" ? instructions.slice(0, 800) : "",
      messages: conversation.messages.slice(-25).map((message) => ({
        senderName: message.senderName,
        senderMail: message.senderMail,
        date: message.date,
        subject: message.subject,
        snippet: message.snippet,
        body: message.body,
      })),
    });
    return res.json({
      ...result,
      threadId: conversation.threadId,
      source: conversation.source,
      messageCount: conversation.messages.length,
      deadlineChanges: detectDeadlineChanges(conversation.messages),
      planChanges: detectPlanChanges(conversation.messages),
    });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error(`Assistant ${task} failed:`, error.message);
    return res
      .status(status)
      .json({
        error:
          error.message ||
          "The email assistant could not complete this request.",
      });
  }
}

app.post("/assistant/summarize", (req, res) =>
  handleAssistantRequest(req, res, "summarize"),
);
app.post("/assistant/reply", (req, res) =>
  handleAssistantRequest(req, res, "reply"),
);

app.get("/health", (req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;
  const status = mongoConnected ? 200 : 503;
  return res.status(status).json({
    status: mongoConnected ? "ok" : "degraded",
    services: {
      api: "ok",
      mongo: mongoConnected ? "connected" : "disconnected",
    },
  });
});

app.get("/emails", async (req, res) => {
  try {
    const query = {};
    if (req.query.priority && PRIORITIES.includes(req.query.priority))
      query.priorityLevel = req.query.priority;
    if (req.query.category && CATEGORIES.includes(req.query.category))
      query.classification = req.query.category;
    const emails = await Email.find(query)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json(emails);
  } catch (error) {
    res.status(500).json({ error: "Failed to load saved emails" });
  }
});

app.get("/fetch-priorities", async (req, res) => {
  try {
    const emails = await Email.find({ isPriority: true })
      .sort({ date: -1 })
      .lean();
    res.json(emails);
  } catch (error) {
    console.error("Failed to fetch priority emails:", error.message);
    res.status(500).json({ error: "Failed to fetch priority emails" });
  }
});

async function updateSenderFeedback(
  senderMail,
  oldPriority,
  newPriority,
  wasApplied,
) {
  if (!senderMail) return;
  const key = senderMail.toLowerCase();
  const counts = { High: "highCount", Medium: "mediumCount", Low: "lowCount" };
  if (wasApplied && counts[oldPriority]) {
    await SenderPreference.updateOne(
      { senderMail: key },
      { $inc: { [counts[oldPriority]]: -1, feedbackCount: -1 } },
      { upsert: true },
    );
  }
  await SenderPreference.updateOne(
    { senderMail: key },
    {
      $setOnInsert: { senderMail: key, trusted: false },
      $inc: { [counts[newPriority]]: 1, feedbackCount: 1 },
    },
    { upsert: true },
  );
  // Guard against negative counters if legacy/inconsistent records are encountered.
  await SenderPreference.updateOne(
    { senderMail: key },
    { $max: { highCount: 0, mediumCount: 0, lowCount: 0, feedbackCount: 0 } },
  );
}

app.post("/retry-classification", async (req, res) => {
  try {
    const emailId = String((req.body && req.body.emailId) || "").trim();
    if (!emailId) {
      return res.status(400).json({ error: "emailId is required" });
    }

    const current = await Email.findOne({ id: emailId }).lean();
    if (!current)
      return res.status(404).json({ error: "Email not found in MongoDB" });

    // Retry only this stored email; do not call Gmail fetch or reprocess the batch.
    const [result] = await classifyEmailsWithGemini([
      {
        id: current.id,
        senderName: current.senderName,
        senderMail: current.senderMail,
        subject: current.subject || "",
        snippet: current.snippet || "",
        body: current.body || "",
      },
    ]);

    if (
      !result ||
      !CATEGORIES.includes(result.classification) ||
      result.classificationStatus !== "classified"
    ) {
      const failureStatus = (result && result.classificationStatus) || "failed";
      await Email.updateOne(
        { id: emailId },
        { $set: { classificationStatus: failureStatus } },
      );
      return res.status(502).json({
        error: `Classification retry did not return a valid category (status: ${failureStatus}).`,
        classificationStatus: failureStatus,
      });
    }

    const preference = current.senderMail
      ? await SenderPreference.findOne({
          senderMail: current.senderMail.toLowerCase(),
        }).lean()
      : null;
    const category = result.classification;
    const aiUrgency = ["High", "Medium", "Low"].includes(result.aiUrgency)
      ? result.aiUrgency
      : null;
    const aiPriorityReason = result.aiPriorityReason || "";
    const updates = {
      classification: category,
      classificationStatus: "classified",
      aiUrgency,
      aiPriorityReason,
      senderTrusted: Boolean(preference && preference.trusted),
    };

    // Keep an explicit user override unchanged; only refresh automatic scores.
    if (!current.priorityOverride) {
      Object.assign(
        updates,
        computePriority(
          { ...current, classification: category, aiUrgency, aiPriorityReason },
          preference,
        ),
      );
    }

    const updated = await Email.findOneAndUpdate(
      { id: emailId },
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();

    return res.json(updated);
  } catch (error) {
    console.error("Single-email classification retry failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not retry this email's classification" });
  }
});

app.post("/evaluate-classification", async (req, res) => {
  try {
    const predictions = await classifyEmailsWithGemini(
      CLASSIFICATION_TEST_CASES,
    );
    const predictionById = new Map(predictions.map((item) => [item.id, item]));
    const predictedLabels = [...CATEGORIES, "Unclassified"];
    const confusionMatrix = Object.fromEntries(
      CATEGORIES.map((expected) => [
        expected,
        Object.fromEntries(predictedLabels.map((predicted) => [predicted, 0])),
      ]),
    );

    let correct = 0;
    let successful = 0;
    const cases = CLASSIFICATION_TEST_CASES.map((testCase) => {
      const prediction = predictionById.get(testCase.id) || {};
      const hasValidPrediction =
        prediction.classificationStatus === "classified" &&
        CATEGORIES.includes(prediction.classification);
      const predicted = hasValidPrediction
        ? prediction.classification
        : "Unclassified";
      if (hasValidPrediction) successful += 1;
      if (predicted === testCase.expectedCategory) correct += 1;
      if (!confusionMatrix[testCase.expectedCategory]) {
        confusionMatrix[testCase.expectedCategory] = Object.fromEntries(
          predictedLabels.map((label) => [label, 0]),
        );
      }
      confusionMatrix[testCase.expectedCategory][predicted] += 1;
      return {
        id: testCase.id,
        subject: testCase.subject,
        expected: testCase.expectedCategory,
        predicted,
        status: prediction.classificationStatus || "failed",
        correct: predicted === testCase.expectedCategory,
      };
    });

    const total = CLASSIFICATION_TEST_CASES.length;
    const perCategory = CATEGORIES.map((category) => {
      const row = confusionMatrix[category] || {};
      const support = Object.values(row).reduce((sum, count) => sum + count, 0);
      const truePositive = row[category] || 0;
      const predictedCount = CATEGORIES.reduce(
        (sum, expected) =>
          sum + ((confusionMatrix[expected] || {})[category] || 0),
        0,
      );
      return {
        category,
        support,
        correct: truePositive,
        recall: support
          ? Math.round((truePositive / support) * 1000) / 10
          : null,
        precision: predictedCount
          ? Math.round((truePositive / predictedCount) * 1000) / 10
          : null,
      };
    });
    return res.json({
      total,
      correct,
      successful,
      accuracy: Math.round((correct / total) * 1000) / 10,
      successRate: Math.round((successful / total) * 1000) / 10,
      cases,
      perCategory,
      confusionMatrix,
      note: "Synthetic benchmark fixtures; expand and independently label the set before treating its accuracy as representative.",
    });
  } catch (error) {
    console.error("Classification evaluation failed:", error.message);
    return res
      .status(500)
      .json({
        error:
          "Classification evaluation failed. Check the classifier logs and API quota.",
      });
  }
});

app.post("/set-priority", async (req, res) => {
  try {
    const { emailId, priorityLevel } = req.body || {};
    if (!emailId) return res.status(400).json({ error: "emailId is required" });
    if (!PRIORITIES.includes(priorityLevel))
      return res
        .status(400)
        .json({ error: "priorityLevel must be High, Medium, or Low" });
    const email = await Email.findOne({ id: emailId });
    if (!email) return res.status(404).json({ error: "Email not found" });
    await updateSenderFeedback(
      email.senderMail,
      email.feedbackAppliedPriority,
      priorityLevel,
      Boolean(email.priorityOverride && email.feedbackAppliedPriority),
    );
    const scoreByPriority = { High: 85, Medium: 55, Low: 15 };
    const updated = await Email.findOneAndUpdate(
      { id: emailId },
      {
        $set: {
          priorityLevel,
          priorityScore: scoreByPriority[priorityLevel],
          isPriority: priorityLevel === "High",
          priorityOverride: true,
          feedbackAppliedPriority: priorityLevel,
          priorityReasons: [
            `Manually set to ${priorityLevel} by user`,
            "This feedback contributes to future sender-specific prioritization",
          ],
        },
      },
      { new: true, runValidators: true },
    ).lean();
    res.json(updated);
  } catch (error) {
    console.error("Priority update failed:", error.message);
    res.status(500).json({ error: "Failed to update priority" });
  }
});

app.get("/sender-preferences", async (req, res) => {
  try {
    res.json(
      await SenderPreference.find().sort({ updatedAt: -1 }).limit(200).lean(),
    );
  } catch (error) {
    res.status(500).json({ error: "Failed to load sender preferences" });
  }
});
app.post("/sender-preferences/toggle", async (req, res) => {
  try {
    const senderMail = safeLower(req.body && req.body.senderMail).trim();
    if (!senderMail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(senderMail))
      return res.status(400).json({ error: "A valid senderMail is required" });
    let preference = await SenderPreference.findOne({ senderMail });
    if (!preference)
      preference = new SenderPreference({ senderMail, trusted: true });
    else preference.trusted = !preference.trusted;
    await preference.save();
    res.json(preference.toObject());
  } catch (error) {
    console.error("Trusted sender update failed:", error.message);
    res.status(500).json({ error: "Failed to update trusted sender" });
  }
});

// Persist action completion separately from email records so extracted action keys remain stable.
app.get("/action-items", async (req, res) => {
  try {
    const rawIds = String(req.query.emailIds || "");
    const emailIds = [
      ...new Set(
        rawIds
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ].slice(0, 500);
    if (!emailIds.length) return res.json([]);
    const items = await ActionItem.find({ emailId: { $in: emailIds } }).lean();
    return res.json(
      items.map((item) => ({
        key: item.key,
        emailId: item.emailId,
        summary: item.summary,
        kind: item.kind,
        deadline: item.deadline,
        done: Boolean(item.done),
      })),
    );
  } catch (error) {
    console.error("Could not load action item state:", error.message);
    return res.status(500).json({ error: "Could not load saved action items" });
  }
});

app.post("/action-items/state", async (req, res) => {
  try {
    const body = req.body || {};
    const key = String(body.key || "").trim();
    const emailId = String(body.emailId || "").trim();
    const summary = String(body.summary || "").trim();
    const kind = String(body.kind || "Action")
      .trim()
      .slice(0, 80);
    const done = body.done === true;
    if (
      !key ||
      key.length > 512 ||
      !emailId ||
      !summary ||
      summary.length > 1000
    ) {
      return res
        .status(400)
        .json({ error: "key, emailId, and a valid summary are required" });
    }
    const emailExists = await Email.exists({ id: emailId });
    if (!emailExists) return res.status(404).json({ error: "Email not found" });
    let deadline = null;
    if (body.deadline) {
      const parsedDeadline = new Date(body.deadline);
      if (!Number.isNaN(parsedDeadline.getTime())) deadline = parsedDeadline;
    }
    const item = await ActionItem.findOneAndUpdate(
      { key },
      { $set: { key, emailId, summary, kind, deadline, done } },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    ).lean();
    return res.json({
      key: item.key,
      emailId: item.emailId,
      done: Boolean(item.done),
    });
  } catch (error) {
    console.error("Could not save action item state:", error.message);
    return res.status(500).json({ error: "Could not save action item state" });
  }
});

app.post("/set-classification", async (req, res) => {
  try {
    const emailId = String((req.body && req.body.emailId) || "").trim();
    const classification = String(
      (req.body && req.body.classification) || "",
    ).trim();
    if (!emailId) return res.status(400).json({ error: "emailId is required" });
    if (!CATEGORIES.includes(classification)) {
      return res
        .status(400)
        .json({
          error: "classification must be one of the supported categories",
        });
    }
    const current = await Email.findOne({ id: emailId }).lean();
    if (!current) return res.status(404).json({ error: "Email not found" });
    const priorCategory =
      current.modelClassification || current.classification || "Unclassified";
    await ClassificationFeedback.updateOne(
      { emailId },
      {
        $set: {
          emailId,
          senderMail: safeLower(current.senderMail).trim(),
          predictedCategory: priorCategory,
          correctedCategory: classification,
        },
      },
      { upsert: true, runValidators: true },
    );

    const updates = {
      classification,
      modelClassification: priorCategory,
      classificationSource: "user-feedback",
      classificationStatus: "user-corrected",
    };
    if (!current.priorityOverride) {
      const preference = current.senderMail
        ? await SenderPreference.findOne({
            senderMail: safeLower(current.senderMail).trim(),
          }).lean()
        : null;
      Object.assign(
        updates,
        computePriority({ ...current, classification }, preference),
      );
    }
    const updated = await Email.findOneAndUpdate(
      { id: emailId },
      { $set: updates },
      { new: true, runValidators: true },
    ).lean();
    return res.json(updated);
  } catch (error) {
    console.error("Classification correction failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not save classification feedback" });
  }
});

// Personalization overview: return aggregate statistics and sender patterns, not email bodies.
app.get("/personalization/overview", async (req, res) => {
  try {
    const [
      totalEmails,
      aiClassifiedCount,
      categorizedCount,
      failedClassificationCount,
      manualPriorityOverrides,
      personalizedEmailCount,
      userCorrectedEmailCount,
      preferences,
      feedbackRows,
      senderStats,
    ] = await Promise.all([
      Email.countDocuments(),
      Email.countDocuments({
        classificationSource: "ai",
        classificationStatus: "classified",
      }),
      Email.countDocuments({ classification: { $in: CATEGORIES } }),
      Email.countDocuments({
        $or: [
          { classification: "Unclassified" },
          {
            classificationStatus: {
              $in: ["failed", "unavailable", "timeout", "error"],
            },
          },
        ],
      }),
      Email.countDocuments({ priorityOverride: true }),
      Email.countDocuments({ classificationSource: "sender-feedback" }),
      Email.countDocuments({ classificationSource: "user-feedback" }),
      SenderPreference.find().sort({ updatedAt: -1 }).limit(1000).lean(),
      ClassificationFeedback.find().sort({ updatedAt: -1 }).lean(),
      Email.aggregate([
        { $match: { senderMail: { $type: "string", $ne: "" } } },
        {
          $group: {
            _id: { $toLower: "$senderMail" },
            senderName: { $first: "$senderName" },
            totalEmails: { $sum: 1 },
            highPriorityEmails: {
              $sum: { $cond: [{ $eq: ["$priorityLevel", "High"] }, 1, 0] },
            },
            mediumPriorityEmails: {
              $sum: { $cond: [{ $eq: ["$priorityLevel", "Medium"] }, 1, 0] },
            },
            lowPriorityEmails: {
              $sum: { $cond: [{ $eq: ["$priorityLevel", "Low"] }, 1, 0] },
            },
            manualOverrides: {
              $sum: { $cond: [{ $eq: ["$priorityOverride", true] }, 1, 0] },
            },
            personalizedEmails: {
              $sum: {
                $cond: [
                  { $eq: ["$classificationSource", "sender-feedback"] },
                  1,
                  0,
                ],
              },
            },
            userCorrectedEmails: {
              $sum: {
                $cond: [
                  { $eq: ["$classificationSource", "user-feedback"] },
                  1,
                  0,
                ],
              },
            },
          },
        },
        { $sort: { totalEmails: -1 } },
        { $limit: 300 },
      ]),
    ]);

    const preferenceBySender = new Map(
      preferences.map((item) => [safeLower(item.senderMail).trim(), item]),
    );
    const feedbackBySender = new Map();
    for (const row of feedbackRows) {
      const sender = safeLower(row.senderMail).trim();
      if (!sender) continue;
      if (!feedbackBySender.has(sender)) feedbackBySender.set(sender, []);
      feedbackBySender.get(sender).push(row);
    }

    const senderKeys = new Set(
      [
        ...senderStats.map((item) => item._id),
        ...preferences.map((item) => safeLower(item.senderMail).trim()),
        ...feedbackBySender.keys(),
      ].filter(Boolean),
    );
    const statsBySender = new Map(senderStats.map((item) => [item._id, item]));

    const senders = [...senderKeys]
      .map((senderMail) => {
        const pref = preferenceBySender.get(senderMail) || {};
        const stats = statsBySender.get(senderMail) || {};
        const rows = feedbackBySender.get(senderMail) || [];
        const counts = new Map();
        for (const row of rows) {
          if (CATEGORIES.includes(row.correctedCategory)) {
            counts.set(
              row.correctedCategory,
              (counts.get(row.correctedCategory) || 0) + 1,
            );
          }
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        const [topCategory, topCount] = ranked[0] || [null, 0];
        const agreementPct = rows.length
          ? Math.round((topCount / rows.length) * 100)
          : 0;
        return {
          senderMail,
          senderName: stats.senderName || senderMail,
          trusted: Boolean(pref.trusted),
          highCount: Number(pref.highCount || 0),
          mediumCount: Number(pref.mediumCount || 0),
          lowCount: Number(pref.lowCount || 0),
          priorityFeedbackCount: Number(pref.feedbackCount || 0),
          totalEmails: Number(stats.totalEmails || 0),
          highPriorityEmails: Number(stats.highPriorityEmails || 0),
          mediumPriorityEmails: Number(stats.mediumPriorityEmails || 0),
          lowPriorityEmails: Number(stats.lowPriorityEmails || 0),
          manualOverrides: Number(stats.manualOverrides || 0),
          personalizedEmails: Number(stats.personalizedEmails || 0),
          userCorrectedEmails: Number(stats.userCorrectedEmails || 0),
          categoryCorrectionCount: rows.length,
          agreementPct,
          mostCorrectedCategory: topCategory,
          learnedCategory: preferredCategoryFromFeedback(rows),
          categoryCounts: ranked.map(([category, count]) => ({
            category,
            count,
          })),
          lastCorrectionAt: rows[0]?.updatedAt || null,
          updatedAt: pref.updatedAt || rows[0]?.updatedAt || null,
        };
      })
      .sort(
        (a, b) =>
          b.totalEmails - a.totalEmails ||
          b.priorityFeedbackCount - a.priorityFeedbackCount ||
          a.senderMail.localeCompare(b.senderMail),
      );

    const recent = feedbackRows.slice(0, 20);
    const recentEmailIds = [
      ...new Set(recent.map((row) => row.emailId).filter(Boolean)),
    ];
    const recentEmails = recentEmailIds.length
      ? await Email.find({ id: { $in: recentEmailIds } })
          .select("id senderName senderMail subject date classification")
          .lean()
      : [];
    const recentEmailById = new Map(
      recentEmails.map((email) => [email.id, email]),
    );
    const recentCorrections = recent.map((row) => {
      const email = recentEmailById.get(row.emailId) || {};
      return {
        emailId: row.emailId,
        senderMail: row.senderMail || email.senderMail || "",
        senderName: email.senderName || row.senderMail || "Unknown sender",
        subject: email.subject || "Email no longer in the saved inbox",
        date: email.date || "",
        predictedCategory: row.predictedCategory || "Unclassified",
        correctedCategory: row.correctedCategory,
        updatedAt: row.updatedAt || row.createdAt || null,
      };
    });

    const priorityFeedbackCount = preferences.reduce(
      (sum, item) => sum + Number(item.feedbackCount || 0),
      0,
    );
    return res.json({
      stats: {
        totalEmails,
        aiClassifiedCount,
        aiSuccessRate: totalEmails
          ? Math.round((aiClassifiedCount / totalEmails) * 100)
          : 0,
        categorizedCount,
        failedClassificationCount,
        manualPriorityOverrides,
        personalizedEmailCount,
        userCorrectedEmailCount,
        categoryCorrectionCount: feedbackRows.length,
        learnedSenderRules: senders.filter((item) => item.learnedCategory)
          .length,
        trustedSenderCount: preferences.filter((item) => item.trusted).length,
        priorityFeedbackCount,
      },
      senders,
      recentCorrections,
      learningPolicy: {
        minimumCorrections: 3,
        minimumAgreementPct: 80,
        note: "Sender-level category preferences affect only new or unclassified emails. Existing corrected messages are not silently recategorized during normal fetching.",
      },
    });
  } catch (error) {
    console.error("Personalization overview failed:", error.message);
    return res
      .status(500)
      .json({ error: "Could not load personalization insights" });
  }
});

// Reset category learning only after explicit confirmation in the UI.
// This reverts user/sender-feedback categories to the stored model category and removes correction history.
app.post("/personalization/reset-category-learning", async (req, res) => {
  try {
    const affected = await Email.find({
      classificationSource: { $in: ["user-feedback", "sender-feedback"] },
    }).lean();
    const senderMails = [
      ...new Set(
        affected
          .map((item) => safeLower(item.senderMail).trim())
          .filter(Boolean),
      ),
    ];
    const preferences = senderMails.length
      ? await SenderPreference.find({ senderMail: { $in: senderMails } }).lean()
      : [];
    const preferenceBySender = new Map(
      preferences.map((item) => [safeLower(item.senderMail).trim(), item]),
    );
    const updates = [];
    const bulkOperations = affected.map((email) => {
      const restoredCategory = CATEGORIES.includes(email.modelClassification)
        ? email.modelClassification
        : "Unclassified";
      const set = {
        classification: restoredCategory,
        classificationSource:
          restoredCategory === "Unclassified" ? "existing" : "model",
        classificationStatus:
          restoredCategory === "Unclassified" ? "failed" : "restored-model",
      };
      if (!email.priorityOverride) {
        const preference =
          preferenceBySender.get(safeLower(email.senderMail).trim()) || null;
        Object.assign(
          set,
          computePriority(
            { ...email, classification: restoredCategory },
            preference,
          ),
        );
      }
      updates.push({
        id: email.id,
        classification: set.classification,
        modelClassification: email.modelClassification || "Unclassified",
        classificationSource: set.classificationSource,
        classificationStatus: set.classificationStatus,
        priorityLevel: set.priorityLevel || email.priorityLevel,
        priorityScore: set.priorityScore ?? email.priorityScore,
        priorityReasons: set.priorityReasons || email.priorityReasons,
        priorityOverride: Boolean(email.priorityOverride),
      });
      return { updateOne: { filter: { id: email.id }, update: { $set: set } } };
    });
    if (bulkOperations.length) await Email.bulkWrite(bulkOperations);
    const deleted = await ClassificationFeedback.deleteMany({});
    return res.json({
      removedCorrections: Number(deleted.deletedCount || 0),
      revertedEmails: affected.length,
      updatedEmails: updates,
      message:
        "Category corrections and sender-level category learning were reset. Trusted senders and manual priority overrides were preserved.",
    });
  } catch (error) {
    console.error("Category learning reset failed:", error.message);
    return res.status(500).json({ error: "Could not reset category learning" });
  }
});

// Reset only aggregate sender-level priority feedback; keep trust choices and explicit per-email overrides.
app.post("/personalization/reset-priority-learning", async (req, res) => {
  try {
    const result = await SenderPreference.updateMany(
      {},
      { $set: { highCount: 0, mediumCount: 0, lowCount: 0, feedbackCount: 0 } },
    );
    return res.json({
      resetSenderPreferences: Number(
        result.modifiedCount || result.nModified || 0,
      ),
      message:
        "Sender-level priority feedback counts were reset. Trusted-sender flags and existing manual priority overrides were preserved.",
    });
  } catch (error) {
    console.error("Priority learning reset failed:", error.message);
    return res.status(500).json({ error: "Could not reset priority learning" });
  }
});

app.post("/logout", (req, res) => {
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
    oAuth2Client.setCredentials({});
    res.sendStatus(200);
  } catch (error) {
    console.error("Logout failed:", error.message);
    res.status(500).json({ error: "Logout failed" });
  }
});

const PORT = Number(process.env.PORT || 5000);
if (require.main === module) {
  app.listen(PORT, () =>
    console.log(`Server is running on http://localhost:${PORT}`),
  );
}
module.exports = { app, formatDate, parseSender };
