# Memory and privacy

Skoobi stores memory per tenant. A guest tenant must not receive owner memory
or another tenant's memory.

Memory records should retain provenance such as tenant, sender, source,
message/event identifier, confidence, and creation time. Unverified
media-derived facts should remain low-confidence until a user confirms them.

Runtime memory, conversations, databases, and media are local instance state.
They must not be committed to the source repository or included in bug reports.

Deletion must be scoped to the confirmed tenant and sender. It must not erase
audit, accounting, event, or message records outside the requested scope.
