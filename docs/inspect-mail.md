# Loaded mailbox inspection

`wow__inspect_mail` is an on-demand deferred Eve tool with a built-in core
capability, not a player-toggleable Settings switch. Input is strictly
`{ limit?: 1..50 }` (default 10). The player must
keep the mailbox open. No mail is included in automatic character snapshots.
The authenticated bridge checks the active Eve conversation and transport session,
capability and non-proactive turn before issuing the existing game inspection.

The reader observes only loaded headers and up to 16 receive slots per bounded
row. It returns attached copper, COD copper, known remaining **days**, item IDs
and quantities, field/slot coverage and capture/revalidation timestamps. Header
text, sender identity and read-state fields are discarded, never serialized.
Attachment names are untrusted optional presentation. The native header's first
item link is associated only with a single attachment whose ID matches; other
links stay unknown. Exact links longer than 1,024 bytes are omitted, not rewritten.
No item-data requests or other automatic cache loads occur.

Mailbox events only invalidate the capture revision. A second bounded pass and
end-of-capture window/count/revision checks reject mixed rows, including same-count
changes. Positions are capture-local, not message identities. Identical public
metadata cannot distinguish identical messages. No cache is retained. Missing,
restricted, malformed or loading fields remain unknown, never zero or free.
Loaded counts do not establish server freshness or exclude unseen mail.

Actual escaped JSON is budgeted, dropping optional names/links before rows.
The completed result, including Inspect metadata, is bounded to 48,000 bytes
before transport; production Transport.Send
rechecks the **complete envelope** at 60,000 bytes before zlib and W2 framing.
Omissions retain scanned/returned coverage. No new renderer is introduced: use
native Markdown and existing item references. Keep mail resources distinct from
fresh bag inventory and spendable money, especially COD. After manual retrieval,
an explicit new request replaces both mail and resources readings, never adds old
mail to fresh bags.

## Native source contract

Forever is Mainline-family. Source pinned to Gethe/wow-ui-source forever commit
`4cd0ab752a77164f654ccbca9d0c1fe8dafceebe`:

- [Blizzard_MailFrame.toc](https://github.com/Gethe/wow-ui-source/blob/4cd0ab752a77164f654ccbca9d0c1fe8dafceebe/Interface/AddOns/Blizzard_MailFrame/Blizzard_MailFrame.toc): `AllowLoadGameType: mainline` includes Forever.
- [MailFrame.lua](https://github.com/Gethe/wow-ui-source/blob/4cd0ab752a77164f654ccbca9d0c1fe8dafceebe/Interface/AddOns/Blizzard_MailFrame/MailFrame.lua): lines 317–340 consume loaded/total counts and header tuple; 359–361 consume first item quantity/link; 391–397 convert remaining days to seconds for presentation; 406–409 use COD; 706–717 consume presence and item name/ID/count/currency for 16 receive slots.
- [MailInfoDocumentation.lua](https://github.com/Gethe/wow-ui-source/blob/4cd0ab752a77164f654ccbca9d0c1fe8dafceebe/Interface/AddOns/Blizzard_APIDocumentationGenerated/MailInfoDocumentation.lua) documents synchronous MAIL_SHOW/CLOSED/INBOX_UPDATE/SUCCESS events. Legacy getter tuples are established by the selected caller, not fabricated generated signatures.

The pinned caller consumes presence and currency flags through Lua truthiness;
it does not establish literal boolean return types. The reader conservatively
treats nil, numeric and restricted flags as unknown. A legacy 1/nil contract could
therefore suppress useful identities; native typing remains unverified, with no
live probe authorized. Offline manually denied capability flags test permission
gates, not user Settings behavior.

The reader never invokes `GetInboxText`, `CheckInbox`, invoice/body reads,
open-message/read-state functions, retrieval, payment, send, delete or return.
Offline fixtures exercise production reader/Inspect/Send, escaped framing/decode,
native Eve discovery and authenticated session gates. They do **not** establish
native C_EncodingUtil behavior, physical Windows/Forever API availability,
native read-state side effects, taint, recommendation quality,
UX or latency; those remain explicitly unverified.
