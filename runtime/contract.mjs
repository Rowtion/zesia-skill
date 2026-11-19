export const CONSULT_MEDIA_TYPE = 'application/vnd.zesia.consult+json';
export const A2A_PROTOCOL_VERSION = '1.0';

export const CONSULT_RESULT_V2 = 'zesia.consult.result.v2';

export function consultFollowUpRequests(result) {
  if (result?.resultSchemaVersion === CONSULT_RESULT_V2) {
    const action = result.nextAction;
    if (!['apply_advice', 'supply_evidence', 'ask_user_decision', 'escalate'].includes(action?.kind)) return [];
    return Array.isArray(action.requests) ? action.requests : [];
  }
  return Array.isArray(result?.followUp?.requests) ? result.followUp.requests : [];
}
