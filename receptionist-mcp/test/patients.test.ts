import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PATIENT_KEY,
  digitsOf,
  isDialablePhone,
  describeAppointment,
  readPatient,
  writePatient,
  withAppointment,
  withoutAppointment,
  withMovedAppointment,
  sortAppointments,
  type PatientRecord,
} from '../src/patients.js';
import { APPOINTMENT_KEY } from '../src/tools/book_appointment.js';
import { MockKvNamespace } from './mock_kv.js';

const A = { appointmentId: 'a', service: 'cleaning', date: '2027-04-13', start: '10:00' };
const B = { appointmentId: 'b', service: 'exam', date: '2027-04-06', start: '09:00' };

describe('phone handling', () => {
  it('keys every spelling of a number identically, on the last ten digits', () => {
    for (const p of ['+15551234567', '555-123-4567', '(555) 123 4567', '1-555-123-4567']) assert.equal(PATIENT_KEY(p), 'patient/5551234567', p);
  });
  it('knows what is dialable', () => {
    assert.equal(isDialablePhone('+15551234567'), true);
    for (const p of ['unknown', '', '555-1234', '+1', 'anonymous']) assert.equal(isDialablePhone(p), false, p);
  });
  it('digitsOf strips everything but digits', () => assert.equal(digitsOf('+1 (555) 123-4567'), '15551234567'));
  it('describes an appointment the way the assistant reads it out', () => assert.equal(describeAppointment(A), 'cleaning on 2027-04-13 at 10:00'));
});

describe('patient record operations', () => {
  it('adds an appointment, replacing one with the same id, and remembers the name', () => {
    const r1 = withAppointment(null, 'Ada', A);
    assert.deepEqual(r1, { patientName: 'Ada', appointments: [A] });
    const r2 = withAppointment(r1, 'Ada', { ...A, start: '11:00' });
    assert.deepEqual(r2.appointments.map((x) => x.start), ['11:00']);
  });
  it('keeps the stored name when a later booking supplies none', () => {
    assert.equal(withAppointment({ patientName: 'Ada', appointments: [] }, '', A).patientName, 'Ada');
  });
  it('sorts soonest first', () => assert.deepEqual(sortAppointments([A, B]).map((x) => x.appointmentId), ['b', 'a']));
  it('removes only the named appointment', () => {
    assert.deepEqual(withoutAppointment({ patientName: 'Ada', appointments: [A, B] }, 'a')!.appointments, [B]);
    assert.equal(withoutAppointment(null, 'a'), null);
  });
  it('moves only the named appointment, and ignores an id it does not hold', () => {
    const rec = { patientName: 'Ada', appointments: [A, B] };
    assert.equal(withMovedAppointment(rec, { ...A, start: '15:00' })!.appointments.find((x) => x.appointmentId === 'a')!.start, '15:00');
    assert.deepEqual(withMovedAppointment(rec, { ...A, appointmentId: 'zzz' }), rec);
  });
});

describe('persistence', () => {
  it('writes sorted appointments and reads them back', async () => {
    const kv = new MockKvNamespace();
    await writePatient(kv, '+15551234567', { patientName: 'Ada', appointments: [A, B] });
    const rec = await readPatient(kv, '555-123-4567', APPOINTMENT_KEY);
    assert.deepEqual(rec!.appointments.map((x) => x.appointmentId), ['b', 'a']);
  });

  it('deletes the record when the last appointment goes (nothing left to remember)', async () => {
    const kv = new MockKvNamespace();
    await writePatient(kv, '+15551234567', { patientName: 'Ada', appointments: [A] });
    await writePatient(kv, '+15551234567', { patientName: 'Ada', appointments: [] });
    assert.equal(await kv.get(PATIENT_KEY('+15551234567')), null);
  });

  it('upgrades a legacy {patientName, appointmentId} record by resolving the appointment it points at', async () => {
    const kv = new MockKvNamespace();
    await kv.put(PATIENT_KEY('+15551234567'), JSON.stringify({ patientName: 'Ada', appointmentId: 'a' }));
    await kv.put(APPOINTMENT_KEY('a'), JSON.stringify(A));
    const rec = (await readPatient(kv, '+15551234567', APPOINTMENT_KEY)) as PatientRecord;
    assert.deepEqual(rec, { patientName: 'Ada', appointments: [A] });
  });

  it('a legacy record whose appointment is gone reads as a patient with no appointments', async () => {
    const kv = new MockKvNamespace();
    await kv.put(PATIENT_KEY('+15551234567'), JSON.stringify({ patientName: 'Ada', appointmentId: 'gone', nextAppointment: 'x' }));
    assert.deepEqual(await readPatient(kv, '+15551234567', APPOINTMENT_KEY), { patientName: 'Ada', appointments: [] });
  });

  it('returns null for an unknown phone', async () => {
    assert.equal(await readPatient(new MockKvNamespace(), '+15550000000', APPOINTMENT_KEY), null);
  });
});
