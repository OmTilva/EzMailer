const mongoose = require("mongoose");

const actionItemSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    emailId: { type: String, required: true, index: true },
    summary: { type: String, required: true, maxlength: 1000 },
    kind: { type: String, default: "Action", maxlength: 80 },
    deadline: { type: Date, default: null },
    done: { type: Boolean, default: false },
  },
  { timestamps: true, strict: true },
);

module.exports = mongoose.models.ActionItem || mongoose.model("ActionItem", actionItemSchema);
