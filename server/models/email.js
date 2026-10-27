const mongoose = require("mongoose");

const emailSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    // Gmail conversation metadata used by thread summaries and deadline-change detection.
    threadId: { type: String, default: "", index: true },
    internalDate: { type: Number, default: null, index: true },
    senderName: { type: String, default: "Unknown Sender" },
    senderMail: { type: String, default: "", index: true },
    subject: { type: String, default: "" },
    snippet: { type: String, default: "" },
    date: { type: String, default: "Unknown Date" },
    isRead: { type: Boolean, default: false },
    isPriority: { type: Boolean, default: false },
    body: { type: String, default: "" },
    classification: { type: String, default: "Unclassified" },
    modelClassification: { type: String, default: "Unclassified" },
    classificationSource: { type: String, default: "existing" },
    priorityLevel: { type: String, enum: ["High", "Medium", "Low"], default: "Low" },
    priorityScore: { type: Number, default: 0, min: 0, max: 100 },
    priorityReasons: { type: [String], default: [] },
    priorityOverride: { type: Boolean, default: false },
    feedbackAppliedPriority: { type: String, enum: ["High", "Medium", "Low", null], default: null },
    senderTrusted: { type: Boolean, default: false },
    classificationStatus: { type: String, default: "pending" },
    aiUrgency: { type: String, enum: ["High", "Medium", "Low", null], default: null },
    aiPriorityReason: { type: String, default: "" },
  },
  { timestamps: true, strict: true },
);

module.exports = mongoose.models.Email || mongoose.model("Email", emailSchema);
