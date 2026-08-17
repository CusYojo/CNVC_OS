// 旧 Flue 数据只能由仓库根目录的离线迁移器按批准路径读取。
// 任何重新导入退休 Runtime 数据库适配器的行为都必须立即失败，不能创建文件或恢复在线写入。
function retiredDatabaseRuntime(): never {
  throw Object.assign(new Error('旧 Assistant 数据库 Runtime 已退场；请使用根目录离线迁移命令'), {
    code: 'RETIRED_ASSISTANT_RUNTIME',
  });
}

export default retiredDatabaseRuntime();
