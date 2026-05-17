# Skoobi Memory

Skoobi memory is tenant-scoped and privacy-sensitive.

## Storage

Memory is expected under tenant folders, usually:

```text
groups/<folder>/memory/
```

Runtime tenant folders are not source code and must not be committed.

## Isolation Rules

- Guest tenant can read only its own tenant memory.
- Guest tenant cannot read owner/global memory.
- Guest tenant cannot read another tenant's memory.
- Private Telegram chat memory can be treated as this chat/user memory.
- Group personal memory must include `sender_id` and should only be injected for that sender.
- Legacy memory without `sender_id` must not become a verified personal fact.
- Display name and username are not identity.

## Provenance

New memory entries should include:

- `tenant_id`
- `sender_id`
- `source_type`
- `message_id` or `event_id`
- `confidence`
- `created_at`

Legacy markdown memory without metadata is treated as uncertain. Photo or image-derived memory should default to confidence `<= 0.5` unless the user confirms it.

## Deletion

Memory deletion is not a casual text command. It requires exact confirmation:

```text
ПОДТВЕРЖДАЮ УДАЛИТЬ ПАМЯТЬ
```

Deletion or tombstone operations must be scoped to the current tenant and sender where applicable.

Never delete as part of memory deletion:

- `messages`
- `events`
- `usage_ledger`
- `model_traces`
- audit/accounting records

## Audit Commands

```bash
scripts/skoobi-memory-audit.sh
scripts/skoobi-memory-smoke.sh
```

Expected warning class:

- legacy unprovenanced markdown can produce `WARN`

Hard failures:

- cross-tenant memory references
- owner/main memory in guest memory
- photo-derived facts stored as certain
- memory delete touching audit/accounting records
