/**
 * Turns Supabase/Postgres errors into messages a factory user can act on.
 *
 * The important cases:
 *  - 42501 / RLS: the DB refused the write. Either the role isn't permitted or
 *    the factory's module is off. Never show a raw policy error.
 *  - 23505 unique_violation: duplicate name within the factory.
 *  - 23503 foreign_key_violation: the row is referenced elsewhere — this is the
 *    "fails gracefully rather than orphaning data" path.
 */
export function describeDbError(e: any, entityLabel = 'record'): string {
  const code = e?.code as string | undefined;
  const msg = (e?.message as string | undefined) ?? '';

  if (code === '23505' || /duplicate key|already exists/i.test(msg)) {
    return `A ${entityLabel.toLowerCase()} with that name already exists in this factory.`;
  }

  if (code === '23503' || /foreign key/i.test(msg)) {
    return `This ${entityLabel.toLowerCase()} is referenced by other records, so it can't be removed. Archive it instead.`;
  }

  if (code === '23514' || /check constraint/i.test(msg)) {
    return 'One of the values isn\'t allowed. Please review the fields.';
  }

  // 23502 not_null_violation. Client-side validation should catch this first;
  // this is the backstop so a raw Postgres string never reaches a user.
  if (code === '23502' || /not-null constraint|null value in column/i.test(msg)) {
    const col = /column "([^"]+)"/.exec(msg)?.[1];
    return col
      ? `${col.replace(/_/g, ' ')} is required.`
      : 'A required field is missing. Please review the fields.';
  }

  // RLS refusal — role not permitted, or the module is disabled for this factory.
  if (
    code === '42501' ||
    /row-level security|violates row-level/i.test(msg) ||
    /permission denied/i.test(msg)
  ) {
    return "You don't have permission to make this change, or this feature isn't available for your factory.";
  }

  // Not found. Cross-tenant access resolves here too, deliberately: the DB
  // returns the same answer for "doesn't exist" and "isn't yours" so probing
  // ids can't reveal another factory's data.
  if (code === 'PGRST116' || /not found/i.test(msg)) {
    return msg || 'That record could not be found.';
  }

  if (/network|fetch failed|failed to fetch/i.test(msg)) {
    return 'Network error — check your connection and try again.';
  }

  return msg || 'Something went wrong. Please try again.';
}

/**
 * A read that returns nothing because a module is disabled looks identical to an
 * empty table over PostgREST. The caller knows which it is from the config, so
 * this just supplies the wording (Phase 1 DoD: never a crash or raw error).
 */
export const MODULE_DISABLED_MESSAGE =
  "This feature isn't available for your factory.";
