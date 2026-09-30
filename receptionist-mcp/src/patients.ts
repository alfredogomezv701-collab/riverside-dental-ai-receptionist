import type { KvNamespace } from '@telnyx/edge-runtime';

/**
 * The record at patient/{phone10}. receptionist-webhook answers "who is calling and what do they have
 * booked" from this ONE record (KV reads are ~0.5s each and that lookup blocks the start of every
 * conversation), so the appointments are denormalised into it. Every write that changes a patient's
 * appointments must go through here to keep it in step.
 *
 * Concurrency: read-modify-write on one key is NOT atomic. Two writers for the SAME phone within
 * roughly one KV round trip can lose an update. Acceptable for a phone line (one caller, one
 * conversation); the per-slot race the challenge cares about is handled by DaySlotActor.
 */

export interface PatientAppointment {
  appointmentId: string;
  service: string;
  date: string;
  start: string;
}

export interface PatientRecord {
  patientName: string;
  appointments: PatientAppointment[];
}

/** Keyed on the last 10 digits so "+15551234567" (caller ID) and "555-123-4567" (spoken) match. */
export const digitsOf = (phone: string) => phone.replace(/\D/g, '');
export const isDialablePhone = (phone: string) => digitsOf(phone).length >= 10;
export const PATIENT_KEY = (phone: string) => `patient/${digitsOf(phone).slice(-10)}`;

export const describeAppointment = (a: { service: string; date: string; start: string }) =>
  `${a.service} on ${a.date} at ${a.start}`;

interface LegacyRecord {
  patientName: string;
  appointmentId?: string;
  nextAppointment?: string;
}

/**
 * Reads the record, upgrading the two older shapes ({patientName, appointmentId} and the same plus
 * a summary string) by resolving the appointment they point at.
 */
export async function readPatient(
  kv: KvNamespace,
  phone: string,
  appointmentKey: (id: string) => string,
): Promise<PatientRecord | null> {
  const raw = await kv.get<Partial<PatientRecord> & LegacyRecord>(PATIENT_KEY(phone), { type: 'json' });
  if (!raw) return null;
  if (Array.isArray(raw.appointments)) return { patientName: raw.patientName, appointments: raw.appointments };
  const appointments: PatientAppointment[] = [];
  if (raw.appointmentId) {
    const a = await kv.get<PatientAppointment>(appointmentKey(raw.appointmentId), { type: 'json' });
    if (a) appointments.push({ appointmentId: raw.appointmentId, service: a.service, date: a.date, start: a.start });
  }
  return { patientName: raw.patientName, appointments };
}

export const sortAppointments = (list: PatientAppointment[]) =>
  [...list].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));

export async function writePatient(kv: KvNamespace, phone: string, record: PatientRecord): Promise<void> {
  if (record.appointments.length === 0) {
    await kv.delete(PATIENT_KEY(phone)); // nothing left to remember about this caller
    return;
  }
  await kv.put(PATIENT_KEY(phone), JSON.stringify({ ...record, appointments: sortAppointments(record.appointments) }));
}

export const withAppointment = (record: PatientRecord | null, name: string, appt: PatientAppointment): PatientRecord => ({
  patientName: name || record?.patientName || '',
  appointments: [...(record?.appointments ?? []).filter((a) => a.appointmentId !== appt.appointmentId), appt],
});

export const withoutAppointment = (record: PatientRecord | null, appointmentId: string): PatientRecord | null =>
  record ? { ...record, appointments: record.appointments.filter((a) => a.appointmentId !== appointmentId) } : null;

export const withMovedAppointment = (record: PatientRecord | null, appt: PatientAppointment): PatientRecord | null =>
  record && record.appointments.some((a) => a.appointmentId === appt.appointmentId)
    ? { ...record, appointments: record.appointments.map((a) => (a.appointmentId === appt.appointmentId ? appt : a)) }
    : record;
