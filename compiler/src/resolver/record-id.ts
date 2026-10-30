import { ResolverError } from './types.js';

/**
 * Reject a record id the registry will not store.
 *
 * The `&` sigil is SpeckDL syntax for an external reference. It is not part
 * of the id. Whitespace is rejected so a key cannot be split across a line.
 */
export function assertRecordId(id: string, where: string): void {
  if (id.trim() === '') {
    throw new ResolverError(`${where}: record id must be a non-empty string`, {
      code: 'malformed',
    });
  }
  if (id.startsWith('&')) {
    throw new ResolverError(
      `${where}: record id "${id}" includes the & sigil; store the id without it`,
      { code: 'malformed', recordId: id },
    );
  }
  if (/\s/.test(id)) {
    throw new ResolverError(
      `${where}: record id "${id}" must not contain whitespace`,
      { code: 'malformed', recordId: id },
    );
  }
}
