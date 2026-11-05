import { vocabularyEntry as e, type ModuleVocabularies } from './types';

/**
 * OR-02 agent and AI state vocabularies (owner A, workstream A batch 2: A8 agent principals, A9
 * consents, A10 proposals, A11 drafts, A12 evaluation runs and the use-case registry, A13 prescribing
 * envelope). Labels are synthetic operator-facing plain English pending workflow validation; no colour or
 * layout. Budgets carry no state code (counters only). The use-case `gate` (an evaluation verdict, or `stale`/
 * `none`) is a derived read field, not a stored state; it has no vocabulary because `none` is a reserved
 * filter sentinel. `sources` are DB CHECK columns or schema enums
 * (tests/integration/vocabularies.test.ts).
 */
export const AGENTS_VOCABULARIES: ModuleVocabularies = {
  module: 'agents',
  owner: 'A',
  version: 'agents-state-labels.1',
  vocabularies: [
    {
      name: 'agent_principal',
      sources: ['agent_principals.state', 'schema:agents:Agent.state'],
      entries: [
        e('active', 'ACT', 'Active', 'lifecycle', false),
        e('suspended', 'SUS', 'Suspended', 'exception', false),
        e('revoked', 'REV', 'Revoked', 'lifecycle', true),
      ],
    },
    {
      name: 'agent_consent',
      sources: ['agent_consents.state', 'schema:agents:Consent.state'],
      entries: [
        e('active', 'ACT', 'In effect', 'lifecycle', false),
        e('revoked', 'REV', 'Withdrawn', 'lifecycle', true),
      ],
    },
    {
      name: 'operation_proposal',
      sources: ['operation_proposals.state', 'schema:agents:ActionProposal.state'],
      entries: [
        e('prepared', 'PRE', 'Awaiting approval', 'lifecycle', false),
        e('approved', 'APP', 'Approved, not yet carried out', 'lifecycle', false),
        e('committing', 'CMG', 'Being carried out', 'lifecycle', false),
        e('committed', 'COM', 'Carried out', 'lifecycle', true),
        e('rejected', 'REJ', 'Rejected', 'exception', true),
        e('expired', 'EXP', 'Expired', 'exception', true),
        e('abandoned', 'ABN', 'Withdrawn by proposer', 'lifecycle', true),
      ],
    },
    {
      name: 'ai_draft',
      sources: ['ai_drafts.state', 'schema:agents:AiDraft.state'],
      entries: [
        e('offered', 'OFF', 'Ready for review', 'lifecycle', false),
        e('flagged', 'FLG', 'Needs closer review', 'exception', false),
        e('accepted', 'ACC', 'Accepted by reviewer', 'lifecycle', true),
        e('rejected', 'REJ', 'Rejected by reviewer', 'lifecycle', true),
        e('stale', 'STL', 'Out of date (source changed)', 'exception', true),
      ],
    },
    {
      name: 'ai_evaluation_verdict',
      sources: ['schema:agents:AiEvaluation.verdict'],
      entries: [
        e('pass', 'PASS', 'Passed', 'lifecycle', true),
        e('fail', 'FAIL', 'Failed', 'exception', true),
        e('inconclusive', 'INC', 'Inconclusive', 'exception', true),
      ],
    },
    {
      name: 'ai_use_case_approval',
      sources: ['schema:agents:AiUseCaseState.approval'],
      entries: [
        e('recommendedPendingApproval', 'PEND', 'Recommended, awaiting approval', 'lifecycle', false),
        e('approved', 'APP', 'Approved', 'lifecycle', false),
        e('notApproved', 'NAPP', 'Not approved', 'exception', false),
      ],
    },
    {
      name: 'prescription',
      sources: ['schema:agents:PrescriptionCommand.state'],
      entries: [
        e('draft', 'DRF', 'Draft', 'clinical', false),
        e('submitted', 'SUB', 'Sent to pharmacy', 'clinical', false),
        e('unknown', 'UNK', 'Outcome unknown', 'exception', false),
        e('cancelled', 'CAN', 'Cancelled', 'clinical', true),
      ],
    },
  ],
};
