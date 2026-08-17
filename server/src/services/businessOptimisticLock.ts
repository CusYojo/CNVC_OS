export function businessVersionConflict(entityLabel: string) {
  return Object.assign(new Error(`${entityLabel}已被其他用户修改，请刷新后重试`), {
    status: 409,
    code: 'BUSINESS_VERSION_CONFLICT',
  })
}
