// @skoobi/billing — internal credit accounting (quota), separate from
// @skoobi/payments (the external payment API). The sqlite handle is injected
// by the host via createQuotaSchema(db) at database-init time.
export * from './quota.js';
