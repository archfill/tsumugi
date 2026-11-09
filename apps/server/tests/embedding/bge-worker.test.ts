import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  createBgeEmbedder,
  type EmbedWorkerHandle,
} from "../../src/external/embedding/bge.js";

class FakeWorker extends EventEmitter {
  posted: { id: number; texts: string[] }[] = [];
  refCount = 0;
  unrefCount = 0;
  terminated = false;
  postMessage(msg: { id: number; texts: string[] }): void {
    this.posted.push(msg);
  }
  ref(): void {
    this.refCount++;
  }
  unref(): void {
    this.unrefCount++;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
  reply(id: number, vectors: Float32Array[]): void {
    this.emit("message", { id, ok: true, vectors });
  }
  fail(id: number, error: string): void {
    this.emit("message", { id, ok: false, error });
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const embedder = createBgeEmbedder({ cacheDir: "/tmp/unused" }, () => {
    const w = new FakeWorker();
    workers.push(w);
    return w as unknown as EmbedWorkerHandle;
  });
  return { workers, embedder };
}

const vec = (n: number): Float32Array => new Float32Array(1024).fill(n);

describe("createBgeEmbedder (worker)", () => {
  it("routes concurrent responses to the right caller by id", async () => {
    const { workers, embedder } = setup();
    const a = embedder.embed("a");
    const b = embedder.embed("b");
    const c = embedder.embedMany(["c1", "c2"]);
    const w = workers[0]!;
    expect(workers).toHaveLength(1);
    expect(w.posted.map((p) => p.texts)).toEqual([["a"], ["b"], ["c1", "c2"]]);
    // reply out of order
    w.reply(w.posted[2]!.id, [vec(3), vec(4)]);
    w.reply(w.posted[1]!.id, [vec(2)]);
    w.reply(w.posted[0]!.id, [vec(1)]);
    expect((await a)[0]).toBe(1);
    expect((await b)[0]).toBe(2);
    const many = await c;
    expect(many.map((v) => v[0])).toEqual([3, 4]);
    expect(w.unrefCount).toBeGreaterThan(0);
  });

  it("does not create a worker for embedMany([])", async () => {
    const { workers, embedder } = setup();
    await expect(embedder.embedMany([])).resolves.toEqual([]);
    expect(workers).toHaveLength(0);
  });

  it("rejects only the failing request when the worker returns ok:false", async () => {
    const { workers, embedder } = setup();
    const a = embedder.embed("a");
    const b = embedder.embed("b");
    const w = workers[0]!;
    w.fail(w.posted[0]!.id, "boom");
    w.reply(w.posted[1]!.id, [vec(2)]);
    await expect(a).rejects.toThrow(/boom/);
    expect((await b)[0]).toBe(2);
    expect(workers).toHaveLength(1);
  });

  it("rejects all pending on exit and recreates the worker on next call", async () => {
    const { workers, embedder } = setup();
    const a = embedder.embed("a");
    const b = embedder.embedMany(["b"]);
    workers[0]!.emit("exit", 1);
    await expect(a).rejects.toThrow(/exited/);
    await expect(b).rejects.toThrow(/exited/);
    expect(workers[0]!.terminated).toBe(true);

    const c = embedder.embed("c");
    expect(workers).toHaveLength(2);
    const w2 = workers[1]!;
    w2.reply(w2.posted[0]!.id, [vec(9)]);
    expect((await c)[0]).toBe(9);
  });

  it("rejects pending on worker error", async () => {
    const { workers, embedder } = setup();
    const a = embedder.embed("a");
    workers[0]!.emit("error", new Error("oom"));
    await expect(a).rejects.toThrow(/oom/);
  });
});
