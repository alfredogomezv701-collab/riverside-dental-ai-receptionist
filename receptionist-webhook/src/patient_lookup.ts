import type { KvNamespace } from '@telnyx/edge-runtime';

const CLINIC_TZ = 'America/Chicago';
export const digitsOf = (phone: string) => phone.replace(/\D/g, '');
/** A number we can look a person up by. Anonymous / blocked caller IDs and junk must never reach the key space. */
export const isDialablePhone = (phone: string) => digitsOf(phone).length >= 10;
// Keep PATIENT_KEY in sync with receptionist-mcp/src/patients.ts.
export const PATIENT_KEY = (phone: string) => `patient/${digitsOf(phone).slice(-10)}`;
export const APPOINTMENT_KEY = (id: string) => `appointment/${id}`;
export const WAITLIST_FLAG_KEY = 'flag/waitlist_mode';

export interface PatientVariables {
  is_returning_patient: 'true' | 'false';
  patient_name: string;
  next_appointment: string;
  next_appointment_id: string;
  appointment_count: string;
  waitlist_mode: 'true' | 'false';
}

interface PatientAppointment {
  appointmentId: string;
  service: string;
  date: string;
  start: string;
}

/**
 * What receptionist-mcp keeps at patient/{phone10}. `appointments` is the current shape; the two older
 * shapes ({patientName, appointmentId} and the same plus `nextAppointment`) are still understood.
 */
interface StoredPatient {
  patientName: string;
  appointments?: PatientAppointment[];
  appointmentId?: string;
  nextAppointment?: string;
}

interface AppointmentRecord {
  service: string;
  date: string;
  start: string;
}

const NONE = {
  is_returning_patient: 'false',
  patient_name: '',
  next_appointment: '',
  next_appointment_id: '',
  appointment_count: '0',
} as const;

/** Today's date (YYYY-MM-DD) at the clinic, not in UTC. */
export function todayAtClinic(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const describe = (a: { service: string; date: string; start: string }) => `${a.service} on ${a.date} at ${a.start}`;

// The flag is read on every call; a few seconds of per-isolate memory keeps a busy period from
// paying a KV round trip each time while still letting an operator flip it without a redeploy.
const FLAG_TTL_MS = 5000;
let flagCache: { value: boolean; at: number } | undefined;
export function resetFlagCache(): void {
  flagCache = undefined;
}

async function readWaitlistFlag(kv: KvNamespace, now: number): Promise<boolean> {
  if (flagCache && now - flagCache.at < FLAG_TTL_MS) return flagCache.value;
  const value = (await kv.get(WAITLIST_FLAG_KEY)) === 'on';
  flagCache = { value, at: now };
  return value;
}

/**
 * Phone -> dynamic variables in ONE KV round trip: the waitlist flag and the patient record are read
 * concurrently, and the record carries every appointment so no second read is needed. (KV reads are
 * REST calls at roughly half a second each; this handler blocks the start of the conversation.)
 * There is deliberately no lookup cache: a cached "unknown caller" went stale the moment that caller
 * booked. `next_appointment` is the soonest appointment that hasn't passed (clinic-local date).
 * Dynamic variables are strings, so booleans are "true"/"false".
 */
export async function lookupPatient(
  kv: KvNamespace,
  phone: string | undefined,
  now: number = Date.now(),
): Promise<{ vars: PatientVariables; kvReads: number }> {
  const dialable = phone !== undefined && isDialablePhone(phone);
  const [waitlist, patient] = await Promise.all([
    readWaitlistFlag(kv, now),
    dialable ? kv.get<StoredPatient>(PATIENT_KEY(phone), { type: 'json' }) : Promise.resolve(null),
  ]);
  const waitlist_mode = waitlist ? 'true' : 'false';
  if (!patient) return { vars: { ...NONE, waitlist_mode }, kvReads: 1 };

  let kvReads = 1;
  let upcoming: Array<{ id: string; summary: string }>;
  if (Array.isArray(patient.appointments)) {
    const today = todayAtClinic(new Date(now));
    upcoming = patient.appointments
      .filter((a) => a.date >= today)
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .map((a) => ({ id: a.appointmentId, summary: describe(a) }));
  } else if (patient.nextAppointment !== undefined) {
    upcoming = patient.nextAppointment && patient.appointmentId ? [{ id: patient.appointmentId, summary: patient.nextAppointment }] : [];
  } else if (patient.appointmentId) {
    const appt = await kv.get<AppointmentRecord>(APPOINTMENT_KEY(patient.appointmentId), { type: 'json' });
    kvReads++;
    upcoming = appt ? [{ id: patient.appointmentId, summary: describe(appt) }] : [];
  } else {
    upcoming = [];
  }

  return {
    vars: {
      is_returning_patient: 'true',
      patient_name: patient.patientName,
      next_appointment: upcoming[0]?.summary ?? '',
      next_appointment_id: upcoming[0]?.id ?? '',
      appointment_count: String(upcoming.length),
      waitlist_mode,
    },
    kvReads,
  };
}
