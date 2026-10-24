/**
 * Périmètre d'accès : un enseignant ne voit que ses classes ;
 * la direction (ADMIN, DIRECTOR, BURSAR) voit toutes les classes de son école.
 */
export async function accessibleClassIds(prisma, user) {
  const where =
    user.role === 'TEACHER' ? { schoolId: user.schoolId, teacherId: user.id } : { schoolId: user.schoolId };
  const classes = await prisma.class.findMany({ where, select: { id: true } });
  return new Set(classes.map((c) => c.id));
}
