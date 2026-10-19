// Picks the CRM adapter named by CRM_PROVIDER (none | dsb). Every adapter exports:
//   listQueue()                           -> Lead[]  (callable leads, normalized)
//   getLead(id)                           -> Lead | null
//   writeHandoff({ lead, state, status }) -> result  (status "complete" | "transfer")
//   writeOutcome({ lead, state })         -> result  (any ending that is not a handoff)
//   addNote(lead, text)                   -> void
//   findByPhone(phone, { recentMinutes }) -> Lead | null  (inbound caller lookup; with recentMinutes, only a lead created that recently)
// Lead = { id, first_name, last_name, phone, state, timezone, dnc, created_at? }
import { config } from "../config.mjs";

const ADAPTERS = {
  none: () => import("./none.mjs"),
  dsb: () => import("./dsb.mjs"),
};

if (!ADAPTERS[config.crmProvider]) throw new Error(`CRM_PROVIDER "${config.crmProvider}" is unknown; use one of ${Object.keys(ADAPTERS).join(", ")}`);

export const crm = await ADAPTERS[config.crmProvider]();
