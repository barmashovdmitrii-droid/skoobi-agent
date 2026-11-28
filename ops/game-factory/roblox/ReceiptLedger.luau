--!strict
-- Local bounded guard, not a cloud ledger. Never evicts receipt history.
-- Call on the server without yielding before grant, and persist receipt + reward
-- atomically in one profile. Capacity requires migration; real purchases remain
-- disabled until verified. Previously discarded historical IDs cannot be recovered.
local Ledger = {}
export type Decision = "new" | "duplicate" | "capacity" | "invalid"

function Ledger.reserve(receipts: any, purchaseId: any, capacity: any): Decision
    if type(receipts) ~= "table" or type(purchaseId) ~= "string" or #purchaseId < 1 or #purchaseId > 512
        or type(capacity) ~= "number" or capacity ~= capacity or capacity % 1 ~= 0 or capacity < 1 or capacity > 10000 then
        return "invalid"
    end
    local seen: {[string]: boolean} = {}
    local count = 0
    for index, value in receipts do
        if type(index) ~= "number" or index % 1 ~= 0 or index < 1 or index > #receipts
            or type(value) ~= "string" or #value < 1 or #value > 512 or seen[value] then return "invalid" end
        seen[value] = true
        count += 1
    end
    if count ~= #receipts or count > capacity then return "invalid" end
    if seen[purchaseId] then return "duplicate" end
    if count >= capacity then return "capacity" end
    table.insert(receipts, purchaseId)
    return "new"
end

return table.freeze(Ledger)
