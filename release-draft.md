# Raynard v0.16.0

This release fixes bookmark references, so an answer you saved can be brought
into a new question.

- Picking a bookmark from the `@` menu now attaches its saved question and
  answer to your message. Before, the menu inserted the bookmark's name, but
  sending only recognised it with a leading `@`. The bookmark never reached the
  model, which then said it couldn't see other chats.
- A bookmark name you type or paste yourself, with or without `@`, is
  recognised too, including at the end of a sentence. The match must be exact,
  including the short code at the end of every bookmark name, so ordinary words
  never attach a bookmark by accident.
- Bookmark matching now runs in the app's native core against the bookmark
  store it already keeps, so the window no longer loads every bookmark just to
  power the `@` menu. Existing bookmark names are unchanged.
