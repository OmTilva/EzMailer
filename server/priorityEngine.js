const safeLower = (value) => String(value || "").toLowerCase();
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function computePriority(email, senderPreference) {
  const text = `${email.senderName || ""} ${email.senderMail || ""} ${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`.toLowerCase();
  let score = 10;
  const reasons = [];
  const highSignals = ["otp", "fraud", "suspicious transaction", "account blocked", "payment failed", "interview", "offer letter", "job offer", "action required", "urgent", "deadline", "exam schedule", "placement drive"];
  const financeSignals = ["bank", "transaction", "credit card", "debit card", "account statement", "upi", "invoice", "payment due"];
  const careerSignals = ["recruiter", "application status", "shortlisted", "assessment", "career", "internship", "resume"];
  const urgent = highSignals.find((term) => text.includes(term));
  if (urgent) { score += 35; reasons.push(`Urgency/action signal: ${urgent}`); }
  if (email.aiUrgency === "High") { score += 20; reasons.push(`Gemini assessed urgency as High${email.aiPriorityReason ? `: ${email.aiPriorityReason}` : ""}`); }
  else if (email.aiUrgency === "Medium") { score += 8; reasons.push(`Gemini assessed urgency as Medium${email.aiPriorityReason ? `: ${email.aiPriorityReason}` : ""}`); }
  else if (email.aiUrgency === "Low") { score -= 3; reasons.push(`Gemini assessed urgency as Low${email.aiPriorityReason ? `: ${email.aiPriorityReason}` : ""}`); }
  const finance = financeSignals.find((term) => text.includes(term));
  if (finance) { score += 25; reasons.push(`Financial signal: ${finance}`); }
  const career = careerSignals.find((term) => text.includes(term));
  if (career) { score += 25; reasons.push(`Career-related signal: ${career}`); }
  if (email.classification === "Banking/Finance") { score += 10; reasons.push("AI category: Banking/Finance"); }
  if (email.classification === "Work/Professional") { score += 8; reasons.push("AI category: Work/Professional"); }
  if (["Social/Promotions", "Newsletters/Updates"].includes(email.classification)) { score -= 12; reasons.push("Routine promotional/update category"); }
  if (senderPreference && senderPreference.trusted) { score += 15; reasons.push("Sender marked as trusted"); }
  if (senderPreference && senderPreference.feedbackCount >= 2) {
    const { highCount = 0, mediumCount = 0, lowCount = 0 } = senderPreference;
    if (highCount > lowCount && highCount >= mediumCount) { score += 12; reasons.push("Prior user feedback favors High for this sender"); }
    else if (lowCount > highCount && lowCount >= mediumCount) { score -= 12; reasons.push("Prior user feedback favors Low for this sender"); }
    else if (mediumCount > highCount && mediumCount > lowCount) { score += 3; reasons.push("Prior user feedback favors Medium for this sender"); }
  }
  score = clamp(Math.round(score), 0, 100);
  const priorityLevel = score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  if (!reasons.length) reasons.push("No strong urgency, finance, career, or sender-preference signals detected");
  return { priorityScore: score, priorityLevel, isPriority: priorityLevel === "High", priorityReasons: reasons };
}


module.exports = { computePriority };
