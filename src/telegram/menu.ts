import { Keyboard } from "grammy";

export const Menu = {
  list: "VPS列表",
  add: "添加VPS",
  enter: "进入VPS",
  edit: "编辑VPS",
  remove: "删除VPS",
  status: "探测状态",
  who: "当前会话",
  track: "跟踪对话",
  leave: "离开VPS",
  stop: "停止对话",
  talk: "开始对话",
  reset: "重置对话",
  code: "代码仓库",
  addRepo: "添加仓库",
  help: "帮助",
} as const;

const LABELS = new Set<string>(Object.values(Menu));

export function isMenuLabel(text: string): boolean {
  return LABELS.has(text);
}

export function mainKeyboard(): Keyboard {
  return new Keyboard()
    .text(Menu.list)
    .text(Menu.add)
    .row()
    .text(Menu.enter)
    .text(Menu.edit)
    .row()
    .text(Menu.remove)
    .text(Menu.status)
    .row()
    .text(Menu.who)
    .text(Menu.track)
    .row()
    .text(Menu.leave)
    .row()
    .text(Menu.stop)
    .text(Menu.talk)
    .row()
    .text(Menu.reset)
    .row()
    .text(Menu.code)
    .text(Menu.addRepo)
    .row()
    .text(Menu.help)
    .resized()
    .persistent();
}

export function menuReply() {
  return { reply_markup: mainKeyboard() };
}
