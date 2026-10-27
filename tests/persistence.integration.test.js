const test = require("node:test");
const assert = require("node:assert/strict");
const mongoUri = process.env.EZMAIL_TEST_MONGODB_URI;
const integrationTest = mongoUri ? test : test.skip;

integrationTest("thread metadata, action completion, and category feedback persist in MongoDB", async () => {
  const mongoose = require("mongoose");
  const Email = require("../server/models/email");
  const ActionItem = require("../server/models/actionItem");
  const ClassificationFeedback = require("../server/models/classificationFeedback");
  const fs = require("node:fs");
  const path = require("node:path");
  const senderPreferencePath = path.join(__dirname, "..", "server", "models", "senderPreference.js");
  const SenderPreference = fs.existsSync(senderPreferencePath) ? require(senderPreferencePath) : null;
  await mongoose.connect(mongoUri);
  const suffix = `${process.pid}-${Date.now()}`;
  const emailId = `integration-email-${suffix}`;
  const actionKey = `integration-action-${suffix}`;
  const senderMail = `test-${suffix}@example.invalid`;
  try {
    await Email.create({
      id: emailId,
      threadId: `integration-thread-${suffix}`,
      internalDate: Date.now(),
      subject: "Persistence regression fixture",
      classification: "Work/Professional",
      classificationStatus: "classified",
    });
    await ActionItem.create({
      key: actionKey,
      emailId,
      summary: "Persist task completion",
      kind: "Action",
      done: true,
    });
    await ClassificationFeedback.create({
      emailId,
      senderMail,
      predictedCategory: "Unclassified",
      correctedCategory: "Work/Professional",
    });
    if (SenderPreference) {
      await SenderPreference.updateOne(
        { senderMail },
        { $set: { trusted: true }, $setOnInsert: { senderMail } },
        { upsert: true },
      );
    }

    // Reconnect before reading to prove the records were stored in MongoDB, not just memory.
    await mongoose.disconnect();
    await mongoose.connect(mongoUri);
    const savedEmail = await Email.findOne({ id: emailId }).lean();
    const savedAction = await ActionItem.findOne({ key: actionKey }).lean();
    const savedFeedback = await ClassificationFeedback.findOne({ emailId }).lean();
    assert.equal(savedEmail.threadId, `integration-thread-${suffix}`);
    assert.equal(savedAction.done, true);
    assert.equal(savedFeedback.correctedCategory, "Work/Professional");
    if (SenderPreference) {
      const savedPreference = await SenderPreference.findOne({ senderMail }).lean();
      assert.equal(savedPreference.trusted, true);
    }
  } finally {
    await Promise.all([
      Email.deleteOne({ id: emailId }),
      ActionItem.deleteOne({ key: actionKey }),
      ClassificationFeedback.deleteOne({ emailId }),
      ...(SenderPreference ? [SenderPreference.deleteOne({ senderMail })] : []),
    ]);
    await mongoose.disconnect();
  }
});
