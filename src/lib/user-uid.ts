/** 用户数字编号显示成 #12；后台搜索框输入 #12 或 12 都按编号找人 */
export function formatUserUid(uid: number | null | undefined) {
  return uid ? `#${uid}` : "";
}

export function parseUserUidQuery(query: string) {
  const match = /^#?(\d{1,9})$/.exec(query.trim());
  return match ? Number(match[1]) : null;
}
