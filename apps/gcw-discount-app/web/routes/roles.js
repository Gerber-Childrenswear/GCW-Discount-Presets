import { Router } from 'express';
import { ROLES, userRoles, hasPermission, requireAdmin } from '../rbac.js';

const router = Router();

router.get('/api/roles/me', (req, res) => {
  res.json({
    email: req.userEmail || null,
    role: req.userRole,
    roleInfo: ROLES[req.userRole],
    permissions: {
      canView:       true,
      canCreate:     hasPermission(req.userRole, 2),
      canEditDraft:  hasPermission(req.userRole, 2),
      canActivate:   hasPermission(req.userRole, 3),
      canEditLive:   hasPermission(req.userRole, 3),
      canManageUsers: hasPermission(req.userRole, 3),
    },
  });
});

router.get('/api/roles/users', requireAdmin, (req, res) => {
  const users = Object.entries(userRoles).map(([email, role]) => ({
    email, role, roleInfo: ROLES[role],
  }));
  res.json({ success: true, users, availableRoles: ROLES });
});

export default router;
