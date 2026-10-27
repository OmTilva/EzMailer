const test = require("node:test");
const assert = require("node:assert/strict");
const { computePriority } = require("../priorityEngine");

test("urgent banking email receives High priority and explanatory reasons", () => {
  const result = computePriority({
    senderName: "Example Bank",
    senderMail: "alerts@examplebank.com",
    snippet: "Urgent: OTP for transaction",
    body: "Your bank transaction needs attention",
    classification: "Banking/Finance",
  }, null);
  assert.equal(result.priorityLevel, "High");
  assert.equal(result.isPriority, true);
  assert.ok(result.priorityScore >= 70 && result.priorityScore <= 100);
  assert.ok(result.priorityReasons.length > 0);
});

test("trusted sender weighting increases the score", () => {
  const email = { senderName: "Colleague", senderMail: "person@example.com", snippet: "Hello", body: "Just checking in", classification: "Personal/Family" };
  const ordinary = computePriority(email, null);
  const trusted = computePriority(email, { trusted: true, feedbackCount: 0 });
  assert.equal(trusted.priorityScore, ordinary.priorityScore + 15);
});

test("repeated low-priority feedback lowers sender score", () => {
  const email = { senderName: "Updates", senderMail: "news@example.com", snippet: "Weekly newsletter", body: "Read our updates", classification: "Newsletters/Updates" };
  const result = computePriority(email, { trusted: false, feedbackCount: 5, highCount: 0, mediumCount: 1, lowCount: 4 });
  assert.ok(result.priorityReasons.some((reason) => reason.includes("feedback favors Low")));
  assert.equal(result.priorityLevel, "Low");
});

test("priority score stays within 0-100", () => {
  const result = computePriority({
    senderName: "Bank Recruiter",
    senderMail: "urgent@bank.example.com",
    snippet: "Urgent OTP payment due interview offer letter",
    body: "Transaction action required",
    classification: "Banking/Finance",
  }, { trusted: true, feedbackCount: 4, highCount: 4, mediumCount: 0, lowCount: 0 });
  assert.ok(result.priorityScore >= 0 && result.priorityScore <= 100);
});

test("Gemini urgency assessment influences priority score", () => {
  const email = { senderName: "Service", senderMail: "notice@example.com", snippet: "Update", body: "Your request has been received", classification: "Personal/Family", aiUrgency: "High", aiPriorityReason: "Action required today" };
  const lowUrgency = computePriority({ ...email, aiUrgency: "Low" }, null);
  const highUrgency = computePriority(email, null);
  assert.equal(highUrgency.priorityScore - lowUrgency.priorityScore, 23);
  assert.ok(highUrgency.priorityReasons.some((reason) => reason.includes("Gemini assessed urgency as High")));
});
