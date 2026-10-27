const test = require("node:test");
const assert = require("node:assert/strict");
const {
  messageTimestamp,
  findDatesInText,
  detectDeadlineChanges,
  detectPlanChanges,
  groupThreads,
} = require("../server/threadIntelligence");

test("parses month-name, ISO and India-style numeric dates", () => {
  assert.deepEqual(findDatesInText("Due by October 30, 2026", new Date("2026-01-01T00:00:00Z")).map((x) => x.date), ["2026-10-30"]);
  assert.deepEqual(findDatesInText("Rescheduled to 5 November 2026", new Date("2026-01-01T00:00:00Z")).map((x) => x.date), ["2026-11-05"]);
  assert.deepEqual(findDatesInText("Deadline: 05/11/2026", new Date("2026-01-01T00:00:00Z")).map((x) => x.date), ["2026-11-05"]);
});

test("reads EzMailer DD-MM-YYYY dates deterministically", () => {
  const value = messageTimestamp({ date: "30-10-2026 18:45:00" });
  assert.ok(value > 0);
  const d = new Date(value);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 30);
});

test("groups emails by Gmail threadId and leaves unthreaded messages separate", () => {
  const groups = groupThreads([
    { id: "a", threadId: "t1", subject: "First", date: "01-10-2026 10:00:00", senderName: "Alex" },
    { id: "b", threadId: "t1", subject: "Follow up", date: "02-10-2026 10:00:00", senderName: "Sam" },
    { id: "c", subject: "Standalone", date: "03-10-2026 10:00:00", senderName: "Lee" },
  ]);
  assert.equal(groups.length, 2);
  const thread = groups.find((group) => group.threadId === "t1");
  assert.equal(thread.count, 2);
  assert.equal(thread.subject, "Follow up");
  assert.deepEqual(thread.emailIds, ["a", "b"]);
});

test("detects a later explicit deadline extension", () => {
  const messages = [
    {
      id: "old", threadId: "t1", internalDate: Date.parse("2026-10-01T09:00:00Z"),
      subject: "Registration deadline", body: "The registration deadline is October 30, 2026.",
    },
    {
      id: "new", threadId: "t1", internalDate: Date.parse("2026-10-20T09:00:00Z"),
      subject: "Updated registration deadline", body: "The deadline has been extended to November 5, 2026.",
    },
  ];
  const changes = detectDeadlineChanges(messages);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousDeadline, "2026-10-30");
  assert.equal(changes[0].updatedDeadline, "2026-11-05");
  assert.equal(changes[0].emailId, "new");
});

test("does not report a deadline change when the later email repeats the same date", () => {
  const messages = [
    { id: "old", internalDate: 100, subject: "Deadline", body: "The deadline is October 30, 2026." },
    { id: "new", internalDate: 200, subject: "Deadline reminder", body: "Reminder: the deadline has been extended? No, the deadline remains October 30, 2026." },
  ];
  assert.equal(detectDeadlineChanges(messages).length, 0);
});


test("detects a later message that reschedules a meeting", () => {
  const messages = [
    { id: "m1", internalDate: Date.parse("2026-10-01T09:00:00Z"), subject: "Project review", body: "Our project review meeting is scheduled for Tuesday in Room 2." },
    { id: "m2", internalDate: Date.parse("2026-10-02T09:00:00Z"), subject: "Updated project review", body: "The project review meeting has been moved to Thursday and will now take place online." },
  ];
  const changes = detectPlanChanges(messages);
  assert.ok(changes.length >= 1);
  assert.equal(changes[0].emailId, "m2");
  assert.match(changes[0].signal, /moved to Thursday/i);
});
