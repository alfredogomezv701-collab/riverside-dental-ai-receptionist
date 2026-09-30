/**
 * Hand-rolled type surface for the DAY_SLOT reference binding. `telnyx-edge types`
 * can only type an [[actors]] binding whose class is exported from this function's
 * own main; DaySlotActor lives in `day-slot-actor`, so it comes back untyped.
 * Keep in sync with day-slot-actor/src/day_slot_actor.ts (and the identical copy in
 * receptionist-mcp/src/actors/day_slot_binding.ts).
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
  holdSlot(start: string, callerId: string, holdDurationMs?: number): Promise<DaySlotHoldResult>;
  confirmSlot(start: string, callerId: string): Promise<DaySlotConfirmResult>;
  releaseSlot(start: string, callerId: string): Promise<DaySlotReleaseResult>;
}
export interface DaySlotNamespace {
  idFromName(name: string): DaySlotStub;
}
