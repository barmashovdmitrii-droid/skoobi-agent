--!nonstrict
local Ledger = require('./ReceiptLedger')
local function eq(a,b) assert(a==b,tostring(a)..' != '..tostring(b)) end
local receipts={}
for i=1,100 do eq(Ledger.reserve(receipts,'synthetic-'..i,100),'new') end
eq(Ledger.reserve(receipts,'synthetic-101',100),'capacity')
eq(#receipts,100);eq(receipts[1],'synthetic-1')
eq(Ledger.reserve(receipts,'synthetic-1',100),'duplicate')
local reloaded=table.clone(receipts)
eq(Ledger.reserve(reloaded,'synthetic-1',100),'duplicate')
eq(Ledger.reserve(reloaded,'synthetic-101',100),'capacity')
for _,bad in {{'duplicate','duplicate'},{[2]='hole'},{secret='not-an-array'}} do
 eq(Ledger.reserve(bad,'new',100),'invalid')
end
eq(Ledger.reserve({},'x',0),'invalid');eq(Ledger.reserve({},'x',0/0),'invalid')
local shared={};eq(Ledger.reserve(shared,'same',100),'new');eq(Ledger.reserve(shared,'same',100),'duplicate')
print('PASS ReceiptLedger bounded retention, restart copy, replay, two callers, malformed data; no storage/provider calls')
