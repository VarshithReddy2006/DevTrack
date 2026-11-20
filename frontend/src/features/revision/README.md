# Revision session summary

The deck opens `CardSummaryModal` after its last successful review response. Failed
submissions do not count; loading a new deck clears the session. Done or Escape
returns to the completed revision page, and View session summary reopens it.
The shared Modal handles focus trapping, Escape, and focus restoration.

Statistics cover this deck only. The API currently supports `failed` (displayed as
Again/Failed), `hard`, and `easy`; there is no Good rating. Retention is an estimate
for reviewed cards using the analytics service's interval-based exponential decay
formula at each review time, not an accuracy score or whole-library retention.
Missing timestamps produce an unavailable state. Forecast dates come from saved
review responses and are grouped by the user's local calendar day.

The UI displays the expected 5 XP per saved review, with award confirmation marked
unavailable: the review endpoint returns a card, and XP failures can be caught
server-side. It cannot truthfully confirm earned XP from that response.
