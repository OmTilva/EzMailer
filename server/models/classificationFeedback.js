const mongoose = require("mongoose");

const classificationFeedbackSchema = new mongoose.Schema(
  {
    // One latest correction per email prevents repeatedly toggling a category from inflating learning counts.
    emailId: { type: String, required: true, unique: true, index: true },
    senderMail: { type: String, default: "", lowercase: true, trim: true, index: true },
    predictedCategory: { type: String, default: "Unclassified" },
    correctedCategory: { type: String, required: true },
  },
  { timestamps: true, strict: true },
);

module.exports = mongoose.models.ClassificationFeedback || mongoose.model("ClassificationFeedback", classificationFeedbackSchema);
