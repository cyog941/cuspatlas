import { createVocabularyService } from '@cuspatlas/domain';
import { inputSchema, type ToolDefinition } from './synthetic-tasks';

/** A20 / OR-02 vocabulary tools (MCP twins of GET /v1/vocabularies and /v1/vocabularies/{name}). */
const service = (deps: Parameters<ToolDefinition['run']>[0]) =>
  createVocabularyService({ authorize: deps.authorize, recording: deps.recording });

export const VOCABULARY_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'vocabularies_list',
    operationId: 'vocabularies.list',
    description:
      'Every registered state vocabulary (attendance, appointment, claim, message, work item and the others): each code with its short code, plain label, semantic category and whether it is terminal, plus the owning registry version.',
    inputSchema: inputSchema({}, []),
    readOnly: true,
    onInvalid: { action: 'vocabularies.list' },
    run: (deps, actor) => service(deps).listVocabularies(actor),
  },
  {
    name: 'vocabularies_get',
    operationId: 'vocabularies.read',
    description:
      'One state vocabulary by name: codes with plain labels, semantic category and terminal flag, and its version.',
    inputSchema: inputSchema({ name: 'VocabularyName' }, ['name']),
    readOnly: true,
    onInvalid: { action: 'vocabularies.read' },
    run: (deps, actor, args) => service(deps).getVocabulary(actor, args.name as string),
  },
];
