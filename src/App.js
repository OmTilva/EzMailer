import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import axios from "axios";

const API = "http://localhost:5000";
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

const priorityClasses = {
  High: "bg-red-100 text-red-800 border-red-200",
  Medium: "bg-amber-100 text-amber-800 border-amber-200",
  Low: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

const ACTION_SIGNAL_RE =
  /\b(action required|respond|reply|submit|complete|upload|pay|payment due|interview|assessment|placement drive|exam|register|confirm|verify|update|review|attend|join|schedule|book|sign|accept|renew|fill out|fill in|application deadline|deadline|due date|due by|required to|must)\b/i;

function parseEmailReceivedDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = text.match(
    /^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (match) {
    const [, day, month, year, hour = "0", minute = "0", second = "0"] = match;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDeadlineFromText(text, referenceDate) {
  const source = String(text || "");
  const base = referenceDate || new Date();

  const relative = source.match(/\b(?:within|in)\s+(\d{1,2})\s+days?\b/i);
  if (relative) {
    const date = new Date(base);
    date.setDate(date.getDate() + Number(relative[1]));
    date.setHours(23, 59, 0, 0);
    return date;
  }
  if (/\btomorrow\b/i.test(source)) {
    const date = new Date(base);
    date.setDate(date.getDate() + 1);
    date.setHours(23, 59, 0, 0);
    return date;
  }
  if (/\btoday\b|\bby end of day\b/i.test(source)) {
    const date = new Date(base);
    date.setHours(23, 59, 0, 0);
    return date;
  }

  let match = source.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (match) {
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      23,
      59,
      0,
      0,
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Numeric dates are interpreted as DD/MM/YYYY by default (common in India).
  match = source.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (match) {
    let first = Number(match[1]);
    let second = Number(match[2]);
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    let day = first;
    let month = second;
    if (first <= 12 && second > 12) {
      month = first;
      day = second;
    }
    const date = new Date(year, month - 1, day, 23, 59, 0, 0);
    if (
      !Number.isNaN(date.getTime()) &&
      date.getDate() === day &&
      date.getMonth() === month - 1
    ) {
      return date;
    }
  }

  const monthPattern =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const months = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  const monthFirst = new RegExp(
    "\\b" +
      monthPattern +
      "\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b",
    "i",
  );
  const dayFirst = new RegExp(
    "\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+" +
      monthPattern +
      "\\.?[,]?(?:\\s+(20\\d{2}))?\\b",
    "i",
  );
  let year;
  let month;
  let day;
  match = source.match(monthFirst);
  if (match) {
    month = months[match[1].toLowerCase()];
    day = Number(match[2]);
    year = Number(match[3] || base.getFullYear());
  } else {
    match = source.match(dayFirst);
    if (match) {
      day = Number(match[1]);
      month = months[match[2].toLowerCase()];
      year = Number(match[3] || base.getFullYear());
    }
  }
  if (match && Number.isInteger(month) && day >= 1 && day <= 31) {
    let date = new Date(year, month, day, 23, 59, 0, 0);
    if (date.getDate() === day && date.getMonth() === month) {
      // A yearless date in the past is likely the next occurrence.
      if (!match[3] && date < base)
        date = new Date(year + 1, month, day, 23, 59, 0, 0);
      return date;
    }
  }
  return null;
}

function extractAttentionItems(email) {
  const content = [email.subject || "", email.snippet || "", email.body || ""]
    .join("\n")
    .trim();
  if (!content) return [];

  const referenceDate = parseEmailReceivedDate(email.date) || new Date();
  const sentences = content
    .split(/[\r\n]+|(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const candidates = [];
  for (const sentence of sentences) {
    if (!ACTION_SIGNAL_RE.test(sentence)) continue;
    if (
      /unsubscribe|view in browser|manage preferences/i.test(sentence) &&
      !/deadline|payment due|action required|must|required to/i.test(sentence)
    )
      continue;

    const deadline = parseDeadlineFromText(sentence, referenceDate);
    const kind =
      /interview|placement|assessment|recruit|job offer|application/i.test(
        sentence,
      )
        ? "Career"
        : /pay|payment|invoice|bill|transaction/i.test(sentence)
          ? "Payment"
          : /security|verify|account|otp|password/i.test(sentence)
            ? "Security"
            : /deadline|due date|submit|complete|upload|register|respond|reply/i.test(
                  sentence,
                )
              ? "Deadline / action"
              : "Action";
    const summary =
      sentence.length > 210 ? sentence.slice(0, 207).trimEnd() + "…" : sentence;
    const dedupeKey = summary.toLowerCase();
    if (candidates.some((item) => item.dedupeKey === dedupeKey)) continue;
    candidates.push({
      summary,
      deadline: deadline ? deadline.toISOString() : null,
      kind,
      dedupeKey,
    });
    if (candidates.length >= 8) break;
  }

  // Handle common two-line patterns such as "Please submit the form.\nDeadline: 30 October 2026."
  const deadlineSentence = sentences.find(
    (sentence) =>
      /\b(deadline|due date|due by|no later than|before)\b/i.test(sentence) &&
      parseDeadlineFromText(sentence, referenceDate),
  );
  const sharedDeadline = deadlineSentence
    ? parseDeadlineFromText(deadlineSentence, referenceDate)
    : null;

  return candidates
    .map((item, index) => ({
      ...item,
      deadline:
        item.deadline ||
        (candidates.length === 1 && sharedDeadline
          ? sharedDeadline.toISOString()
          : null),
      key: `${email.id || "email"}:${item.summary.toLowerCase().slice(0, 100)}`,
    }))
    .map(({ dedupeKey, ...item }) => item);
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unknown";
  return date.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// Heuristic security signals are warnings for human review, not definitive phishing verdicts.
function inspectEmailSecurity(email) {
  const text = `${email.subject || ""}\n${email.snippet || ""}\n${email.body || ""}`;
  const senderName = String(email.senderName || "");
  const subjectClaimsAccountAction =
    /\b(security|account|verify|verification|password|suspended|login|sign in|billing|payment|support|alert|notification)\b/i.test(
      String(email.subject || ""),
    );
  const senderMail = String(email.senderMail || "").toLowerCase();
  const senderDomain = senderMail.includes("@")
    ? senderMail.split("@").pop()
    : "";
  const urls = [...text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)]
    .map((match) => {
      try {
        return new URL(match[0].replace(/[.,;!?]+$/, ""));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const reasons = [];
  let score = 0;
  let riskyUrl = false;
  const shorteners = new Set([
    "bit.ly",
    "tinyurl.com",
    "t.co",
    "rb.gy",
    "is.gd",
    "cutt.ly",
    "rebrand.ly",
  ]);

  if (urls.some((url) => shorteners.has(url.hostname.toLowerCase()))) {
    score += 2;
    riskyUrl = true;
    reasons.push("Contains a shortened link that hides the final destination.");
  }
  if (
    urls.some(
      (url) =>
        /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) ||
        url.hostname.toLowerCase().includes("xn--"),
    )
  ) {
    score += 2;
    riskyUrl = true;
    reasons.push(
      "Contains a link using an IP address or an internationalized/punycode domain.",
    );
  }
  if (urls.some((url) => url.protocol === "http:")) {
    score += 1;
    reasons.push("Contains a link that does not use HTTPS.");
  }

  const credentialRequest =
    /\b(?:send|share|reply with|provide|tell us|confirm|submit)\s+(?:us\s+)?(?:your\s+)?(?:password|otp|one[- ]time (?:password|code)|verification code|security code|pin|recovery code|bank details|card number)\b/i.test(
      text,
    ) ||
    /\b(?:enter|type)\s+(?:your\s+)?password\s+(?:to avoid|or your account|immediately|within)\b/i.test(
      text,
    );
  if (credentialRequest) {
    score += 3;
    reasons.push(
      "Appears to ask you to send or enter sensitive account/financial information.",
    );
  }

  const urgentThreat =
    /\b(account (?:will be|has been|is being) suspended|final warning|immediate action required|within\s+\d+\s+hours?|expires? in\s+\d+\s+(?:minutes?|hours?)|account will be closed|urgent action required)\b/i.test(
      text,
    );
  if (urgentThreat) {
    score += 1;
    reasons.push(
      "Uses urgent or threatening language to pressure a quick response.",
    );
  }

  const moneyPressure =
    /\b(?:buy|send|pay with|purchase)\s+(?:a\s+)?(?:gift card|crypto(?:currency)?|bitcoin)|wire transfer immediately|transfer funds urgently|pay this invoice immediately\b/i.test(
      text,
    );
  if (moneyPressure) {
    score += 2;
    reasons.push(
      "Contains an unusual urgent money-transfer or gift-card request.",
    );
  }

  const brandRules = [
    {
      name: "Google",
      brand: /google/i,
      domains: ["google.com", "googlemail.com"],
    },
    {
      name: "Microsoft",
      brand: /microsoft/i,
      domains: [
        "microsoft.com",
        "office.com",
        "live.com",
        "outlook.com",
        "hotmail.com",
      ],
    },
    { name: "PayPal", brand: /paypal/i, domains: ["paypal.com"] },
    { name: "Apple", brand: /apple/i, domains: ["apple.com", "icloud.com"] },
    {
      name: "Amazon",
      brand: /amazon/i,
      domains: ["amazon.com", "amazon.in", "amazonaws.com"],
    },
    { name: "LinkedIn", brand: /linkedin/i, domains: ["linkedin.com"] },
  ];
  const freeMailDomains = new Set([
    "gmail.com",
    "yahoo.com",
    "outlook.com",
    "hotmail.com",
    "protonmail.com",
  ]);
  const claimedBrand = brandRules.find(
    (rule) =>
      rule.brand.test(senderName) ||
      (subjectClaimsAccountAction &&
        rule.brand.test(String(email.subject || ""))),
  );
  if (
    claimedBrand &&
    senderDomain &&
    freeMailDomains.has(senderDomain) &&
    !claimedBrand.domains.some(
      (domain) =>
        senderDomain === domain || senderDomain.endsWith(`.${domain}`),
    )
  ) {
    score += 2;
    reasons.push(
      `The sender uses a free-mail domain while the message appears to claim affiliation with ${claimedBrand.name}.`,
    );
  }

  if (credentialRequest && urgentThreat) {
    reasons.push(
      "Sensitive-information request combined with urgency is a strong warning sign.",
    );
    score += 1;
  }
  const risk =
    score >= 4 || (credentialRequest && (urgentThreat || riskyUrl))
      ? "High"
      : score >= 2
        ? "Review"
        : "None";
  return {
    risk,
    score,
    reasons: [...new Set(reasons)],
    urlCount: urls.length,
    senderDomain,
    warning:
      "Automated heuristic only. Verify the sender and destination independently; a warning is not proof of phishing.",
  };
}

const App = () => {
  const [accessToken, setAccessToken] = useState(null);
  const [allEmails, setAllEmails] = useState([]);
  const [date, setDate] = useState("");
  const [selectedEmailId, setSelectedEmailId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [sortBy, setSortBy] = useState("priority");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [activeView, setActiveView] = useState("inbox");
  const [retryingId, setRetryingId] = useState(null);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [evaluationError, setEvaluationError] = useState("");
  const [attentionFilter, setAttentionFilter] = useState("focus");
  const [attentionSearch, setAttentionSearch] = useState("");
  const [attentionKind, setAttentionKind] = useState("All");
  const [expandedAttentionEmails, setExpandedAttentionEmails] = useState({});
  const [attentionDone, setAttentionDone] = useState(() => {
    try {
      return typeof window !== "undefined"
        ? JSON.parse(
            window.localStorage.getItem("ezmail-attention-done") || "{}",
          )
        : {};
    } catch {
      return {};
    }
  });
  const [securitySearch, setSecuritySearch] = useState("");
  const [securityFilter, setSecurityFilter] = useState("All");
  const [savingCategoryId, setSavingCategoryId] = useState(null);
  const [personalizationData, setPersonalizationData] = useState(null);
  const [personalizationLoading, setPersonalizationLoading] = useState(false);
  const [personalizationError, setPersonalizationError] = useState("");
  const [personalizationSearch, setPersonalizationSearch] = useState("");
  const [personalizationBusy, setPersonalizationBusy] = useState("");
  const [threadGroups, setThreadGroups] = useState([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [threadSearch, setThreadSearch] = useState("");
  const [selectedThreadGroup, setSelectedThreadGroup] = useState(null);
  const [selectedThread, setSelectedThread] = useState(null);
  const [threadSummary, setThreadSummary] = useState(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyTone, setReplyTone] = useState("Professional");
  const [replyInstructions, setReplyInstructions] = useState("");
  const [threadAssistantBusy, setThreadAssistantBusy] = useState("");
  const [threadAssistantError, setThreadAssistantError] = useState("");
  const [threadAssistantMessage, setThreadAssistantMessage] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadPersonalization = useCallback(async () => {
    setPersonalizationLoading(true);
    setPersonalizationError("");
    try {
      const response = await axios.get(`${API}/personalization/overview`);
      setPersonalizationData(response.data);
    } catch (err) {
      setPersonalizationError(
        err.response?.data?.error || "Could not load personalization insights.",
      );
    } finally {
      setPersonalizationLoading(false);
    }
  }, []);

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    setThreadsError("");
    try {
      const response = await axios.get(`${API}/threads`);
      setThreadGroups(Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      setThreadsError(
        err.response?.data?.error || "Could not load saved conversations.",
      );
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeView === "personalization" && accessToken) {
      loadPersonalization();
    }
  }, [activeView, accessToken, loadPersonalization]);

  useEffect(() => {
    if (activeView === "threads" && accessToken) loadThreads();
  }, [activeView, accessToken, loadThreads]);

  useEffect(() => {
    let active = true;
    fetch(`${API}/check-auth`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((data) => {
        if (active && data?.accessToken) setAccessToken(data.accessToken);
      })
      .catch((err) => console.error("Error checking auth status:", err));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "ezmail-attention-done",
        JSON.stringify(attentionDone),
      );
    } catch (storageError) {
      console.warn(
        "Could not persist Needs attention checkboxes:",
        storageError,
      );
    }
  }, [attentionDone]);

  // Load action completion state from MongoDB so it survives browser/device changes.
  useEffect(() => {
    const emailIds = allEmails.map((email) => email.id).filter(Boolean);
    if (!emailIds.length) return undefined;
    let cancelled = false;
    axios
      .get(`${API}/action-items`, { params: { emailIds: emailIds.join(",") } })
      .then(async ({ data }) => {
        if (cancelled || !Array.isArray(data)) return;
        const storedKeys = new Set(data.map((item) => item.key));
        setAttentionDone((current) => {
          const next = { ...current };
          data.forEach((item) => {
            next[item.key] = Boolean(item.done);
          });
          return next;
        });
        // Migrate already-completed browser-only tasks into MongoDB once.
        let localState = {};
        try {
          localState = JSON.parse(
            window.localStorage.getItem("ezmail-attention-done") || "{}",
          );
        } catch {}
        const extracted = allEmails.flatMap((email) =>
          extractAttentionItems(email).map((item) => ({ ...item, email })),
        );
        await Promise.all(
          extracted
            .filter(
              (item) =>
                localState[item.key] === true && !storedKeys.has(item.key),
            )
            .map((item) =>
              axios
                .post(`${API}/action-items/state`, {
                  key: item.key,
                  emailId: item.email.id,
                  summary: item.summary,
                  kind: item.kind,
                  deadline: item.deadline || null,
                  done: true,
                })
                .catch((error) =>
                  console.warn(
                    "Could not migrate one completed action:",
                    error.message,
                  ),
                ),
            ),
        );
      })
      .catch((error) =>
        console.warn("Could not load saved action items:", error.message),
      );
    return () => {
      cancelled = true;
    };
  }, [allEmails]);

  const attentionItems = useMemo(
    () =>
      allEmails.flatMap((email) =>
        extractAttentionItems(email).map((item) => ({ ...item, email })),
      ),
    [allEmails],
  );

  const attentionRows = useMemo(
    () =>
      attentionItems.map((item) => {
        const done = Boolean(attentionDone[item.key]);
        const due = item.deadline ? new Date(item.deadline) : null;
        const validDue = due && !Number.isNaN(due.getTime()) ? due : null;
        const today = new Date();
        const todayDay = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
        );
        const dueDay = validDue
          ? new Date(
              validDue.getFullYear(),
              validDue.getMonth(),
              validDue.getDate(),
            )
          : null;
        const daysLeft = dueDay
          ? Math.round((dueDay - todayDay) / 86400000)
          : null;
        const dueLabel = !validDue
          ? "No date detected"
          : daysLeft < 0
            ? `Overdue by ${Math.abs(daysLeft)} day(s)`
            : daysLeft === 0
              ? "Due today"
              : daysLeft <= 3
                ? `Due in ${daysLeft} day(s)`
                : `Due ${formatShortDate(validDue)}`;
        const focus =
          !done &&
          ((daysLeft !== null && daysLeft <= 3) ||
            item.email.priorityLevel === "High");
        const urgencyRank = done
          ? 6
          : daysLeft !== null && daysLeft < 0
            ? 0
            : daysLeft === 0
              ? 1
              : daysLeft !== null && daysLeft <= 3
                ? 2
                : item.email.priorityLevel === "High"
                  ? 3
                  : daysLeft !== null
                    ? 4
                    : 5;
        return {
          ...item,
          done,
          due: validDue,
          daysLeft,
          dueLabel,
          focus,
          urgencyRank,
        };
      }),
    [attentionItems, attentionDone],
  );

  const filteredAttentionItems = useMemo(() => {
    const query = attentionSearch.trim().toLowerCase();
    return attentionRows
      .filter((item) => {
        let viewMatch = true;
        if (attentionFilter === "focus") viewMatch = item.focus;
        else if (attentionFilter === "open") viewMatch = !item.done;
        else if (attentionFilter === "overdue")
          viewMatch = !item.done && item.daysLeft !== null && item.daysLeft < 0;
        else if (attentionFilter === "soon")
          viewMatch =
            !item.done &&
            item.daysLeft !== null &&
            item.daysLeft >= 0 &&
            item.daysLeft <= 3;
        else if (attentionFilter === "undated")
          viewMatch = !item.done && item.daysLeft === null;
        else if (attentionFilter === "completed") viewMatch = item.done;
        const kindMatch =
          attentionKind === "All" || item.kind === attentionKind;
        const searchHaystack = [
          item.summary,
          item.email.subject,
          item.email.senderName,
          item.email.senderMail,
        ]
          .join(" ")
          .toLowerCase();
        return (
          viewMatch && kindMatch && (!query || searchHaystack.includes(query))
        );
      })
      .sort(
        (a, b) =>
          a.urgencyRank - b.urgencyRank ||
          (a.daysLeft ?? 99999) - (b.daysLeft ?? 99999) ||
          String(a.email.subject || "").localeCompare(
            String(b.email.subject || ""),
          ),
      );
  }, [attentionRows, attentionFilter, attentionKind, attentionSearch]);

  const attentionGroups = useMemo(() => {
    const groups = new Map();
    for (const item of filteredAttentionItems) {
      const groupKey = String(item.email.id || item.email.subject || item.key);
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          key: groupKey,
          email: item.email,
          items: [],
          urgencyRank: item.urgencyRank,
        });
      }
      const group = groups.get(groupKey);
      group.items.push(item);
      group.urgencyRank = Math.min(group.urgencyRank, item.urgencyRank);
    }
    return [...groups.values()].sort((a, b) => a.urgencyRank - b.urgencyRank);
  }, [filteredAttentionItems]);

  const attentionCounts = useMemo(
    () => ({
      open: attentionRows.filter((item) => !item.done).length,
      overdue: attentionRows.filter(
        (item) => !item.done && item.daysLeft !== null && item.daysLeft < 0,
      ).length,
      soon: attentionRows.filter(
        (item) =>
          !item.done &&
          item.daysLeft !== null &&
          item.daysLeft >= 0 &&
          item.daysLeft <= 3,
      ).length,
      undated: attentionRows.filter(
        (item) => !item.done && item.daysLeft === null,
      ).length,
      focus: attentionRows.filter((item) => item.focus).length,
      completed: attentionRows.filter((item) => item.done).length,
    }),
    [attentionRows],
  );

  const securityFindings = useMemo(() => {
    const query = securitySearch.trim().toLowerCase();
    return allEmails
      .map((email) => ({ email, ...inspectEmailSecurity(email) }))
      .filter((item) => item.risk !== "None")
      .filter(
        (item) => securityFilter === "All" || item.risk === securityFilter,
      )
      .filter(
        (item) =>
          !query ||
          [
            item.email.senderName,
            item.email.senderMail,
            item.email.subject,
            item.email.snippet,
            ...item.reasons,
          ]
            .join(" ")
            .toLowerCase()
            .includes(query),
      )
      .sort(
        (a, b) =>
          (a.risk === "High" ? 0 : 1) - (b.risk === "High" ? 0 : 1) ||
          b.score - a.score,
      );
  }, [allEmails, securitySearch, securityFilter]);

  const securityCounts = useMemo(() => {
    const analyses = allEmails.map((email) => ({
      email,
      ...inspectEmailSecurity(email),
    }));
    return {
      high: analyses.filter((item) => item.risk === "High").length,
      review: analyses.filter((item) => item.risk === "Review").length,
      scanned: analyses.length,
    };
  }, [allEmails]);

  const analytics = useMemo(() => {
    const categoryCounts = [
      ...CATEGORIES.map((category) => ({
        category,
        count: allEmails.filter((email) => email.classification === category)
          .length,
      })),
      {
        category: "Unclassified",
        count: allEmails.filter(
          (email) => !CATEGORIES.includes(email.classification),
        ).length,
      },
    ];
    const reasonCounts = new Map();
    for (const email of allEmails) {
      for (const reason of email.priorityReasons || []) {
        const label = String(reason || "").trim();
        if (label) reasonCounts.set(label, (reasonCounts.get(label) || 0) + 1);
      }
    }
    const daily = new Map();
    for (const email of allEmails) {
      const parsed = parseEmailReceivedDate(email.date);
      if (!parsed) continue;
      const key = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
      const item = daily.get(key) || { date: key, count: 0 };
      if (email.priorityLevel === "High") item.count += 1;
      daily.set(key, item);
    }
    const highPriorityTrend = [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-7);
    const successfulAI = allEmails.filter(
      (email) =>
        String(email.classificationStatus || "").toLowerCase() ===
          "classified" && CATEGORIES.includes(email.classification),
    ).length;
    return {
      categoryCounts,
      reasonCounts: [...reasonCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      highPriorityTrend,
      successfulAI,
      aiSuccessRate: allEmails.length
        ? Math.round((successfulAI / allEmails.length) * 100)
        : 0,
    };
  }, [allEmails]);

  const runClassificationEvaluation = async () => {
    setEvaluationLoading(true);
    setEvaluationError("");
    setEvaluationResult(null);
    try {
      const response = await axios.post(`${API}/evaluate-classification`);
      setEvaluationResult(response.data);
    } catch (err) {
      setEvaluationError(
        err.response?.data?.error ||
          "Evaluation failed. Check that the backend and Gemini classifier are running.",
      );
    } finally {
      setEvaluationLoading(false);
    }
  };

  const retryClassification = async (email) => {
    setRetryingId(email.id);
    setError("");
    setMessage("");
    try {
      const response = await axios.post(`${API}/retry-classification`, {
        emailId: email.id,
      });
      setAllEmails((current) =>
        current.map((item) =>
          item.id === email.id ? { ...item, ...response.data } : item,
        ),
      );
      setMessage(
        `Classification retried for "${email.subject || "Untitled email"}".`,
      );
    } catch (err) {
      setError(
        err.response?.data?.error || "Could not retry this classification.",
      );
    } finally {
      setRetryingId(null);
    }
  };

  const login = () => {
    window.location.href = `${API}/auth/google`;
  };

  const runFetch = useCallback(async (url, body) => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${API}${url}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || `Request failed (${response.status})`);
      const fetched = Array.isArray(data) ? data : data.emails;
      if (!Array.isArray(fetched))
        throw new Error("The server returned an unexpected response.");
      setAllEmails(fetched);
      setSelectedEmailId(null);
      setPriorityFilter("All");
      setCategoryFilter("All");
      setMessage(
        `${fetched.length} email(s) fetched and saved. ${data.classificationWarning || ""}`.trim(),
      );
    } catch (err) {
      setError(
        err.message ||
          "Unable to fetch emails. Check that the backend is running.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchAllEmails = () => runFetch("/fetch-lastHundred");
  const fetchEmailsByDate = () => {
    if (!date) {
      setError("Choose a date before fetching emails.");
      return;
    }
    runFetch("/fetch-emails", { date });
  };

  const fetchPriorities = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const response = await axios.get(`${API}/fetch-priorities`);
      setAllEmails(response.data);
      setPriorityFilter("High");
      setCategoryFilter("All");
      setMessage(
        `${response.data.length} high-priority email(s) loaded from MongoDB.`,
      );
    } catch (err) {
      setError(err.response?.data?.error || "Could not load priority emails.");
    } finally {
      setLoading(false);
    }
  };

  const changePriority = async (email, priorityLevel) => {
    try {
      setError("");
      const response = await axios.post(`${API}/set-priority`, {
        emailId: email.id,
        priorityLevel,
      });
      const updated = response.data;
      setAllEmails((current) =>
        current.map((item) =>
          item.id === email.id ? { ...item, ...updated } : item,
        ),
      );
      setMessage(
        `Priority saved as ${priorityLevel}. This choice will inform future scoring for this sender.`,
      );
    } catch (err) {
      setError(err.response?.data?.error || "Could not update priority.");
    }
  };

  const toggleTrustedSender = async (email) => {
    if (!email.senderMail) {
      setError("This email does not contain a valid sender address.");
      return;
    }
    try {
      setError("");
      const response = await axios.post(`${API}/sender-preferences/toggle`, {
        senderMail: email.senderMail,
      });
      const trusted = response.data.trusted;
      setAllEmails((current) =>
        current.map((item) =>
          item.senderMail?.toLowerCase() === email.senderMail.toLowerCase()
            ? { ...item, senderTrusted: trusted }
            : item,
        ),
      );
      setMessage(
        `${email.senderMail} ${trusted ? "added to" : "removed from"} trusted senders.`,
      );
    } catch (err) {
      setError(err.response?.data?.error || "Could not update trusted sender.");
    }
  };

  const updateAttentionDone = async (item, done) => {
    setAttentionDone((current) => ({ ...current, [item.key]: done }));
    try {
      await axios.post(`${API}/action-items/state`, {
        key: item.key,
        emailId: item.email.id,
        summary: item.summary,
        kind: item.kind,
        deadline: item.deadline || null,
        done,
      });
    } catch (err) {
      setError(
        err.response?.data?.error ||
          "Could not save this action item's completion state.",
      );
    }
  };

  const changeClassification = async (email, classification) => {
    if (
      !CATEGORIES.includes(classification) ||
      classification === email.classification
    )
      return;
    setSavingCategoryId(email.id);
    setError("");
    setMessage("");
    try {
      const response = await axios.post(`${API}/set-classification`, {
        emailId: email.id,
        classification,
      });
      setAllEmails((current) =>
        current.map((item) =>
          item.id === email.id ? { ...item, ...response.data } : item,
        ),
      );
      setMessage(
        `Saved your category correction for "${email.subject || "Untitled email"}". Consistent corrections from the same sender can guide future classifications.`,
      );
    } catch (err) {
      setError(
        err.response?.data?.error || "Could not save this category correction.",
      );
    } finally {
      setSavingCategoryId(null);
    }
  };

  const toggleTrustedFromCenter = async (senderMail) => {
    if (!senderMail) return;
    setPersonalizationBusy(`trust:${senderMail}`);
    setPersonalizationError("");
    try {
      const response = await axios.post(`${API}/sender-preferences/toggle`, {
        senderMail,
      });
      const trusted = Boolean(response.data.trusted);
      setAllEmails((current) =>
        current.map((email) =>
          email.senderMail?.toLowerCase() === senderMail.toLowerCase()
            ? { ...email, senderTrusted: trusted }
            : email,
        ),
      );
      await loadPersonalization();
      setMessage(
        `${senderMail} ${trusted ? "added to" : "removed from"} trusted senders.`,
      );
    } catch (err) {
      setPersonalizationError(
        err.response?.data?.error || "Could not update this sender preference.",
      );
    } finally {
      setPersonalizationBusy("");
    }
  };

  const resetCategoryLearning = async () => {
    const confirmed = window.confirm(
      "Reset category learning? This deletes correction history and reverts user-corrected/personalized email categories to their stored model category. Trusted senders and manual priority overrides are preserved.",
    );
    if (!confirmed) return;
    setPersonalizationBusy("reset-category");
    setPersonalizationError("");
    setError("");
    try {
      const response = await axios.post(
        `${API}/personalization/reset-category-learning`,
      );
      const updatedById = new Map(
        (response.data.updatedEmails || []).map((email) => [email.id, email]),
      );
      setAllEmails((current) =>
        current.map((email) =>
          updatedById.has(email.id)
            ? { ...email, ...updatedById.get(email.id) }
            : email,
        ),
      );
      setMessage(response.data.message || "Category learning reset.");
      await loadPersonalization();
    } catch (err) {
      setPersonalizationError(
        err.response?.data?.error || "Could not reset category learning.",
      );
    } finally {
      setPersonalizationBusy("");
    }
  };

  const resetPriorityLearning = async () => {
    const confirmed = window.confirm(
      "Reset sender-level priority feedback counts? This does not change trusted-sender flags or existing manual priority overrides.",
    );
    if (!confirmed) return;
    setPersonalizationBusy("reset-priority");
    setPersonalizationError("");
    try {
      const response = await axios.post(
        `${API}/personalization/reset-priority-learning`,
      );
      setMessage(response.data.message || "Priority learning counts reset.");
      await loadPersonalization();
    } catch (err) {
      setPersonalizationError(
        err.response?.data?.error || "Could not reset priority learning.",
      );
    } finally {
      setPersonalizationBusy("");
    }
  };

  const openThread = async (group) => {
    setSelectedThreadGroup(group);
    setSelectedThread(null);
    setThreadSummary(null);
    setReplyDraft("");
    setThreadAssistantError("");
    setThreadAssistantMessage("");
    setThreadsError("");
    setThreadsLoading(true);
    try {
      const response = await axios.post(`${API}/threads/content`, {
        threadId: group.threadId || undefined,
        emailIds: group.emailIds || [],
      });
      setSelectedThread(response.data);
    } catch (err) {
      setThreadsError(
        err.response?.data?.error || "Could not open this conversation.",
      );
    } finally {
      setThreadsLoading(false);
    }
  };

  const runThreadAssistant = async (task) => {
    if (!selectedThread) return;
    setThreadAssistantBusy(task);
    setThreadAssistantError("");
    setThreadAssistantMessage("");
    try {
      const response = await axios.post(`${API}/assistant/${task}`, {
        threadId: selectedThread.threadId || undefined,
        emailIds: (selectedThread.messages || [])
          .map((email) => email.id)
          .filter(Boolean)
          .slice(-25),
        tone: replyTone,
        instructions: replyInstructions,
      });
      if (task === "summarize") {
        setThreadSummary(response.data);
      } else {
        setReplyDraft(response.data.replyDraft || "");
        setThreadAssistantMessage(
          "Draft created for your review. It has not been sent.",
        );
      }
    } catch (err) {
      setThreadAssistantError(
        err.response?.data?.error ||
          (task === "summarize"
            ? "Could not summarize this conversation."
            : "Could not draft a reply."),
      );
    } finally {
      setThreadAssistantBusy("");
    }
  };

  const copyReplyDraft = async () => {
    if (!replyDraft) return;
    try {
      await navigator.clipboard.writeText(replyDraft);
      setThreadAssistantMessage(
        "Reply draft copied to clipboard. It has not been sent.",
      );
    } catch (err) {
      setThreadAssistantError(
        "Clipboard access was blocked. Select and copy the draft manually.",
      );
    }
  };

  const filteredThreadGroups = useMemo(() => {
    const query = threadSearch.trim().toLowerCase();
    return threadGroups.filter((group) => {
      const haystack = [
        group.subject,
        ...(group.senders || []),
        group.latestDate,
      ]
        .join(" ")
        .toLowerCase();
      return !query || haystack.includes(query);
    });
  }, [threadGroups, threadSearch]);

  const logout = async () => {
    try {
      await axios.post(`${API}/logout`);
      setAccessToken(null);
      setAllEmails([]);
      setSelectedEmailId(null);
      setMessage("Logged out successfully.");
      setError("");
    } catch (err) {
      setError(err.response?.data?.error || "Logout failed.");
    }
  };

  const visibleEmails = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    const filtered = allEmails.filter((email) => {
      const priorityMatch =
        priorityFilter === "All" || email.priorityLevel === priorityFilter;

      const categoryMatch =
        categoryFilter === "All" || email.classification === categoryFilter;

      const searchHaystack = [
        email.senderName,
        email.senderMail,
        email.subject,
        email.snippet,
        email.body,
        email.classification,
      ]
        .join(" ")
        .toLowerCase();

      // Supports common unread fields from Gmail/backend responses.
      const isUnread =
        email.isRead === false ||
        email.isUnread === true ||
        email.unread === true ||
        email.labelIds?.includes("UNREAD");

      const unreadMatch = !unreadOnly || isUnread;

      return (
        priorityMatch &&
        categoryMatch &&
        unreadMatch &&
        (!query || searchHaystack.includes(query))
      );
    });

    const priorityRank = { High: 3, Medium: 2, Low: 1 };

    return filtered.sort((a, b) => {
      if (sortBy === "priority") {
        const rankDifference =
          (priorityRank[b.priorityLevel] || 0) -
          (priorityRank[a.priorityLevel] || 0);

        if (rankDifference !== 0) return rankDifference;

        return (b.priorityScore ?? 0) - (a.priorityScore ?? 0);
      }

      if (sortBy === "newest") {
        const dateA = Date.parse(a.date || "") || 0;
        const dateB = Date.parse(b.date || "") || 0;
        return dateB - dateA;
      }

      if (sortBy === "oldest") {
        const dateA = Date.parse(a.date || "") || 0;
        const dateB = Date.parse(b.date || "") || 0;
        return dateA - dateB;
      }

      return 0;
    });
  }, [
    allEmails,
    priorityFilter,
    categoryFilter,
    searchTerm,
    sortBy,
    unreadOnly,
  ]);

  return (
    <main className="min-h-screen bg-slate-100 text-slate-800">
      <header className="border-b border-slate-200 bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-blue-600">
              ezMail
            </h1>
            <p className="text-xs text-slate-500">
              Context-aware email prioritization
            </p>
          </div>
          {accessToken && (
            <button
              onClick={logout}
              className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700"
            >
              Logout
            </button>
          )}
        </div>
      </header>

      {!accessToken ? (
        <section className="mx-auto mt-20 max-w-md rounded-2xl bg-white p-8 text-center shadow-lg">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-100 text-2xl">
            ✉
          </div>
          <h2 className="text-xl font-semibold">Welcome to EzMailer</h2>
          <p className="mt-2 text-sm text-slate-500">
            Sign in with Google to fetch, classify, and prioritize your Gmail
            messages.
          </p>
          <button
            onClick={login}
            className="mt-6 rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700"
          >
            Sign in with Google
          </button>
        </section>
      ) : (
        <section className="mx-auto max-w-screen-2xl p-4 md:p-6">
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Loaded emails</p>
              <p className="mt-1 text-2xl font-bold">{allEmails.length}</p>
            </div>
            <div className="rounded-xl border border-red-100 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">High priority</p>
              <p className="mt-1 text-2xl font-bold text-red-600">
                {
                  allEmails.filter((email) => email.priorityLevel === "High")
                    .length
                }
              </p>
            </div>
            <div className="rounded-xl border border-amber-100 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Medium priority</p>
              <p className="mt-1 text-2xl font-bold text-amber-600">
                {
                  allEmails.filter((email) => email.priorityLevel === "Medium")
                    .length
                }
              </p>
            </div>
            <div className="rounded-xl border border-emerald-100 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">Categorized emails</p>
              <p className="mt-1 text-2xl font-bold text-emerald-600">
                {
                  allEmails.filter(
                    (email) =>
                      email.classification &&
                      email.classification !== "Unclassified",
                  ).length
                }
              </p>
            </div>
          </div>

          <div
            className="mb-4 flex flex-wrap gap-2"
            role="tablist"
            aria-label="EzMail views"
          >
            {[
              ["inbox", "Inbox"],
              ["threads", "Threads & summaries"],
              ["attention", `Needs attention (${attentionCounts.open})`],
              ["analytics", "Analytics"],
              ["security", `Security review (${securityFindings.length})`],
              ["evaluation", "Classification lab"],
              ["personalization", "Personalization"],
            ].map(([view, label]) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={activeView === view}
                onClick={() => setActiveView(view)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${
                  activeView === view
                    ? "bg-blue-600 text-white shadow-sm"
                    : "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {activeView === "inbox" && (
            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <button
                disabled={loading}
                onClick={fetchAllEmails}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Fetch 20 Emails
              </button>
              <button
                disabled={loading}
                onClick={fetchPriorities}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                Fetch Priorities
              </button>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium" htmlFor="fetch-date">
                  Date
                </label>
                <input
                  id="fetch-date"
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <button
                  disabled={loading}
                  onClick={fetchEmailsByDate}
                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  Fetch Date
                </button>
              </div>
              <div className="min-w-52 flex-1">
                <label
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                  htmlFor="search-emails"
                >
                  Search
                </label>
                <input
                  id="search-emails"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                  placeholder="Sender, subject, or email text..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                  htmlFor="priority-filter"
                >
                  Priority
                </label>
                <select
                  id="priority-filter"
                  value={priorityFilter}
                  onChange={(event) => setPriorityFilter(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="All">All priorities</option>
                  {PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {priority}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                  htmlFor="category-filter"
                >
                  Category
                </label>
                <select
                  id="category-filter"
                  value={categoryFilter}
                  onChange={(event) => setCategoryFilter(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="All">All categories</option>
                  {CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                  htmlFor="sort-emails"
                >
                  Sort by
                </label>
                <select
                  id="sort-emails"
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="priority">Priority (highest first)</option>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                </select>
              </div>

              <label className="flex items-center gap-2 pb-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={unreadOnly}
                  onChange={(event) => setUnreadOnly(event.target.checked)}
                  className="h-4 w-4 rounded"
                />
                Unread only
              </label>

              <button
                onClick={() => {
                  setSearchTerm("");
                  setPriorityFilter("All");
                  setCategoryFilter("All");
                  setSortBy("priority");
                  setUnreadOnly(false);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
              >
                Reset filters
              </button>

              <button
                onClick={() => {
                  const columns = [
                    "Sender",
                    "Sender Email",
                    "Subject",
                    "Snippet",
                    "Category",
                    "Priority",
                    "Priority Score",
                    "Date",
                    "Classification Status",
                  ];

                  const escapeCSV = (value) =>
                    `"${String(value ?? "").replace(/"/g, '""')}"`;

                  const rows = visibleEmails.map((email) => [
                    email.senderName,
                    email.senderMail,
                    email.subject,
                    email.snippet,
                    email.classification,
                    email.priorityLevel,
                    email.priorityScore,
                    email.date,
                    email.classificationStatus,
                  ]);

                  const csv = [columns, ...rows]
                    .map((row) => row.map(escapeCSV).join(","))
                    .join("\r\n");

                  const blob = new Blob(["\uFEFF" + csv], {
                    type: "text/csv;charset=utf-8;",
                  });

                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "ezmail-filtered-emails.csv";
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                  URL.revokeObjectURL(url);
                }}
                disabled={visibleEmails.length === 0}
                className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
              >
                Export CSV ({visibleEmails.length})
              </button>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            >
              {error}
            </div>
          )}
          {message && (
            <div
              role="status"
              className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800"
            >
              {message}
            </div>
          )}

          {activeView === "inbox" && (
            <>
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                {loading ? (
                  <div className="flex items-center justify-center gap-3 p-12 text-slate-600">
                    <span className="h-6 w-6 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
                    Fetching and processing emails…
                  </div>
                ) : visibleEmails.length === 0 ? (
                  <div className="p-12 text-center">
                    <p className="font-semibold text-slate-700">
                      No emails to display
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      Fetch emails or adjust the search and filters.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="email-table w-full min-w-[1150px] border-collapse text-left text-sm">
                      <colgroup>
                        <col className="col-sender" />
                        <col className="col-sender-email" />
                        <col className="col-subject" />
                        <col className="col-category" />
                        <col className="col-date" />
                        <col className="col-priority" />
                        <col className="col-actions" />
                      </colgroup>
                      <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                        <tr>
                          {[
                            "Sender",
                            "Sender email",
                            "Snippet / subject",
                            "Category",
                            "Date",
                            "Priority",
                            "Actions",
                          ].map((heading) => (
                            <th
                              key={heading}
                              className="border-b border-slate-200 px-3 py-3"
                            >
                              {heading}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleEmails.map((email) => (
                          <React.Fragment key={email.id}>
                            <tr
                              className="cursor-pointer border-b border-slate-100 hover:bg-blue-50/50"
                              onClick={() =>
                                setSelectedEmailId((current) =>
                                  current === email.id ? null : email.id,
                                )
                              }
                            >
                              <td className="sender-cell px-3 py-3 font-medium text-slate-800">
                                <div className="sender-info">
                                  <span>
                                    {email.senderName || "Unknown sender"}
                                  </span>

                                  {email.senderTrusted && (
                                    <span className="trusted-badge rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800">
                                      Trusted
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="sender-email-cell px-3 py-3 text-slate-600">
                                {email.senderMail || "—"}
                              </td>
                              <td className="max-w-md px-3 py-3">
                                <p className="line-clamp-2">
                                  {email.subject ? (
                                    <>
                                      <strong>{email.subject} — </strong>
                                    </>
                                  ) : null}
                                  {email.snippet || "No snippet"}
                                </p>
                              </td>
                              <td className="px-3 py-3">
                                <span className="inline-block rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                                  {email.classification || "Unclassified"}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-slate-600">
                                {email.date || "—"}
                              </td>
                              <td className="px-3 py-3">
                                <span
                                  title={(email.priorityReasons || []).join(
                                    "; ",
                                  )}
                                  className={`inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${priorityClasses[email.priorityLevel] || priorityClasses.Low}`}
                                >
                                  {email.priorityLevel || "Low"} ·{" "}
                                  {email.priorityScore ?? 0}
                                </span>
                                {email.priorityOverride && (
                                  <p className="mt-1 text-xs text-slate-500">
                                    Manual override
                                  </p>
                                )}
                              </td>
                              <td
                                className="min-w-56 px-3 py-3"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <select
                                    aria-label={`Priority for ${email.senderName || email.id}`}
                                    value={email.priorityLevel || "Low"}
                                    onChange={(event) =>
                                      changePriority(email, event.target.value)
                                    }
                                    className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs"
                                  >
                                    {PRIORITIES.map((priority) => (
                                      <option key={priority} value={priority}>
                                        {priority}
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    onClick={() => toggleTrustedSender(email)}
                                    className={`rounded-md px-2 py-1.5 text-xs font-semibold ${email.senderTrusted ? "bg-slate-200 text-slate-700 hover:bg-slate-300" : "bg-sky-600 text-white hover:bg-sky-700"}`}
                                  >
                                    {email.senderTrusted
                                      ? "Untrust"
                                      : "Trust sender"}
                                  </button>
                                  {![
                                    "classified",
                                    "personalized",
                                    "user-corrected",
                                    "restored-model",
                                  ].includes(
                                    String(
                                      email.classificationStatus || "",
                                    ).toLowerCase(),
                                  ) && (
                                    <button
                                      type="button"
                                      disabled={retryingId === email.id}
                                      onClick={() => retryClassification(email)}
                                      className="rounded-md bg-violet-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                                    >
                                      {retryingId === email.id
                                        ? "Retrying…"
                                        : "Retry AI"}
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {selectedEmailId === email.id && (
                              <tr className="bg-slate-50">
                                <td
                                  colSpan="7"
                                  className="border-b border-slate-200 px-5 py-4"
                                >
                                  <div className="grid gap-4 lg:grid-cols-2">
                                    <div>
                                      <h3 className="mb-2 font-semibold text-slate-800">
                                        Email details
                                      </h3>
                                      <p className="mb-1 text-sm">
                                        <strong>Subject:</strong>{" "}
                                        {email.subject || "(No subject)"}
                                      </p>
                                      <div
                                        className="mb-3 flex flex-wrap items-center gap-2"
                                        onClick={(event) =>
                                          event.stopPropagation()
                                        }
                                      >
                                        <label
                                          htmlFor={`category-correction-${email.id}`}
                                          className="text-sm font-semibold text-slate-700"
                                        >
                                          Correct category
                                        </label>
                                        <select
                                          id={`category-correction-${email.id}`}
                                          value={
                                            email.classification ||
                                            "Unclassified"
                                          }
                                          disabled={
                                            savingCategoryId === email.id
                                          }
                                          onChange={(event) =>
                                            changeClassification(
                                              email,
                                              event.target.value,
                                            )
                                          }
                                          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50"
                                        >
                                          <option value="Unclassified" disabled>
                                            Unclassified (choose a category)
                                          </option>
                                          {CATEGORIES.map((category) => (
                                            <option
                                              key={category}
                                              value={category}
                                            >
                                              {category}
                                            </option>
                                          ))}
                                        </select>
                                        {email.classificationSource ===
                                          "sender-feedback" && (
                                          <span className="text-xs text-violet-700">
                                            Personalized from sender feedback
                                          </span>
                                        )}
                                        {email.classificationSource ===
                                          "user-feedback" && (
                                          <span className="text-xs text-emerald-700">
                                            Your correction saved
                                          </span>
                                        )}
                                      </div>
                                      <p className="whitespace-pre-wrap break-words text-sm text-slate-700">
                                        {email.body ||
                                          email.snippet ||
                                          "No body content was available."}
                                      </p>
                                    </div>
                                    <div>
                                      <h3 className="mb-2 font-semibold text-slate-800">
                                        Why this priority?
                                      </h3>
                                      <p className="mb-2 text-sm text-slate-600">
                                        Score: {email.priorityScore ?? 0}/100
                                      </p>
                                      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                                        {(
                                          email.priorityReasons || [
                                            "No explanation available for this saved record.",
                                          ]
                                        ).map((reason, index) => (
                                          <li
                                            key={`${email.id}-reason-${index}`}
                                          >
                                            {reason}
                                          </li>
                                        ))}
                                      </ul>
                                      <p className="mt-3 text-xs text-slate-500">
                                        Classification status:{" "}
                                        {email.classificationStatus ||
                                          (email.classification ===
                                          "Unclassified"
                                            ? "Not classified"
                                            : "Classified")}
                                      </p>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <p className="mt-3 text-right text-xs text-slate-500">
                Showing {visibleEmails.length} matching email(s) out of{" "}
                {allEmails.length} loaded · Sorted by{" "}
                {sortBy === "priority"
                  ? "priority"
                  : sortBy === "newest"
                    ? "newest first"
                    : "oldest first"}
                {unreadOnly ? " · Unread only" : ""} · Click a row to view
                details.
              </p>
            </>
          )}

          {activeView === "threads" && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-lg font-bold text-slate-800">
                    Threads, summaries & reply assistant
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm text-slate-600">
                    Open a conversation to summarize key points, decisions and
                    action items, review possible deadline changes, or draft a
                    reply. Drafts are never sent automatically.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadThreads}
                  disabled={threadsLoading}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
                >
                  {threadsLoading ? "Refreshing…" : "Refresh conversations"}
                </button>
              </div>

              {threadsError && (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
                >
                  {threadsError}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                <div className="space-y-3 xl:col-span-1">
                  <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                    <label
                      htmlFor="thread-search"
                      className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Search conversations
                    </label>
                    <input
                      id="thread-search"
                      value={threadSearch}
                      onChange={(event) => setThreadSearch(event.target.value)}
                      placeholder="Subject, sender, date…"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <p className="mt-2 text-xs text-slate-500">
                      {filteredThreadGroups.length} conversation group(s) from
                      saved emails. Open a group to load the full Gmail thread
                      when available.
                    </p>
                  </div>
                  {threadsLoading && !threadGroups.length ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                      Loading conversations…
                    </div>
                  ) : filteredThreadGroups.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
                      No saved conversations found. Fetch emails in Inbox first.
                    </div>
                  ) : (
                    filteredThreadGroups.map((group) => (
                      <article
                        key={group.key}
                        className={`rounded-xl border bg-white p-3 shadow-sm ${selectedThreadGroup?.key === group.key ? "border-blue-400 ring-1 ring-blue-200" : "border-slate-200"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <h3 className="break-words text-sm font-semibold text-slate-800">
                              {group.subject || "(No subject)"}
                            </h3>
                            <p className="mt-1 break-words text-xs text-slate-500">
                              {(group.senders || []).join(", ") ||
                                "Unknown sender"}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {group.count} saved message(s) ·{" "}
                              {group.latestDate}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-1">
                            {group.hasDeadlineChanges && (
                              <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                                Deadline changed?
                              </span>
                            )}
                            {group.hasPlanChanges && (
                              <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-800">
                                Plan update?
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => openThread(group)}
                          disabled={threadsLoading}
                          className="mt-3 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {selectedThreadGroup?.key === group.key &&
                          threadsLoading
                            ? "Opening…"
                            : "Open conversation"}
                        </button>
                      </article>
                    ))
                  )}
                </div>

                <div className="space-y-4 xl:col-span-2">
                  {!selectedThread ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
                      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
                        <span className="text-xl">✉</span>
                      </div>
                      <h3 className="font-semibold text-slate-800">
                        Choose a conversation
                      </h3>
                      <p className="mt-1 text-sm text-slate-500">
                        The thread timeline, deadline-change hints, summary and
                        reply tools will appear here.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <h3 className="break-words text-lg font-bold text-slate-800">
                              {selectedThread.messages?.[
                                selectedThread.messages.length - 1
                              ]?.subject ||
                                selectedThreadGroup?.subject ||
                                "Conversation"}
                            </h3>
                            <p className="mt-1 text-sm text-slate-500">
                              {selectedThread.messageCount ||
                                selectedThread.messages?.length ||
                                0}{" "}
                              message(s) · Loaded from{" "}
                              {selectedThread.source === "gmail"
                                ? "Gmail thread"
                                : "saved messages"}
                            </p>
                          </div>
                          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                            Summary & draft only
                          </span>
                        </div>

                        {selectedThread.deadlineChanges?.length > 0 && (
                          <div className="mt-4 space-y-2">
                            <h4 className="font-semibold text-amber-800">
                              Possible deadline changes — verify the original
                              email
                            </h4>
                            {selectedThread.deadlineChanges.map(
                              (change, index) => (
                                <div
                                  key={`${change.emailId}-${change.updatedDeadline}-${index}`}
                                  className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm"
                                >
                                  <p className="font-semibold text-amber-900">
                                    {change.previousDeadline} →{" "}
                                    {change.updatedDeadline}
                                  </p>
                                  <p className="mt-1 text-amber-900">
                                    {change.explanation}
                                  </p>
                                  <p className="mt-1 text-xs text-amber-800">
                                    Message: {change.subject} · This is a
                                    heuristic suggestion, not a confirmed
                                    change.
                                  </p>
                                </div>
                              ),
                            )}
                          </div>
                        )}

                        {selectedThread.planChanges?.length > 0 && (
                          <div className="mt-4 space-y-2">
                            <h4 className="font-semibold text-violet-800">
                              Possible plan changes — compare the timeline
                            </h4>
                            {selectedThread.planChanges.map((change, index) => (
                              <div
                                key={`${change.emailId}-${index}`}
                                className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm"
                              >
                                <p className="font-semibold text-violet-900">
                                  {change.signal}
                                </p>
                                <p className="mt-1 text-violet-900">
                                  {change.explanation}
                                </p>
                                <p className="mt-1 text-xs text-violet-800">
                                  Latest message: {change.subject} · Previous
                                  available message:{" "}
                                  {change.previousMessageSubject}. Confirm the
                                  actual change in the original thread.
                                </p>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => runThreadAssistant("summarize")}
                            disabled={Boolean(threadAssistantBusy)}
                            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                          >
                            {threadAssistantBusy === "summarize"
                              ? "Summarizing…"
                              : "Summarize thread"}
                          </button>
                          <button
                            type="button"
                            onClick={() => runThreadAssistant("reply")}
                            disabled={Boolean(threadAssistantBusy)}
                            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {threadAssistantBusy === "reply"
                              ? "Drafting…"
                              : "Draft reply"}
                          </button>
                        </div>
                        {threadAssistantError && (
                          <div
                            role="alert"
                            className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
                          >
                            {threadAssistantError}
                          </div>
                        )}
                        {threadAssistantMessage && (
                          <div
                            role="status"
                            className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
                          >
                            {threadAssistantMessage}
                          </div>
                        )}
                      </div>

                      {threadSummary && (
                        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                          <h3 className="text-base font-bold text-slate-800">
                            Conversation summary
                          </h3>
                          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                            {threadSummary.summary ||
                              "No summary was returned."}
                          </p>
                          {[
                            ["Decisions", threadSummary.decisions],
                            ["Action items", threadSummary.actionItems],
                            ["Deadlines", threadSummary.deadlines],
                            ["Open questions", threadSummary.openQuestions],
                            ["Things to verify", threadSummary.caveats],
                          ]
                            .filter(
                              ([, items]) =>
                                Array.isArray(items) && items.length > 0,
                            )
                            .map(([heading, items]) => (
                              <div key={heading}>
                                <h4 className="mb-1 text-sm font-semibold text-slate-800">
                                  {heading}
                                </h4>
                                {heading === "Action items" ? (
                                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                                    {items.map((item, index) => (
                                      <li key={`${heading}-${index}`}>
                                        {item.action}
                                        {item.owner ? ` — ${item.owner}` : ""}
                                        {item.deadline
                                          ? ` · ${item.deadline}`
                                          : ""}
                                      </li>
                                    ))}
                                  </ul>
                                ) : heading === "Deadlines" ? (
                                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                                    {items.map((item, index) => (
                                      <li key={`${heading}-${index}`}>
                                        {item.date ? `${item.date}: ` : ""}
                                        {item.context || "Deadline mentioned"}
                                        {item.status &&
                                        item.status !== "current"
                                          ? ` (${item.status.replace("_", " ")})`
                                          : ""}
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
                                    {items.map((item, index) => (
                                      <li key={`${heading}-${index}`}>
                                        {typeof item === "string"
                                          ? item
                                          : JSON.stringify(item)}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            ))}
                        </div>
                      )}

                      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <h3 className="font-bold text-slate-800">
                          Reply assistance
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                          Generate a draft, edit it here, and copy it into Gmail
                          when you're ready. EzMailer never sends it.
                        </p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div>
                            <label
                              htmlFor="reply-tone"
                              className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                            >
                              Tone
                            </label>
                            <select
                              id="reply-tone"
                              value={replyTone}
                              onChange={(event) =>
                                setReplyTone(event.target.value)
                              }
                              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                            >
                              <option>Professional</option>
                              <option>Friendly</option>
                              <option>Concise</option>
                              <option>Formal</option>
                              <option>Apologetic</option>
                            </select>
                          </div>
                          <div>
                            <label
                              htmlFor="reply-instructions"
                              className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                            >
                              What should the reply achieve?
                            </label>
                            <input
                              id="reply-instructions"
                              value={replyInstructions}
                              onChange={(event) =>
                                setReplyInstructions(event.target.value)
                              }
                              maxLength={800}
                              placeholder="e.g. Confirm I can attend on Friday"
                              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                            />
                          </div>
                        </div>
                        {replyDraft && (
                          <div className="mt-4 space-y-2">
                            <label
                              htmlFor="reply-draft"
                              className="block text-sm font-semibold text-slate-800"
                            >
                              Editable reply draft
                            </label>
                            <textarea
                              id="reply-draft"
                              value={replyDraft}
                              onChange={(event) =>
                                setReplyDraft(event.target.value)
                              }
                              rows={8}
                              className="w-full rounded-lg border border-slate-300 px-3 py-3 text-sm leading-6"
                            />
                            <button
                              type="button"
                              onClick={copyReplyDraft}
                              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
                            >
                              Copy draft
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        <h3 className="font-bold text-slate-800">
                          Conversation timeline
                        </h3>
                        {(selectedThread.messages || []).map((email, index) => (
                          <article
                            key={email.id || `${email.subject}-${index}`}
                            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <h4 className="break-words font-semibold text-slate-800">
                                  {email.subject || "(No subject)"}
                                </h4>
                                <p className="mt-1 break-words text-xs text-slate-500">
                                  {email.senderName || "Unknown sender"}
                                  {email.senderMail
                                    ? ` · ${email.senderMail}`
                                    : ""}
                                </p>
                              </div>
                              <span className="text-xs text-slate-500">
                                {email.date || "Unknown date"}
                              </span>
                            </div>
                            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
                              {email.body ||
                                email.snippet ||
                                "No readable body available."}
                            </p>
                          </article>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500">
                Summaries and deadline-change hints are AI/heuristic assistance,
                not authoritative records. Verify dates, commitments,
                recipients, and amounts against the original messages before
                acting or sending a reply.
              </p>
            </section>
          )}

          {activeView === "attention" && (
            <section className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">
                      Needs attention
                    </h2>
                    <p className="mt-1 max-w-3xl text-sm text-slate-500">
                      Grouped by email so repeated action sentences do not
                      overwhelm the view. Start with Focus, then review the
                      remaining open items when you have time.
                    </p>
                  </div>
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
                    {attentionCounts.open} open action(s) across{" "}
                    {
                      new Set(
                        attentionRows
                          .filter((item) => !item.done)
                          .map((item) => item.email.id),
                      ).size
                    }{" "}
                    email(s)
                  </div>
                </div>

                <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <button
                    type="button"
                    onClick={() => setAttentionFilter("overdue")}
                    className={`rounded-lg border p-3 text-left ${attentionFilter === "overdue" ? "border-rose-300 bg-rose-50 ring-1 ring-rose-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">
                      Overdue
                    </p>
                    <p className="mt-1 text-2xl font-bold text-rose-700">
                      {attentionCounts.overdue}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAttentionFilter("soon")}
                    className={`rounded-lg border p-3 text-left ${attentionFilter === "soon" ? "border-amber-300 bg-amber-50 ring-1 ring-amber-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                      Due in 3 days
                    </p>
                    <p className="mt-1 text-2xl font-bold text-amber-700">
                      {attentionCounts.soon}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAttentionFilter("undated")}
                    className={`rounded-lg border p-3 text-left ${attentionFilter === "undated" ? "border-sky-300 bg-sky-50 ring-1 ring-sky-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
                      No date detected
                    </p>
                    <p className="mt-1 text-2xl font-bold text-sky-700">
                      {attentionCounts.undated}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAttentionFilter("completed")}
                    className={`rounded-lg border p-3 text-left ${attentionFilter === "completed" ? "border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                      Completed
                    </p>
                    <p className="mt-1 text-2xl font-bold text-emerald-700">
                      {attentionCounts.completed}
                    </p>
                  </button>
                </div>

                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-56 flex-1">
                    <label
                      htmlFor="attention-search"
                      className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Search tasks
                    </label>
                    <input
                      id="attention-search"
                      value={attentionSearch}
                      onChange={(event) =>
                        setAttentionSearch(event.target.value)
                      }
                      placeholder="Company, sender, deadline, action..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="attention-kind"
                      className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Type
                    </label>
                    <select
                      id="attention-kind"
                      value={attentionKind}
                      onChange={(event) => setAttentionKind(event.target.value)}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      {[
                        "All",
                        "Career",
                        "Payment",
                        "Security",
                        "Deadline / action",
                        "Action",
                      ].map((kind) => (
                        <option key={kind} value={kind}>
                          {kind === "All" ? "All types" : kind}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label
                      htmlFor="attention-view-filter"
                      className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Show
                    </label>
                    <select
                      id="attention-view-filter"
                      value={attentionFilter}
                      onChange={(event) =>
                        setAttentionFilter(event.target.value)
                      }
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="focus">Focus first</option>
                      <option value="open">All open actions</option>
                      <option value="overdue">Overdue</option>
                      <option value="soon">Due within 3 days</option>
                      <option value="undated">No date detected</option>
                      <option value="completed">Completed</option>
                      <option value="all">Everything</option>
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAttentionSearch("");
                      setAttentionKind("All");
                      setAttentionFilter("focus");
                      setExpandedAttentionEmails({});
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                  >
                    Reset
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-slate-600">
                <span>
                  Showing {filteredAttentionItems.length} action(s) across{" "}
                  {attentionGroups.length} email(s).
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedAttentionEmails(
                        Object.fromEntries(
                          attentionGroups.map((group) => [group.key, true]),
                        ),
                      )
                    }
                    className="font-semibold text-blue-700 hover:underline"
                  >
                    Expand all
                  </button>
                  <span aria-hidden="true">·</span>
                  <button
                    type="button"
                    onClick={() => setExpandedAttentionEmails({})}
                    className="font-semibold text-blue-700 hover:underline"
                  >
                    Collapse all
                  </button>
                </div>
              </div>

              {filteredAttentionItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
                  <p className="font-semibold text-slate-700">
                    Nothing matches this view
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    Try “All open actions” to review tasks outside the focus
                    list.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setAttentionFilter("open");
                      setAttentionKind("All");
                      setAttentionSearch("");
                    }}
                    className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    Show all open actions
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {attentionGroups.map((group) => {
                    const expanded = Boolean(
                      expandedAttentionEmails[group.key],
                    );
                    const visibleGroupItems = expanded
                      ? group.items
                      : group.items.slice(0, 2);
                    const hiddenCount =
                      group.items.length - visibleGroupItems.length;
                    const sourceEmail = group.email;
                    const groupHasOverdue = group.items.some(
                      (item) =>
                        !item.done &&
                        item.daysLeft !== null &&
                        item.daysLeft < 0,
                    );
                    const groupDueSoon = group.items.some(
                      (item) =>
                        !item.done &&
                        item.daysLeft !== null &&
                        item.daysLeft >= 0 &&
                        item.daysLeft <= 3,
                    );
                    return (
                      <article
                        key={group.key}
                        className={`overflow-hidden rounded-xl border bg-white shadow-sm ${groupHasOverdue ? "border-rose-200" : groupDueSoon ? "border-amber-200" : "border-slate-200"}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="mb-1 flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-700">
                                {group.items.length} action
                                {group.items.length === 1 ? "" : "s"}
                              </span>
                              {sourceEmail.priorityLevel === "High" && (
                                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                                  High priority email
                                </span>
                              )}
                              {groupHasOverdue && (
                                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800">
                                  Overdue action
                                </span>
                              )}
                              {!groupHasOverdue && groupDueSoon && (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                                  Due soon
                                </span>
                              )}
                            </div>
                            <h3 className="break-words font-semibold text-slate-800">
                              {sourceEmail.subject || "(No subject)"}
                            </h3>
                            <p className="mt-1 text-sm text-slate-600">
                              {sourceEmail.senderName ||
                                sourceEmail.senderMail ||
                                "Unknown sender"}
                              {sourceEmail.senderMail && sourceEmail.senderName
                                ? ` · ${sourceEmail.senderMail}`
                                : ""}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                            <button
                              type="button"
                              onClick={() => {
                                setActiveView("inbox");
                                setSearchTerm(
                                  sourceEmail.subject ||
                                    sourceEmail.senderMail ||
                                    "",
                                );
                                setSelectedEmailId(sourceEmail.id);
                              }}
                              className="text-sm font-semibold text-blue-700 hover:underline"
                            >
                              Open email
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedAttentionEmails((current) => ({
                                  ...current,
                                  [group.key]: !current[group.key],
                                }))
                              }
                              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              {expanded
                                ? "Show less"
                                : hiddenCount > 0
                                  ? `Show ${hiddenCount} more`
                                  : "Expand actions"}
                            </button>
                          </div>
                        </div>
                        <div className="divide-y divide-slate-100 px-4">
                          {visibleGroupItems.map((item) => (
                            <div
                              key={item.key}
                              className={`flex items-start gap-3 py-3 ${item.done ? "opacity-60" : ""}`}
                            >
                              <input
                                aria-label="Mark action item complete"
                                type="checkbox"
                                checked={item.done}
                                onChange={(event) =>
                                  updateAttentionDone(
                                    item,
                                    event.target.checked,
                                  )
                                }
                                className="mt-1 h-4 w-4 rounded"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-center gap-2">
                                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
                                    {item.kind}
                                  </span>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${item.done ? "bg-slate-200 text-slate-700" : item.daysLeft !== null && item.daysLeft < 0 ? "bg-rose-100 text-rose-800" : item.daysLeft !== null && item.daysLeft <= 3 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}
                                  >
                                    {item.done ? "Completed" : item.dueLabel}
                                  </span>
                                </div>
                                <p
                                  className={`text-sm font-medium text-slate-800 ${item.done ? "line-through" : ""}`}
                                >
                                  {item.summary}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-slate-500">
                Action completion is synced to MongoDB and cached in this
                browser. Detection is rule-based, so verify dates against the
                original message. Focus first includes overdue/upcoming dated
                items and actions from high-priority emails; all open actions
                remain available using the filter above.
              </p>
            </section>
          )}

          {activeView === "security" && (
            <section className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">
                      Security review
                    </h2>
                    <p className="mt-1 max-w-3xl text-sm text-slate-500">
                      Review messages with suspicious links, urgent pressure,
                      sensitive-information requests, or possible sender
                      impersonation. These are heuristic warnings, not
                      definitive phishing verdicts.
                    </p>
                  </div>
                  <span className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                    Scanned {securityCounts.scanned} loaded email(s)
                  </span>
                </div>
                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => setSecurityFilter("High")}
                    className={`rounded-lg border p-3 text-left ${securityFilter === "High" ? "border-rose-300 bg-rose-50 ring-1 ring-rose-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">
                      High concern
                    </p>
                    <p className="mt-1 text-2xl font-bold text-rose-700">
                      {securityCounts.high}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSecurityFilter("Review")}
                    className={`rounded-lg border p-3 text-left ${securityFilter === "Review" ? "border-amber-300 bg-amber-50 ring-1 ring-amber-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                      Needs review
                    </p>
                    <p className="mt-1 text-2xl font-bold text-amber-700">
                      {securityCounts.review}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSecurityFilter("All")}
                    className={`rounded-lg border p-3 text-left ${securityFilter === "All" ? "border-blue-300 bg-blue-50 ring-1 ring-blue-200" : "border-slate-200 hover:bg-slate-50"}`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                      All flagged
                    </p>
                    <p className="mt-1 text-2xl font-bold text-blue-700">
                      {securityCounts.high + securityCounts.review}
                    </p>
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
                  <div>
                    <label
                      htmlFor="security-search"
                      className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Search security findings
                    </label>
                    <input
                      id="security-search"
                      value={securitySearch}
                      onChange={(event) =>
                        setSecuritySearch(event.target.value)
                      }
                      placeholder="Sender, subject, signal..."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSecuritySearch("");
                        setSecurityFilter("All");
                      }}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>

              {securityFindings.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
                  <p className="font-semibold text-slate-700">
                    No matching security warnings
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    This only means the loaded email text did not trigger the
                    current rules. It does not guarantee that an email is safe.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {securityFindings.map((finding) => (
                    <article
                      key={finding.email.id}
                      className={`rounded-xl border bg-white p-4 shadow-sm ${finding.risk === "High" ? "border-rose-200" : "border-amber-200"}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-full px-2.5 py-1 text-xs font-bold ${finding.risk === "High" ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"}`}
                            >
                              {finding.risk === "High"
                                ? "High concern"
                                : "Needs review"}
                            </span>
                            <span className="text-xs text-slate-500">
                              {finding.score} signal points
                            </span>
                          </div>
                          <h3 className="break-words font-semibold text-slate-800">
                            {finding.email.subject || "(No subject)"}
                          </h3>
                          <p className="mt-1 text-sm text-slate-600">
                            {finding.email.senderName || "Unknown sender"}
                            {finding.email.senderMail
                              ? ` · ${finding.email.senderMail}`
                              : ""}
                          </p>
                          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
                            {finding.reasons.map((reason, index) => (
                              <li key={`${finding.email.id}-security-${index}`}>
                                {reason}
                              </li>
                            ))}
                          </ul>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveView("inbox");
                            setSearchTerm(
                              finding.email.subject ||
                                finding.email.senderMail ||
                                "",
                            );
                            setPriorityFilter("All");
                            setCategoryFilter("All");
                            setUnreadOnly(false);
                            setSelectedEmailId(finding.email.id);
                          }}
                          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                        >
                          Open email
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <p className="text-xs text-slate-500">
                Security checks run locally on the loaded subject, snippet, body
                text, sender, and URLs visible in the text. Link targets hidden
                behind anchor text may not be available from older stored email
                bodies. When uncertain, open Gmail directly and verify the
                sender through a known official channel.
              </p>
            </section>
          )}

          {activeView === "analytics" && (
            <section className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm text-slate-500">
                    AI classification success
                  </p>
                  <p className="mt-1 text-2xl font-bold text-emerald-600">
                    {analytics.aiSuccessRate}%
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {analytics.successfulAI} of {allEmails.length} loaded emails
                    have status "classified".
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm text-slate-500">High priority</p>
                  <p className="mt-1 text-2xl font-bold text-rose-600">
                    {
                      allEmails.filter(
                        (email) => email.priorityLevel === "High",
                      ).length
                    }
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Among currently loaded emails.
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm text-slate-500">Open action items</p>
                  <p className="mt-1 text-2xl font-bold text-amber-600">
                    {
                      attentionItems.filter((item) => !attentionDone[item.key])
                        .length
                    }
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Rule-detected tasks and deadlines.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h2 className="font-bold text-slate-800">
                    Category distribution
                  </h2>
                  <p className="mb-4 mt-1 text-xs text-slate-500">
                    Counts from the current loaded dataset.
                  </p>
                  <div className="space-y-3">
                    {analytics.categoryCounts.map((item) => {
                      const pct = allEmails.length
                        ? (item.count / allEmails.length) * 100
                        : 0;
                      return (
                        <div key={item.category}>
                          <div className="mb-1 flex justify-between gap-3 text-sm">
                            <span>{item.category}</span>
                            <span className="font-semibold tabular-nums">
                              {item.count}
                            </span>
                          </div>
                          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-blue-600"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <h2 className="font-bold text-slate-800">
                    High-priority trend
                  </h2>
                  <p className="mb-4 mt-1 text-xs text-slate-500">
                    High-priority message count by received date, limited to
                    loaded emails.
                  </p>
                  {analytics.highPriorityTrend.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No usable dates found.
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {analytics.highPriorityTrend.map((item) => {
                        const max = Math.max(
                          1,
                          ...analytics.highPriorityTrend.map(
                            (entry) => entry.count,
                          ),
                        );
                        const pct = (item.count / max) * 100;
                        const displayDate =
                          item.date.slice(5) + "-" + item.date.slice(0, 4);
                        return (
                          <div key={item.date}>
                            <div className="mb-1 flex justify-between gap-3 text-sm">
                              <span>{displayDate}</span>
                              <span className="font-semibold tabular-nums">
                                {item.count}
                              </span>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                              <div
                                className="h-full rounded-full bg-rose-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-2">
                  <h2 className="font-bold text-slate-800">
                    What is driving priority?
                  </h2>
                  <p className="mb-4 mt-1 text-xs text-slate-500">
                    Most frequent reasons stored by the priority engine. Open
                    any email in Inbox for its individual reasons.
                  </p>
                  {analytics.reasonCounts.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No priority reasons are available yet.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                      {analytics.reasonCounts.map((item) => (
                        <div
                          key={item.reason}
                          className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3 text-sm"
                        >
                          <span>{item.reason}</span>
                          <span className="shrink-0 rounded-full bg-white px-2 py-0.5 font-semibold">
                            {item.count}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-500">
                These metrics describe the emails currently loaded in the
                dashboard, not your full historical Gmail inbox.
              </p>
            </section>
          )}

          {activeView === "personalization" && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div>
                  <h2 className="text-lg font-bold text-slate-800">
                    Personalization & feedback center
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm text-slate-600">
                    Review what EzMailer has learned from your priority choices,
                    sender trust settings, and category corrections. You stay in
                    control of every learned preference.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={loadPersonalization}
                  disabled={
                    personalizationLoading || Boolean(personalizationBusy)
                  }
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
                >
                  {personalizationLoading ? "Refreshing…" : "Refresh insights"}
                </button>
              </div>

              {personalizationError && (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
                >
                  {personalizationError}
                </div>
              )}

              {personalizationLoading && !personalizationData ? (
                <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
                  Loading personalization insights…
                </div>
              ) : personalizationData ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    {[
                      {
                        label: "Saved emails",
                        value: personalizationData.stats.totalEmails,
                        color: "text-slate-800",
                      },
                      {
                        label: "Manual priority overrides",
                        value:
                          personalizationData.stats.manualPriorityOverrides,
                        color: "text-rose-700",
                      },
                      {
                        label: "Category corrections",
                        value:
                          personalizationData.stats.categoryCorrectionCount,
                        color: "text-violet-700",
                      },
                      {
                        label: "Learned sender rules",
                        value: personalizationData.stats.learnedSenderRules,
                        color: "text-blue-700",
                      },
                      {
                        label: "Trusted senders",
                        value: personalizationData.stats.trustedSenderCount,
                        color: "text-sky-700",
                      },
                    ].map((item) => (
                      <div
                        key={item.label}
                        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                      >
                        <p className="text-sm text-slate-500">{item.label}</p>
                        <p className={`mt-1 text-2xl font-bold ${item.color}`}>
                          {item.value}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-slate-800">
                            Sender patterns & reputation
                          </h3>
                          <p className="mt-1 text-sm text-slate-500">
                            Trust and priority feedback are separate signals.
                            High-priority counts describe saved messages, not a
                            guarantee that a sender is safe.
                          </p>
                        </div>
                        <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
                          {personalizationData.senders.length} sender(s)
                        </span>
                      </div>
                      <div className="mt-3">
                        <label
                          htmlFor="personalization-search"
                          className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500"
                        >
                          Find sender
                        </label>
                        <input
                          id="personalization-search"
                          value={personalizationSearch}
                          onChange={(event) =>
                            setPersonalizationSearch(event.target.value)
                          }
                          placeholder="Search sender name or email…"
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                        />
                      </div>
                      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full min-w-[930px] text-left text-sm">
                          <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                            <tr>
                              <th className="p-3">Sender</th>
                              <th className="p-3">Emails</th>
                              <th className="p-3">High</th>
                              <th className="p-3">Priority feedback</th>
                              <th className="p-3">Category learning</th>
                              <th className="p-3">Trust</th>
                              <th className="p-3">Control</th>
                            </tr>
                          </thead>
                          <tbody>
                            {personalizationData.senders
                              .filter((sender) =>
                                `${sender.senderName} ${sender.senderMail}`
                                  .toLowerCase()
                                  .includes(
                                    personalizationSearch.trim().toLowerCase(),
                                  ),
                              )
                              .slice(0, 100)
                              .map((sender) => (
                                <tr
                                  key={sender.senderMail}
                                  className="border-t border-slate-100 align-top"
                                >
                                  <td className="max-w-[260px] p-3">
                                    <p className="font-semibold text-slate-800">
                                      {sender.senderName || sender.senderMail}
                                    </p>
                                    <p className="mt-0.5 break-all text-xs text-slate-500">
                                      {sender.senderMail}
                                    </p>
                                    {sender.manualOverrides > 0 && (
                                      <p className="mt-1 text-xs text-violet-700">
                                        {sender.manualOverrides} manual
                                        override(s)
                                      </p>
                                    )}
                                  </td>
                                  <td className="p-3 tabular-nums">
                                    {sender.totalEmails}
                                  </td>
                                  <td className="p-3 tabular-nums">
                                    {sender.highPriorityEmails}
                                  </td>
                                  <td className="p-3">
                                    <p className="font-semibold tabular-nums">
                                      {sender.priorityFeedbackCount}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                      H {sender.highCount} · M{" "}
                                      {sender.mediumCount} · L {sender.lowCount}
                                    </p>
                                  </td>
                                  <td className="p-3">
                                    {sender.learnedCategory ? (
                                      <>
                                        <span className="inline-flex rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-800">
                                          {sender.learnedCategory}
                                        </span>
                                        <p className="mt-1 text-xs text-slate-500">
                                          {sender.categoryCorrectionCount}{" "}
                                          corrections · {sender.agreementPct}%
                                          agreement
                                        </p>
                                      </>
                                    ) : sender.categoryCorrectionCount > 0 ? (
                                      <p className="text-xs text-slate-600">
                                        {sender.categoryCorrectionCount}{" "}
                                        correction(s) · needs at least 3
                                        consistent corrections
                                      </p>
                                    ) : (
                                      <span className="text-xs text-slate-400">
                                        No corrections yet
                                      </span>
                                    )}
                                  </td>
                                  <td className="p-3">
                                    <span
                                      className={`rounded-full px-2 py-1 text-xs font-semibold ${sender.trusted ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-600"}`}
                                    >
                                      {sender.trusted
                                        ? "Trusted"
                                        : "Not trusted"}
                                    </span>
                                  </td>
                                  <td className="p-3">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        toggleTrustedFromCenter(
                                          sender.senderMail,
                                        )
                                      }
                                      disabled={
                                        !sender.senderMail ||
                                        Boolean(personalizationBusy)
                                      }
                                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${sender.trusted ? "border border-slate-300 text-slate-700 hover:bg-slate-50" : "bg-sky-600 text-white hover:bg-sky-700"}`}
                                    >
                                      {personalizationBusy ===
                                      `trust:${sender.senderMail}`
                                        ? "Saving…"
                                        : sender.trusted
                                          ? "Remove trust"
                                          : "Trust sender"}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            {personalizationData.senders.filter((sender) =>
                              `${sender.senderName} ${sender.senderMail}`
                                .toLowerCase()
                                .includes(
                                  personalizationSearch.trim().toLowerCase(),
                                ),
                            ).length === 0 && (
                              <tr>
                                <td
                                  colSpan="7"
                                  className="p-6 text-center text-sm text-slate-500"
                                >
                                  No sender matched your search.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        Showing up to 100 matching senders. Category preferences
                        are learned only after at least{" "}
                        {personalizationData.learningPolicy.minimumCorrections}{" "}
                        corrections with{" "}
                        {personalizationData.learningPolicy.minimumAgreementPct}
                        % agreement.
                      </p>
                    </div>

                    <div className="space-y-4">
                      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                        <h3 className="font-bold text-slate-800">
                          How EzMailer learns
                        </h3>
                        <div className="mt-3 space-y-3 text-sm">
                          <div className="rounded-lg bg-slate-50 p-3">
                            <p className="font-semibold">Priority feedback</p>
                            <p className="mt-1 text-slate-600">
                              {personalizationData.stats.priorityFeedbackCount}{" "}
                              sender-level feedback signal(s) recorded from
                              manual priority decisions.
                            </p>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <p className="font-semibold">
                              Category corrections
                            </p>
                            <p className="mt-1 text-slate-600">
                              Your corrections are stored once per email.
                              Consistent sender patterns may guide future new or
                              unclassified messages.
                            </p>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <p className="font-semibold">
                              AI classification performance
                            </p>
                            <p className="mt-1 text-slate-600">
                              {personalizationData.stats.aiClassifiedCount} of{" "}
                              {personalizationData.stats.totalEmails} saved
                              emails have an explicit AI-classified status (
                              {personalizationData.stats.aiSuccessRate}%).
                            </p>
                          </div>
                        </div>
                        <p className="mt-3 text-xs text-slate-500">
                          EzMailer does not learn from email-body text by itself
                          in this view. This page summarizes stored feedback and
                          sender preferences.
                        </p>
                      </div>

                      <div className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
                        <h3 className="font-bold text-slate-800">
                          Reset learned preferences
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">
                          These actions are separate so you can reset category
                          corrections without removing trust choices or manually
                          chosen email priorities.
                        </p>
                        <button
                          type="button"
                          onClick={resetCategoryLearning}
                          disabled={
                            Boolean(personalizationBusy) ||
                            personalizationLoading
                          }
                          className="mt-3 w-full rounded-lg border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-50 disabled:opacity-50"
                        >
                          {personalizationBusy === "reset-category"
                            ? "Resetting category learning…"
                            : "Reset category learning"}
                        </button>
                        <button
                          type="button"
                          onClick={resetPriorityLearning}
                          disabled={
                            Boolean(personalizationBusy) ||
                            personalizationLoading
                          }
                          className="mt-2 w-full rounded-lg border border-rose-300 px-3 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50 disabled:opacity-50"
                        >
                          {personalizationBusy === "reset-priority"
                            ? "Resetting priority feedback…"
                            : "Reset priority feedback counts"}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="font-bold text-slate-800">
                          Recent category corrections
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                          Review the latest corrections that may contribute to
                          future sender-level category preferences.
                        </p>
                      </div>
                      <span className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600">
                        {personalizationData.recentCorrections.length} recent
                      </span>
                    </div>
                    {personalizationData.recentCorrections.length === 0 ? (
                      <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-slate-600">
                        No category corrections yet. To add one, open an email
                        in Inbox and use the category correction control in its
                        details.
                      </p>
                    ) : (
                      <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
                        <table className="w-full min-w-[800px] text-left text-sm">
                          <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
                            <tr>
                              <th className="p-3">Email</th>
                              <th className="p-3">Original category</th>
                              <th className="p-3">Corrected category</th>
                              <th className="p-3">Updated</th>
                            </tr>
                          </thead>
                          <tbody>
                            {personalizationData.recentCorrections.map(
                              (item) => (
                                <tr
                                  key={`${item.emailId}-${item.updatedAt || "correction"}`}
                                  className="border-t border-slate-100"
                                >
                                  <td className="p-3">
                                    <p className="font-semibold text-slate-800">
                                      {item.subject}
                                    </p>
                                    <p className="mt-0.5 text-xs text-slate-500">
                                      {item.senderName} · {item.senderMail}
                                    </p>
                                  </td>
                                  <td className="p-3">
                                    <span className="rounded-full bg-slate-100 px-2 py-1 text-xs">
                                      {item.predictedCategory}
                                    </span>
                                  </td>
                                  <td className="p-3">
                                    <span className="rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-800">
                                      {item.correctedCategory}
                                    </span>
                                  </td>
                                  <td className="p-3 text-xs text-slate-500">
                                    {item.updatedAt
                                      ? new Date(
                                          item.updatedAt,
                                        ).toLocaleString()
                                      : "—"}
                                  </td>
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
                  Open Personalization to load your feedback insights.
                </div>
              )}
            </section>
          )}

          {activeView === "evaluation" && (
            <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-slate-800">
                    Classification evaluation lab
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm text-slate-500">
                    Runs a small labelled benchmark of 11 representative
                    scenarios (security alerts, OTPs, placements, financial
                    messages, shopping, travel, promotions, newsletters,
                    personal email, and spam) through the current classifier.
                  </p>
                  <p className="mt-1 text-xs text-amber-700">
                    This makes Gemini API calls and uses quota. The examples are
                    synthetic test fixtures, not your private emails; this small
                    set is a smoke test, not a reliable production accuracy
                    estimate.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={runClassificationEvaluation}
                  disabled={evaluationLoading}
                  className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                >
                  {evaluationLoading ? "Evaluating…" : "Run evaluation"}
                </button>
              </div>
              {evaluationError && (
                <div
                  role="alert"
                  className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
                >
                  {evaluationError}
                </div>
              )}
              {evaluationResult && (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="rounded-lg bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">Accuracy</p>
                      <p className="mt-1 text-2xl font-bold">
                        {evaluationResult.accuracy}%
                      </p>
                      <p className="text-xs text-slate-500">
                        {evaluationResult.correct}/{evaluationResult.total}{" "}
                        predictions matched expected labels.
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">
                        Classification success
                      </p>
                      <p className="mt-1 text-2xl font-bold">
                        {evaluationResult.successRate}%
                      </p>
                      <p className="text-xs text-slate-500">
                        {evaluationResult.successful}/{evaluationResult.total}{" "}
                        returned a valid classified label.
                      </p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">
                        Misclassified / failed
                      </p>
                      <p className="mt-1 text-2xl font-bold text-rose-600">
                        {evaluationResult.total - evaluationResult.correct}
                      </p>
                      <p className="text-xs text-slate-500">
                        Review the cases below for category confusion.
                      </p>
                    </div>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="min-w-[900px] w-full text-left text-sm">
                      <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                        <tr>
                          <th className="p-3">Example</th>
                          <th className="p-3">Expected</th>
                          <th className="p-3">Predicted</th>
                          <th className="p-3">Status</th>
                          <th className="p-3">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evaluationResult.cases.map((item) => (
                          <tr
                            key={item.id}
                            className="border-t border-slate-100"
                          >
                            <td className="p-3">{item.subject}</td>
                            <td className="p-3">{item.expected}</td>
                            <td className="p-3">{item.predicted}</td>
                            <td className="p-3">{item.status || "unknown"}</td>
                            <td className="p-3">
                              <span
                                className={`rounded-full px-2 py-1 text-xs font-semibold ${item.correct ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}
                              >
                                {item.correct ? "Correct" : "Mismatch"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="min-w-[620px] w-full text-left text-sm">
                      <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                        <tr>
                          <th className="p-3">Category</th>
                          <th className="p-3">Examples</th>
                          <th className="p-3">Correct</th>
                          <th className="p-3">Recall</th>
                          <th className="p-3">Precision</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(evaluationResult.perCategory || []).map((item) => (
                          <tr
                            key={item.category}
                            className="border-t border-slate-100"
                          >
                            <td className="p-3">{item.category}</td>
                            <td className="p-3">{item.support}</td>
                            <td className="p-3">{item.correct}</td>
                            <td className="p-3">
                              {item.recall === null ? "—" : `${item.recall}%`}
                            </td>
                            <td className="p-3">
                              {item.precision === null
                                ? "—"
                                : `${item.precision}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="min-w-[1100px] w-full text-left text-xs">
                      <thead className="bg-slate-100">
                        <tr>
                          <th className="sticky left-0 bg-slate-100 p-2">
                            Expected ↓ / Predicted →
                          </th>
                          {[...CATEGORIES, "Unclassified"].map((label) => (
                            <th key={label} className="p-2">
                              {label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...CATEGORIES].map((expected) => (
                          <tr
                            key={expected}
                            className="border-t border-slate-100"
                          >
                            <th className="sticky left-0 bg-white p-2 text-left font-semibold">
                              {expected}
                            </th>
                            {[...CATEGORIES, "Unclassified"].map(
                              (predicted) => (
                                <td
                                  key={predicted}
                                  className={`p-2 text-center ${expected === predicted ? "bg-emerald-50 font-bold" : ""}`}
                                >
                                  {evaluationResult.confusionMatrix?.[
                                    expected
                                  ]?.[predicted] ?? 0}
                                </td>
                              ),
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          )}
        </section>
      )}
    </main>
  );
};

export default App;
