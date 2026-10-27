const mongoose = require("mongoose");

const senderPreferenceSchema = new mongoose.Schema(
  {
    senderMail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    trusted: { type: Boolean, default: false },
    highCount: { type: Number, default: 0, min: 0 },
    mediumCount: { type: Number, default: 0, min: 0 },
    lowCount: { type: Number, default: 0, min: 0 },
    feedbackCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.SenderPreference || mongoose.model("SenderPreference", senderPreferenceSchema);
