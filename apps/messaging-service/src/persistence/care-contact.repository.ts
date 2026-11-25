import { Injectable } from '@nestjs/common';
import { DomainError } from '../domain/domain-error';
import { DatabaseSession } from './database-session';

@Injectable()
export class CareContactRepository {
  constructor(private readonly db: DatabaseSession) {}

  async listCareContacts(actorId: string, requestId?: string) {
    return this.db.asActor(actorId, 'careContacts', requestId, async (client) => {
      const profile = await client.query<{ role: string }>(
        'SELECT role FROM public.profiles WHERE id=$1', [actorId],
      );
      const role = profile.rows[0]?.role;
      if (role !== 'patient' && role !== 'doctor') {
        throw new DomainError('FORBIDDEN', 'Patient or doctor profile required');
      }
      const result = role === 'patient'
        ? await client.query<{ user_id: string; full_name: string }>(
          `SELECT p.doctor_id AS user_id, d.full_name
           FROM public.patients p
           JOIN public.profiles d ON d.id=p.doctor_id
           WHERE p.user_id=$1 LIMIT 1`, [actorId],
        )
        : await client.query<{ user_id: string; full_name: string }>(
          `SELECT p.user_id, patient.full_name
           FROM public.patients p
           JOIN public.profiles patient ON patient.id=p.user_id
           WHERE p.doctor_id=$1
           ORDER BY patient.full_name,p.id LIMIT 100`, [actorId],
        );
      return { role, contacts: result.rows.map((row) => ({ userId: row.user_id, fullName: row.full_name })) };
    });
  }

}
