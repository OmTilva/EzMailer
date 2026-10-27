"use strict";

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const MONTH_PATTERN = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const DEADLINE_CUE = /\b(deadline|due\s+(?:date|by|on|is)?|payment due|no later than|submit by|respond by|register by|before\s+(?:the\s+)?deadline|reschedul\w*|extend\w*|postpon\w*|moved to|shifted to|new (?:date|deadline)|updated (?:date|deadline)|now due|changed to|date has changed|instead)\b/i;
const CHANGE_CUE = /\b(reschedul\w*|extend\w*|postpon\w*|revis\w*|moved(?:\s+\w+){0,5}\s+to|shifted(?:\s+\w+){0,5}\s+to|new (?:date|deadline)|updated (?:date|deadline)|now due|changed(?:\s+\w+){0,5}\s+to|date has changed|deadline.{0,35}(?:changed|extended|moved|updated|now)|due date.{0,25}(?:changed|extended|moved|updated|now)|instead|deadline change)\b/i;
const PLAN_CHANGE_CUE = /\b(reschedul\w*|postpon\w*|cancel(?:led|ed)|moved from|moved(?:\s+\w+){0,5}\s+to|changed from|changed(?:\s+\w+){0,5}\s+to|updated (?:time|date|plan|location|venue|room)|new (?:time|date|location|venue|room)|instead of|no longer|will now take place|now taking place|has been moved|has been changed|schedule has changed|switch(?:ed)? to (?:online|virtual|in person|remote))\b/i;
const PLAN_CONTEXT = /\b(meet(?:ing)?|interview|appointment|call|event|session|schedule|plan|delivery|reservation|flight|venue|location|room|time|date|webinar|review|workshop|conference|booking)\b/i;

function safeText(value) {
  return typeof value === "string" ? value : String(value ?? "");
}

function messageTimestamp(message) {
  const numeric = Number(message && message.internalDate);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const dateText = safeText(message && message.date);
  // EzMailer stores dates as DD-MM-YYYY HH:mm:ss; Date.parse alone is locale-dependent.
  const local = dateText.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (local) {
    const d = new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]), Number(local[4] || 0), Number(local[5] || 0), Number(local[6] || 0));
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  const parsed = Date.parse(dateText);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function makeDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const date = new Date(year, month, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function monthIndex(value) {
  return MONTHS[safeText(value).toLowerCase().replace(/\.$/, "")] ?? null;
}

function findDatesInText(text, baseDate) {
  const source = safeText(text);
  const base = baseDate instanceof Date && !Number.isNaN(baseDate.getTime()) ? baseDate : new Date();
  const found = [];
  const add = (index, iso, raw) => {
    if (iso) found.push({ index, date: iso, raw });
  };
  let match;

  const isoPattern = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
  while ((match = isoPattern.exec(source))) add(match.index, makeDate(+match[1], +match[2] - 1, +match[3]), match[0]);

  const monthFirst = new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "gi");
  while ((match = monthFirst.exec(source))) add(match.index, makeDate(Number(match[3] || base.getFullYear()), monthIndex(match[1]), Number(match[2])), match[0]);

  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?[,]?(?:\\s+(20\\d{2}))?\\b`, "gi");
  while ((match = dayFirst.exec(source))) add(match.index, makeDate(Number(match[3] || base.getFullYear()), monthIndex(match[2]), Number(match[1])), match[0]);

  // Numeric dates use day/month/year to match the app's primary India locale.
  const numeric = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/g;
  while ((match = numeric.exec(source))) add(match.index, makeDate(+match[3], +match[2] - 1, +match[1]), match[0]);

  const deduped = new Map();
  for (const item of found.sort((a, b) => a.index - b.index)) {
    const key = `${item.index}:${item.date}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }
  return [...deduped.values()];
}

