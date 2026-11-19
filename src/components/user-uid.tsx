import { formatUserUid } from "@/lib/user-uid";

/** 用户数字编号小标签（#12），后台各列表和个人设置共用 */
export function UserUid({ uid }: { uid?: number | null }) {
  return uid ? (
    <span className="mr-1.5 font-mono text-[11px] font-medium text-[var(--ink-soft)]">
      {formatUserUid(uid)}
    </span>
  ) : null;
}
