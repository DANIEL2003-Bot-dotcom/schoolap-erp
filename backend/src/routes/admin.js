import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { parseOrThrow } from '../utils/httpError.js';
import { can } from '../services/roles.js';

const idParam = z.object({ id: z.uuid({ error: 'Identifiant invalide.' }) });
const id = (req) => parseOrThrow(idParam, req.params).id;

/**
 * Gestion administrative (/api/admin/…) — permissions de la structure EPST (services/roles.js)
 *  - VIEW_SCHOOL     : consultation (Préfet, Directeur, D.E., D.D., Comptable, Admin)
 *  - VIEW_ACADEMIC   : présences, résultats et personnel dans les fiches (tous sauf le Comptable)
 *  - MANAGE_STAFF    : comptes du personnel (Admin, Préfet, Directeur)
 *  - MANAGE_ACADEMIC : classes et matières (+ D.E.)
 *  - MANAGE_STUDENTS : inscriptions et import (+ D.E., Comptable)
 *  - MANAGE_FEES     : création et modification des frais, remises (Admin, Préfet, Directeur — pas le Comptable)
 */
export function adminRouter({ prisma, config, adminService, performanceService }) {
  const router = Router();
  const staff = requirePermission('MANAGE_STAFF');
  const academic = requirePermission('MANAGE_ACADEMIC');
  const students = requirePermission('MANAGE_STUDENTS');
  const fees = requirePermission('MANAGE_FEES');
  router.use(requireAuth({ prisma, config }), requirePermission('VIEW_SCHOOL'));

  router.get('/overview', async (req, res) => res.json({ success: true, ...(await adminService.overview(req.user)) }));

  router.post('/classes', academic, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createClass(req.user, req.body)) }));
  router.patch('/classes/:id', academic, async (req, res) => res.json({ success: true, ...(await adminService.updateClass(req.user, id(req), req.body)) }));
  router.delete('/classes/:id', academic, async (req, res) => res.json({ success: true, ...(await adminService.deleteClass(req.user, id(req))) }));

  router.post('/users', staff, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createUser(req.user, req.body)) }));
  router.patch('/users/:id', staff, async (req, res) => res.json({ success: true, ...(await adminService.updateUser(req.user, id(req), req.body)) }));

  router.post('/subjects', academic, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createSubject(req.user, req.body)) }));
  router.patch('/subjects/:id', academic, async (req, res) => res.json({ success: true, ...(await adminService.updateSubject(req.user, id(req), req.body)) }));

  router.get('/students', async (req, res) => res.json({ success: true, ...(await adminService.listStudents(req.user, req.query)) }));
  router.post('/students/import', students, async (req, res) => {
    const result = await adminService.importStudents(req.user, req.body);
    res.status(result.dryRun ? 200 : 201).json({ success: true, ...result });
  });
  router.get('/students/:id', async (req, res) => {
    const detail = await adminService.getStudent(req.user, id(req));
    // La comptabilité ne voit que l'identité, les frais et les paiements de l'élève.
    const performance = can(req.user.role, 'VIEW_ACADEMIC') ? await performanceService.studentPerformance(detail.student.id) : null;
    res.json({ success: true, ...detail, performance });
  });
  router.post('/students', students, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createStudent(req.user, req.body)) }));
  router.patch('/students/:id', students, async (req, res) => res.json({ success: true, ...(await adminService.updateStudent(req.user, id(req), req.body)) }));

  router.get('/fees/summary', async (req, res) => res.json({ success: true, ...(await adminService.feeSummary(req.user)) }));
  router.post('/fees/bulk', fees, async (req, res) => res.status(201).json({ success: true, ...(await adminService.bulkCreateFees(req.user, req.body)) }));
  router.patch('/fees/:id', fees, async (req, res) => res.json({ success: true, ...(await adminService.updateFee(req.user, id(req), req.body)) }));

  return router;
}
