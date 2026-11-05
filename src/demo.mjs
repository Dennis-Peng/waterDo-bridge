import { BridgeError } from './core.mjs';
// Synthetic fixtures only. This module never connects to WaterDo.
const tasks = [
  { id: 101, title: '[演示] 提交项目材料', memo: '合成数据，不是你的日程', task_due_at: '2026-11-06T07:00:00.000Z', task_done_at: null, tag_id: 1, is_deleted: false, is_remind_enabled: false, repeating_pattern: 0 },
  { id: 102, title: '[演示] 无日期待办', memo: '', task_due_at: null, task_done_at: null, tag_id: null, is_deleted: false, is_remind_enabled: false, repeating_pattern: 0 },
  { id: 103, title: '[演示] 周期任务原始记录', memo: '未展开未来实例', task_due_at: '2026-11-07T01:00:00.000Z', task_done_at: null, tag_id: 1, is_deleted: false, is_remind_enabled: true, repeating_pattern: 67108865 },
  { id: 104, title: '[演示] 已完成', memo: '', task_due_at: null, task_done_at: '2026-11-04T01:00:00.000Z', tag_id: null, is_deleted: false, is_remind_enabled: false, repeating_pattern: 0 },
];
export class DemoAdapter {
  #items = structuredClone(tasks); #nextId = 1000;
  #tags = [{ id: 1, name: '[演示] 工作', color_id: 4, is_deleted: false }];
  async tasks() { return structuredClone(this.#items); }
  async getTasks() { return this.tasks(); }
  async getTask(id) { return this.task(id); }
  async createTask(task) {
    const item = { ...structuredClone(task), id: this.#nextId++ }; this.#items.push(item); return structuredClone(item);
  }
  async updateTask(id, task) {
    await this.task(id); const item = structuredClone(task);
    this.#items = this.#items.map(t => String(t.id) === id ? item : t); return structuredClone(item);
  }
  async deleteTask(id) {
    const item = await this.task(id); item.is_deleted = true;
    this.#items = this.#items.map(t => String(t.id) === id ? item : t); return { deleted: true };
  }
  async task(id) {
    const item = this.#items.find(t => String(t.id) === id);
    if (!item) throw new BridgeError('NOT_FOUND', '演示任务不存在。', 404);
    return structuredClone(item);
  }
  async tags() { return structuredClone(this.#tags); }
  async getTags() { return this.tags(); }
  async getTag(id) {
    const tag = this.#tags.find(t => String(t.id) === id);
    if (!tag) throw new BridgeError('NOT_FOUND', '演示标签不存在。', 404);
    return structuredClone(tag);
  }
  async updateTag(id, tag) {
    await this.getTag(id); this.#tags = this.#tags.map(t => String(t.id) === id ? structuredClone(tag) : t);
    return structuredClone(tag);
  }
}
