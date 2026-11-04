# Memory and privacy

Skoobi stores memory per tenant. A guest tenant must not receive owner memory
or another tenant's memory.

## Current projects and decisions

Structured memory keeps project cards and current decisions in the instance
database, scoped to the authenticated chat, tenant, and sender. A card can
record the objective, reported progress, remaining steps, a pending question,
and artifact locations. The assistant maintains cards during its work; a
card's status does not prove that a file was checked or delivered.

Important corrections use the existing record's revision and a quotation from
the user's actual message. The host checks the message identity and quotation.
This verifies the source reference, not the assistant's interpretation. Older
direct sources and conflicting revisions cannot silently replace newer
decisions. Assistant reports remain explicitly unverified.

The assistant can inspect and update records with `memory_state_read` and
`memory_state`. Large results include a continuation cursor. Expired facts are
excluded from current recall. Permission notes never authorize an action or
bypass normal runtime checks.

## Forgetting a record

An explicit current request can forget one fact or a project. Forgetting
removes the selected structured contents and their saved versions, and leaves
a marker containing record identifiers and timestamps that blocks restoration
from an old request. This is logical deletion, not forensic erasure of storage.
A newer explicit request is required to remember that record again. A newer incoming
cancellation also revokes the older deletion command.

Original chat history, other records, files, and backups remain separate.
Forgetting structured memory does not erase those sources. Automatic legacy
memory loading is disabled for the affected scope to reduce reintroduction
from old notes. The assistant must not recreate forgotten material under a
different key or claim that the original archive was erased.

## Legacy notes and source privacy

Existing notes are preserved. Bounded relevant excerpts can help with the
current question, but historical notes must be checked against current user
instructions and structured decisions. They are not automatically promoted
to verified facts.

Memory records should retain provenance such as tenant, sender, source,
message/event identifier, confidence, and creation time. Unverified
media-derived facts should remain low-confidence until a user confirms them.

Runtime memory, conversations, databases, and media are local instance state.
They must not be committed to the source repository or included in bug reports.

Deletion must be scoped to the confirmed tenant and sender. It must not erase
audit, accounting, event, or message records outside the requested scope.