function extractDeadlineMentions(message) {
  const text = [message && message.subject, message && message.snippet, message && message.body]
    .map(safeText).filter(Boolean).join("\n");
  if (!text || !DEADLINE_CUE.test(text)) return [];

  const receivedDate = new Date(messageTimestamp(message) || Date.now());
  const sentences = text.split(/\r?\n+|(?<=[.!?])\s+/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  const mentions = [];
  for (const sentence of sentences) {
    if (!DEADLINE_CUE.test(sentence)) continue;
    const dates = findDatesInText(sentence, receivedDate);
    if (!dates.length) continue;
    mentions.push({
      dates: dates.map((item) => item.date),
      phrase: sentence.slice(0, 240),
      changed: CHANGE_CUE.test(sentence),
      emailId: safeText(message && message.id),
      subject: safeText(message && message.subject) || "(No subject)",
      timestamp: messageTimestamp(message),
      date: safeText(message && message.date),
    });
  }
  return mentions;
}

function detectDeadlineChanges(messages = []) {
  const ordered = [...messages].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
  let current = null;
  const changes = [];
  for (const message of ordered) {
    const mentions = extractDeadlineMentions(message);
    for (const mention of mentions) {
      const lastMentionedDate = mention.dates[mention.dates.length - 1];
      const explicitFromTo = mention.changed && mention.dates.length > 1;
      const previousDate = explicitFromTo ? mention.dates[mention.dates.length - 2] : current && current.date;
      const updatedDate = lastMentionedDate;
      if (mention.changed && previousDate && updatedDate && previousDate !== updatedDate) {
        const previousSource = explicitFromTo ? current : current;
        changes.push({
          emailId: mention.emailId,
          subject: mention.subject,
          previousDeadline: previousDate,
          updatedDeadline: updatedDate,
          receivedDate: mention.date,
          explanation: `A later message may have changed the deadline: ${mention.phrase}`,
          previousMentionSubject: previousSource && previousSource.subject || "Earlier message in this thread",
          confidence: "Review suggested change",
        });
      }
      if (updatedDate) {
        current = {
          date: updatedDate,
          emailId: mention.emailId,
          subject: mention.subject,
          timestamp: mention.timestamp,
        };
      }
    }
  }
  // Avoid duplicate cards when subject/snippet/body repeat the same sentence.
  const seen = new Set();
  return changes.filter((change) => {
    const key = `${change.emailId}:${change.previousDeadline}:${change.updatedDeadline}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectPlanChanges(messages = []) {
  const ordered = [...messages].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
  const changes = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const message = ordered[index];
    const content = [message && message.subject, message && message.snippet, message && message.body]
      .map(safeText).filter(Boolean).join("\n");
    const sentences = content.split(/\r?\n+|(?<=[.!?])\s+/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (!PLAN_CHANGE_CUE.test(sentence) || !PLAN_CONTEXT.test(sentence)) continue;
      // Deadline changes have a separate, more specific explanation card.
      if (/\b(deadline|due date|payment due)\b/i.test(sentence)) continue;
      const priorMessages = ordered.slice(0, index);
      const prior = priorMessages.length ? priorMessages[priorMessages.length - 1] : null;
      changes.push({
        emailId: safeText(message && message.id),
        subject: safeText(message && message.subject) || "(No subject)",
        receivedDate: safeText(message && message.date),
        previousMessageSubject: prior ? safeText(prior.subject) || "Earlier message" : "No earlier message available",
        signal: sentence.slice(0, 260),
        explanation: "A later message contains wording that may change, reschedule, or cancel an earlier plan. Compare it with the previous message before acting.",
        confidence: "Review suggested change",
      });
    }
  }
  const seen = new Set();
  return changes.filter((change) => {
    const key = `${change.emailId}:${change.signal.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupThreads(emails = []) {
  const groups = new Map();
  for (const email of emails) {
    const threadId = safeText(email.threadId).trim();
    const key = threadId ? `thread:${threadId}` : `email:${safeText(email.id)}`;
    if (!groups.has(key)) groups.set(key, { key, threadId: threadId || null, messages: [] });
    groups.get(key).messages.push(email);
  }
  return [...groups.values()].map((group) => {
    const messages = [...group.messages].sort((a, b) => messageTimestamp(a) - messageTimestamp(b));
    const latest = messages[messages.length - 1] || {};
    const senderNames = [...new Set(messages.map((m) => safeText(m.senderName).trim()).filter(Boolean))];
    const deadlineChanges = detectDeadlineChanges(messages);
    const planChanges = detectPlanChanges(messages);
    return {
      key: group.key,
      threadId: group.threadId,
      emailIds: messages.map((m) => safeText(m.id)).filter(Boolean),
      count: messages.length,
      subject: safeText(latest.subject) || "(No subject)",
      latestDate: safeText(latest.date) || "Unknown date",
      latestTimestamp: messageTimestamp(latest),
      senders: senderNames,
      deadlineChanges,
      hasDeadlineChanges: deadlineChanges.length > 0,
      planChanges,
      hasPlanChanges: planChanges.length > 0,
    };
  }).sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

module.exports = {
  messageTimestamp,
  findDatesInText,
  extractDeadlineMentions,
  detectDeadlineChanges,
  detectPlanChanges,
  groupThreads,
};
