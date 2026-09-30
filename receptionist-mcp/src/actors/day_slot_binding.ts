/**
 * Hand-rolled type surface for the DAY_SLOT actor binding.
 *
 * `telnyx-edge types` can only narrow an [[actors]] binding to typed methods
 * when the actor class is exported from THIS function's own `main` (see the
 * generated `telnyx-env.d.ts` — DAY_SLOT comes back as a bare, untyped
 * ActorNamespace here because DaySlotActor actually lives in the separate
 * `day-slot-actor` function). This is the manual narrowing the CLI's own
 * `types` output recommends for a reference-only binding.
 *
 * MUST be kept in sync with `day-slot-actor/src/day_slot_actor.ts`'s public
 * method signatures — there is no shared package between the two projects.
 * `test/day_slot_integration.test.ts` guards against drift by importing the
 * real DaySlotActor class and exercising it through this same contract.
 */

export interface DaySlotHoldResult {
  success: boolean;
  holdExpiresAt?: number;
  reason?: 'already_booked' | 'already_held_by_other';
}

export interface DaySlotConfirmResult {
  success: boolean;
  reason?: 'not_held' | 'held_by_other' | 'hold_expired';
}

export interface DaySlotReleaseResult {
  success: boolean;
  reason?: 'not_held_by_caller';
}

export interface DaySlotStub {
  readonly id: string;
  holdSlot(start: string, callerId: string, holdDurationMs?: number): Promise<DaySlotHoldResult>;
  confirmSlot(start: string, callerId: string): Promise<DaySlotConfirmResult>;
  releaseSlot(start: string, callerId: string): Promise<DaySlotReleaseResult>;
}

export interface DaySlotNamespace {
  idFromName(name: string): DaySlotStub;
}
