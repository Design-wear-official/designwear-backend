# Inventory sync

How product stock becomes inventory in Firebase, and how to drive it via Claude (MCP).

## The two mechanisms (don't confuse them)

| | **Automatic** (always-on) | **Claude / MCP** (on-demand) |
|---|---|---|
| Runs | 24/7, no human | only while you're chatting with Claude |
| Trigger | Sanity webhook on product publish | you ask Claude |
| Use for | every product create/update | backfills, audits, fixing drift, recording sales |

MCP is **not** the automation engine — it's the ops console. The always-on path is the backend webhook.

## Collections (Firestore)

| Collection | Doc id | Purpose |
|---|---|---|
| `products` | Sanity `_id` | Catalog mirror (already synced). Holds `stock`, `stockStatus`. |
| `inventory` | `productId` | Dedicated inventory record: `stock`, `lowStockThreshold`, `status` (`inStock`/`lowStock`/`outOfStock`), `updatedAt`. |
| `inventoryMovements` | auto id | Append-only audit log: `type` (`in`/`out`), `quantity`, `previousStock`, `newStock`, `reason`, `source`, `timestamp`. |

## Automatic flow

```
Sanity product published
  │ (Sanity webhook → POST /api/sync/webhook)
  ▼
syncProductToDatabase(id)
  ├─ upsert products/{id}              (catalog mirror)
  └─ upsertInventoryRecord(id, …)      (inventory mirror + movement-on-delta)
       ├─ set inventory/{id}
       └─ if stock changed → add inventoryMovements/*
```

Implemented in `lib/services/syncService.ts`. The inventory step is **non-fatal** — if it fails, the product still syncs and `backfill` can repair it.

> Prerequisite: the Sanity webhook must point at the deployed `POST /api/sync/webhook`
> (Sanity → API → Webhooks). Without it, nothing auto-syncs.

### What gets tracked
Only **stocked catalog products**. Community / print-on-demand designs (any product
with a `creatorHandle` — the user remixes) carry no stock and are **skipped** by both
the auto-sync and `backfill`. Today that means inventory tracks the 1 real T-shirt, not
the ~17 community remixes.

## Ops endpoints (`/api/inventory/[action]`)

| Method | Action | What it does |
|---|---|---|
| `GET`  | `summary` | Counts by status + total units on hand. |
| `GET`  | `list?status=lowStock` | Inventory records, optional status filter. |
| `POST` | `backfill` | Reconcile: ensure **every** product has an inventory record. Run once after deploy, or any time drift is suspected. |
| `POST` | `adjust` | Transactional stock change + movement log. Body: `{ productId, delta, reason?, reference?, performedBy? }`. Updates `inventory`, `products`, and appends a movement atomically. |

## Driving it with Claude (MCP)

With the `firebase` MCP server connected (see project `.mcp.json`), you can say things like:

- **"Back-fill inventory for every product."** → Claude calls `POST /api/inventory/backfill` (or writes the records directly via the Firestore MCP).
- **"Show me low-stock items."** → `firestore_query_collection` on `inventory` where `status == 'lowStock'`, or `GET /api/inventory/list?status=lowStock`.
- **"Record a sale: 3 units of <productId>."** → `POST /api/inventory/adjust` with `delta: -3, reason: 'sale'`.
- **"Audit: do any products lack an inventory record?"** → Claude diffs the `products` and `inventory` collections via the Firestore MCP.

### Source-of-truth note
Sanity is authoritative for **catalog** stock (admins edit it there; the webhook re-syncs). `adjust` writes operational stock straight to Firestore for live events (sales, damage). If you need the catalog number to match after operational adjustments, edit Sanity (or add a Sanity write-back to `adjust` later).
