# EzMailer final-review test checklist

## Automated tests
Run from `server/`:

```powershell
npm test
```

The unit tests validate the priority scoring rules, Gemini urgency contribution, trusted-sender boost, learned sender feedback, and score bounds. These do not replace end-to-end tests against Gmail, Gemini, and MongoDB.

## End-to-end acceptance tests

1. **Start-up:** MongoDB is running; `npm start` works in the project root; `npm start` works in `server/`.
2. **OAuth:** Sign in through Google; reload the frontend; verify authentication remains available; logout; verify the UI returns to signed-out state.
3. **Fetch latest:** Click **Fetch 20 Emails**. Verify a maximum of 20 Primary-category messages are returned, each has a Gmail message ID, and documents are stored in `ezmail.emails`.
4. **Date filter:** Select a date and click **Fetch Date**. Verify the result is limited to that local calendar date and saved to MongoDB.
5. **AI classification:** For a new or `Unclassified` message, confirm `classification` is one of the eight supported categories, `aiUrgency` is High/Medium/Low, and `classificationStatus` is `classified`. Existing classified messages are not sent to Gemini again during routine fetches.
6. **AI outage:** Temporarily unset/invalid `GEMINI_API_KEY` only in a safe test session. Fetch should not crash the backend; the response should indicate classification warnings and the record should remain `Unclassified` with rule-based scoring. Restore the key afterward.
7. **Priority persistence:** Confirm `priorityLevel`, `priorityScore`, `priorityReasons`, and `isPriority` exist in MongoDB and remain consistent after refresh.
8. **Manual priority:** Set one email to High, Medium, and Low in separate tests. Verify the chosen value persists, `isPriority` is true only for High, and the email is not overwritten on the next fetch.
9. **Sender feedback:** Change priorities for emails from the same sender more than once. Confirm a sender-preference document is created/updated and later scores can show a sender-feedback reason.
10. **Trusted sender:** Use **Trust sender** and verify future emails from that sender include the trusted boost; toggle it off and verify the preference is removed from the boost.
11. **Search/filter:** Search sender, email address, subject/snippet/body; combine with priority and category filters; clear filters and verify the full fetched list returns.
12. **Full body/reasons:** Expand an email and verify full body, priority score, and reasons display without breaking row interactions.
13. **Error handling:** Try a date without choosing a date, an invalid date API request, and an unavailable Gemini configuration; verify helpful errors/warnings and no server crash.

## Evidence to record for the final review

Record only measured results: number of emails tested, category-wise correct/incorrect counts, priority test outcomes, fetch duration, and failures encountered. Do not reuse unverified accuracy or latency figures from earlier drafts as measured results.
