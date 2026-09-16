import { and, eq, sql, type SQL } from 'drizzle-orm'
import { db } from '../db/client.js'
import { roles, userRoles, users } from '../db/schema.js'

export type SystemAdminExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export function enabledSystemAdminCondition(userId: string | SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ${users} system_admin_actor
    WHERE system_admin_actor.id=${userId}
      AND system_admin_actor.status='启用'
      AND (
        system_admin_actor.role='系统管理员'
        OR EXISTS (
          SELECT 1 FROM ${userRoles} system_admin_user_role
          JOIN ${roles} system_admin_role ON system_admin_role.id=system_admin_user_role.role_id
          WHERE system_admin_user_role.user_id=system_admin_actor.id
            AND system_admin_role.status='启用'
            AND system_admin_role.fde_category='system_admin'
        )
      )
  )`
}

export async function isEnabledSystemAdmin(executor: SystemAdminExecutor, userId: string): Promise<boolean> {
  const [actor] = await executor.select({ id: users.id }).from(users)
    .where(and(eq(users.id, userId), enabledSystemAdminCondition(userId))).limit(1)
  return Boolean(actor)
}
