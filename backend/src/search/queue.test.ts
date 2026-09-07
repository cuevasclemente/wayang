import test from "node:test";
import assert from "node:assert/strict";
import { SearchQueue } from "./queue.js";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("single flight, pending coalescing, bounded admission and exact recovery keys", async () => {
  const q = new SearchQueue<string>({capacity:2,cooldownMs:0});
  let release!: () => void;
  let active = 0; let peak = 0;
  const first = q.enqueue("session:ordinary","manual",async () => {
    active++; peak = Math.max(peak,active);
    await new Promise<void>((r) => { release=r; }); active--; return "first";
  });
  await turn();
  const second = q.enqueue("session:ordinary","manual",async () => "stale pending closure");
  const coalesced = q.enqueue("session:ordinary","manual",async () => { active++; peak=Math.max(peak,active); active--; return "fresh"; });
  assert.equal(second,coalesced);
  const recovery = q.enqueue("session:marker-exact","mutation",async () => "recovered");
  await assert.rejects(q.enqueue("overflow","manual",async () => "no"),/capacity/);
  let recovered = false; void recovery.then(() => {recovered=true;});
  assert.equal(recovered,false,"enqueue is not recovery completion");
  release();
  assert.equal(await first,"first");
  assert.equal(await recovery,"recovered");
  assert.equal(await second,"fresh");
  assert.equal(peak,1);
  await q.stop();
});

test("cancellation rejects pending predecessors without affecting a later recovery key", async () => {
  const q = new SearchQueue<string>({cooldownMs:0});
  let release!: () => void;
  const running = q.enqueue("s:old","manual",async (signal) => {
    await new Promise<void>((resolve) => {release=resolve;});
    return signal.aborted ? "cancelled" : "old";
  });
  await turn();
  const pending = q.enqueue("s:pending","manual",async () => "must not run");
  const rejected = assert.rejects(pending,/invalidated/);
  q.cancelWhere((key)=>key.startsWith("s:"));
  const recovery = q.enqueue("s:exact-new-marker","mutation",async()=>"new");
  release();
  assert.equal(await running,"cancelled");await rejected;
  assert.equal(await recovery,"new");await q.stop();
});

test("aged background work bypasses continuously refreshed cooldown", async () => {
  const q = new SearchQueue<string>({cooldownMs:60_000,agingMs:5});
  await q.enqueue("manual","manual",async()=>"manual");
  const historical = q.enqueue("historical","background",async()=>"historical");
  assert.equal(await historical,"historical");
  await q.stop();
});

test("recovery can displace lower-priority bounded pending admission", async () => {
  const q = new SearchQueue<string>({capacity:1,cooldownMs:0});
  let release!: () => void;
  const active = q.enqueue("active","manual",async()=>{await new Promise<void>((r)=>{release=r;});return "active";});
  await turn();
  const background=q.enqueue("background","background",async()=>"never");
  const deferred=assert.rejects(background,/higher priority/);
  const recovery=q.enqueue("marker","mutation",async()=>"recovered");
  release();await active;await deferred;assert.equal(await recovery,"recovered");await q.stop();
});

test("successors wait through completion acknowledgement microtasks, including reentrant enqueue", async () => {
  const q=new SearchQueue<string>({cooldownMs:0});
  const order:string[]=[];
  let release!:()=>void;
  const first=q.enqueue("recovery","mutation",async()=>{await new Promise<void>((r)=>{release=r;});return "published";});
  await turn();
  const ordinary=q.enqueue("ordinary","manual",async()=>{order.push("ordinary");return "ordinary";});
  let reentrant!:Promise<string>;
  const acknowledged=first.then(async()=>{
    await Promise.resolve();
    reentrant=q.enqueue("reentrant","manual",async()=>{order.push("reentrant");return "reentrant";});
    await Promise.resolve();
    order.push("acknowledged");
  });
  release();await acknowledged;
  assert.deepEqual(order,["acknowledged"]);
  await Promise.all([ordinary,reentrant]);
  assert.equal(order[0],"acknowledged");await q.stop();
});

test("stop cancels running work, rejects pending admission and drains", async () => {
  const q = new SearchQueue<string>();
  const running = q.enqueue("active","manual",async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort",() => resolve(),{once:true}));
    return "cancelled";
  });
  await turn();
  const pending = q.enqueue("pending","background",async () => "never");
  const rejected = assert.rejects(pending,/stopped/);
  await q.stop();
  await rejected;
  assert.equal(await running,"cancelled");
  await assert.rejects(q.enqueue("late","manual",async () => "never"),/stopped/);
});

test("priority and background cooldown do not delay exact manual recovery", async () => {
  const q = new SearchQueue<string>({cooldownMs:60_000});
  await q.enqueue("one","manual",async () => "one");
  await turn();
  const background = q.enqueue("historical","background",async () => "later");
  const rejected = assert.rejects(background,/stopped/);
  assert.equal(await q.enqueue("marker","mutation",async () => "now"),"now");
  await q.stop(); await rejected;
});
