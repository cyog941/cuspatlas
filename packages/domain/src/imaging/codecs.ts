import type { ReplayCodec } from '../commands/execute-once';
import { flatCodec } from '../scheduling/ext-codecs';

/**
 * Imaging commands replayed through the flat projection: every command result holds server
 * references, enumerations, instants, digests, counts and flags only, never caller text (filenames,
 * labels and provenance text stay in the imaging tables). Each imaging task appends its commands.
 */
export const IMAGING_OPERATIONS: readonly string[] = [
  'imaging.objects.revokeGrant',
  'imaging.storage.reconcile',
];

export const IMAGING_REPLAY_CODECS: Readonly<Record<string, ReplayCodec<unknown>>> = Object.fromEntries(
  IMAGING_OPERATIONS.map((op) => [op, flatCodec as ReplayCodec<unknown>]),
);
