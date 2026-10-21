import { ipcMain, type IpcMainInvokeEvent } from "electron";

/** A handler retains its original runtime until drained; old renderer calls never enter a new account. */
export class SessionScope {
  private active = true;
  private readonly channels: string[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(readonly id: string, private readonly trusted: (event: IpcMainInvokeEvent) => boolean) {}

  assertActive = (): void => {
    if (!this.active) throw new Error("로그인 세션이 종료되었습니다.");
  };

  handle: typeof ipcMain.handle = (channel, listener) => {
    this.channels.push(channel);
    ipcMain.handle(channel, (event, sessionId: unknown, ...args: unknown[]) => {
      this.assertActive();
      if (sessionId !== this.id || !this.trusted(event)) throw new Error("로그인이 필요합니다.");
      const task = Promise.resolve().then(() => { this.assertActive(); return listener(event, ...args); }).then((result: unknown) => {
        this.assertActive();
        return result;
      });
      this.pending.add(task);
      void task.finally(() => this.pending.delete(task)).catch(() => undefined);
      return task;
    });
  };

  block(): void { this.active = false; }

  async close(): Promise<void> {
    this.block();
    for (const channel of this.channels) ipcMain.removeHandler(channel);
    await Promise.allSettled([...this.pending]);
  }
}
