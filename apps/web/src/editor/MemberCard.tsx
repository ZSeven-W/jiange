import { Copy, Mail } from "lucide-react";
import { Avatar } from "@/components/brand";
import { colorFor } from "@/lib/presence";

export interface MemberInfo { id: number; name: string; email?: string; role?: string }

/** 飞书 @成员 悬停名片：头像、姓名、邮箱、角色与操作。成员已不在文档时只显示提及名称。 */
export function MemberCard({ member, fallbackName, x, y, isMe, onCopyEmail, onEnter, onLeave }: {
  member?: MemberInfo; fallbackName: string; x: number; y: number; isMe?: boolean;
  onCopyEmail?: (email: string) => void; onEnter?: () => void; onLeave?: () => void;
}) {
  const name = member?.name ?? fallbackName;
  return <div contentEditable={false} className="absolute z-30 w-[280px] select-none overflow-hidden rounded-xl border bg-surface text-[13px] shadow-[0_8px_24px_rgba(31,35,41,0.16)]" style={{ left: x, top: y }} onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(e) => e.preventDefault()} data-member-card={member?.id ?? ""}>
    <div className="h-12 bg-gradient-to-r from-[#E1EAFF] to-[#F0E9FF] dark:from-[#1f2a44] dark:to-[#2a2444]" />
    <div className="-mt-6 px-4 pb-3">
      <Avatar name={name} color={colorFor((member?.id ?? 1) - 1)} size={48} ring />
      <div className="mt-2 flex items-center gap-1.5">
        <span className="truncate text-[16px] font-semibold text-foreground">{name}</span>
        {isMe && <span className="rounded bg-hover px-1 text-[11px] text-subtle">我</span>}
        {member?.role && <span className="ml-auto shrink-0 rounded bg-[#E1EAFF] px-1.5 py-px text-[11px] text-primary" data-member-role>{member.role}</span>}
      </div>
      {member?.email ? <div className="mt-0.5 truncate text-subtle" data-member-email>{member.email}</div> : <div className="mt-0.5 text-subtle">{member ? "邮箱未公开" : "暂无成员信息"}</div>}
      {member?.email && <div className="mt-3 flex gap-2">
        <a href={`mailto:${member.email}`} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary text-[13px] text-white hover:bg-primary/90" data-member-mail><Mail size={14} />发邮件</a>
        {onCopyEmail && <button type="button" onClick={() => onCopyEmail(member.email!)} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[13px] hover:bg-hover" data-member-copy><Copy size={14} />复制邮箱</button>}
      </div>}
    </div>
  </div>;
}
