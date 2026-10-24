import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { parseOrThrow } from '../utils/httpError.js';

const idParam = z.object({ id: z.uuid({ error: 'Identifiant invalide.' }) });
const id = (req) => parseOrThrow(idParam, req.params).id;

/**
 * Gestion administrative (/api/admin/…)
 *  - Direction (DIRECTOR, ADMIN) : tout
 *  - Économat (BURSAR)           : lecture, élèves (inscriptions) et frais
 */
export function adminRouter({ prisma, config, adminService }) {
  const router = Router();
  const direction = requireRole('DIRECTOR', 'ADMIN');
  const office = requireRole('DIRECTOR', 'ADMIN', 'BURSAR');
  router.use(requireAuth({ prisma, config }), office);

  router.get('/overview', async (req, res) => res.json({ success: true, ...(await adminService.overview(req.user)) }));

  router.post('/classes', direction, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createClass(req.user, req.body)) }));
  router.patch('/classes/:id', direction, async (req, res) => res.json({ success: true, ...(await adminService.updateClass(req.user, id(req), req.body)) }));
  router.delete('/classes/:id', direction, async (req, res) => res.json({ success: true, ...(await adminService.deleteClass(req.user, id(req))) }));

  router.post('/users', direction, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createUser(req.user, req.body)) }));
  router.patch('/users/:id', direction, async (req, res) => res.json({ success: true, ...(await adminService.updateUser(req.user, id(req), req.body)) }));

  router.post('/subjects', direction, async (req, res) => res.status(201).json({ success: true, ...(await adminService.createSubject(req.user, req.body)) }));
  router.patch('/subjects/:id', direction, async (req, res) => res.json({ success: true, ...(await adminService.updateSubject(req.user, id(req), req.body)) }));

  router.get('/students', async (req, res) => res.json({ success: true, ...(await adminService.listStudents(req.user, req.query)) }));
  router.post('/students/import', async (req, res) => {
    const result = await adminService.importStudents(req.user, req.body);
    res.status(result.dryRun ? 200 : 201).json({ success: true, ...result });
  });
  router.get('/students/:id', async (req, res) => res.json({ success: true, ...(await adminService.getStudent(req.user, id(req))) }));
  router.post('/students', async (req, res) => res.status(201).json({ success: true, ...(await adminService.createStudent(req.user, req.body)) }));
  router.patch('/students/:id', async (req, res) => res.json({ success: true, ...(await adminService.updateStudent(req.user, id(req), req.body)) }));

  router.get('/fees/summary', async (req, res) => res.json({ success: true, ...(await adminService.feeSummary(req.user)) }));
  router.post('/fees/bulk', async (req, res) => res.status(201).json({ success: true, ...(await adminService.bulkCreateFees(req.user, req.body)) }));
  router.patch('/fees/:id', async (req, res) => res.json({ success: true, ...(await adminService.updateFee(req.user, id(req), req.body)) }));

  return router;
}
